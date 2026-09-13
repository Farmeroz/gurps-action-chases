import test from 'node:test';
import assert from 'node:assert/strict';
import { newChase, newParticipant, travelStats, unit, breakdown } from '../scripts/rules.mjs';
import { applyCommand } from '../scripts/engine.mjs';
import {
  upgrade,
  tasks,
  activeGroup,
  taskAccess,
  remainingRequired,
  attackAllowed,
} from '../scripts/workflow.mjs';
const gm = { id: 'gm', isGM: true },
  qUser = { id: 'alice' },
  pUser = { id: 'bob' };
const cmd = (s, type, data = {}, user = gm, options = {}) =>
  applyCommand(s, { type, epoch: s.epoch, revision: s.revision, ...data }, user, options);
function base(kind = 'character') {
  let s = newChase('Workflow');
  s.participants = [
    newParticipant({
      id: 'q',
      name: 'Quarry',
      kind,
      side: 'quarry',
      controllers: ['alice'],
      skill: 14,
      speed: 6,
    }),
    newParticipant({
      id: 'p',
      name: 'Pursuer',
      kind,
      side: 'pursuer',
      controllers: ['bob'],
      skill: 14,
      speed: 6,
    }),
  ];
  s.sides.quarry.leader = 'q';
  s.sides.pursuer.leader = 'p';
  return s;
}
function actions(q = 'move', p = 'move', kind = 'character') {
  let s = cmd(base(kind), 'start');
  s = cmd(s, 'declare', { side: 'quarry', data: { key: q, penalty: -2 } });
  return cmd(s, 'declare', { side: 'pursuer', data: { key: p, penalty: -2 } });
}
function prep(s) {
  for (const t of tasks(s).filter((x) => x.group === 'prepare' && !x.done))
    s = cmd(s, 'task', {
      taskId: t.id,
      mode: 'approve',
      minimumPenalty: -2,
      target: 14,
      canFollow: true,
    });
  return s;
}
const resolve = (s, id, data = {}, user = gm) =>
  cmd(
    s,
    'task',
    { taskId: id, mode: 'manual', stuntSkill: 'acrobatics', target: 12, total: 10, ...data },
    user,
  );
test('simple Move round has no obligatory checklists and takes six commands after setup', () => {
  let s = cmd(base(), 'start'),
    count = 0;
  const go = (type, data = {}, options = {}) => {
    count++;
    s = cmd(s, type, data, gm, options);
  };
  go('declare', { side: 'quarry', data: { key: 'move' } });
  go('declare', { side: 'pursuer', data: { key: 'move' } });
  assert.equal(tasks(s).length, 0);
  go('actionsDone', { confirmed: true });
  go('roll', { side: 'quarry' }, { total: 10 });
  go('roll', { side: 'pursuer' }, { total: 10 });
  go('range', { choice: 'hold' });
  assert.equal(count, 6);
  assert.equal(s.round, 2);
});
test('scene decisions precede pursuer actions; quarry cannot act early', () => {
  let s = actions('stunt', 'moveAttack');
  assert.equal(activeGroup(s), 'prepare');
  assert.throws(() => resolve(s, 'attack:p', { bulk: -2, acc: 0 }, pUser), /scene decisions/);
  s = prep(s);
  assert.equal(activeGroup(s), 'pursuer');
  assert.throws(() => resolve(s, 'stunt:q', {}, qUser), /pursuer actions/);
  s = cmd(s, 'passSide');
  assert.equal(activeGroup(s), 'quarry');
  s = resolve(s, 'stunt:q', {}, qUser);
  assert.equal(remainingRequired(s).length, 0);
});
test('optional passenger actions can be passed in one GM continue operation', () => {
  let s = actions('move', 'move', 'vehicle');
  s.participants.push(newParticipant({ id: 'crew', transportId: 'q', controllers: ['alice'] }));
  assert.equal(tasks(s)[0].required, false);
  s = cmd(s, 'actionsDone', { confirmed: true });
  assert.equal(s.passengerActions.crew.action, 'Pass');
  assert.equal(s.phase, 'chase');
});
test('Hide reveals missing Stealth early and accepts it in a direct task', () => {
  let s = actions('hide');
  assert.ok(tasks(s).some((t) => t.kind === 'skill'));
  s = prep(s);
  assert.equal(breakdown(s, 'quarry').target, 7);
  assert.equal(remainingRequired(s).length, 0);
  s = cmd(s, 'actionsDone', { confirmed: true });
  assert.equal(s.phase, 'chase');
});
test('mobility decision sets forced static without a redundant confirmation', () => {
  let s = actions('mobilityEscape');
  s = cmd(s, 'task', { taskId: 'scene:quarry', mode: 'approve' });
  s = cmd(s, 'task', { taskId: 'mobility:quarry', mode: 'approve', canFollow: false });
  assert.equal(s.sides.pursuer.forcedStatic, true);
  assert.equal(remainingRequired(s).length, 0);
});
test('successful stunt records immediately, grants its bonus and cannot be rolled twice', () => {
  let s = prep(actions('stunt'));
  s = resolve(s, 'stunt:q', {}, qUser);
  assert.equal(s.checks.length, 1);
  assert.equal(breakdown(s, 'quarry').parts.find((x) => x.label === 'Stunt').value, 1);
  assert.throws(() => resolve(s, 'stunt:q', {}, qUser), /Already recorded/);
});
test('failed stunt saves dice with missing SR, then resolves the original result', () => {
  let s = prep(actions('stunt', 'move', 'vehicle'));
  s = resolve(s, 'stunt:q', { target: 12, total: 14 }, qUser);
  assert.equal(s.checks[0].pending, true);
  const t = remainingRequired(s)[0];
  assert.equal(t.kind, 'consequence');
  assert.throws(() => cmd(s, 'actionsDone', { confirmed: true }), /highlighted task/);
  assert.throws(() => resolve(s, t.id, { sr: 3 }, qUser), /GM/);
  s = resolve(s, t.id, { mode: 'approve', sr: 3 });
  assert.equal(s.checks[0].total, 14);
  assert.equal(s.checks[0].pending, false);
  assert.equal(unit(s, 'q').status, 'closeCall');
  assert.equal(unit(s, 'q').dueRound, 2);
  assert.equal(remainingRequired(s).length, 0);
});
test('GM can provide missing SR in the stunt form before rolling', () => {
  let s = prep(actions('stunt', 'move', 'vehicle'));
  s = resolve(s, 'stunt:q', { target: 12, total: 16, sr: 3 });
  assert.equal(unit(s, 'q').status, 'wreck');
  assert.equal(s.checks[0].pending, undefined);
  assert.equal(remainingRequired(s)[0].kind, 'consequence');
});
test('successful attack produces a required GM defence/damage task; missed attack does not', () => {
  let s = actions('moveAttack');
  s = resolve(s, 'attack:q', { target: 20, bulk: -2, acc: 0, total: 8 }, qUser);
  const t = remainingRequired(s)[0];
  assert.equal(t.kind, 'finish');
  assert.throws(() => resolve(s, t.id, { mode: 'approve', note: 'Hit' }, qUser), /GM/);
  assert.throws(() => resolve(s, t.id, { mode: 'approve', note: '' }), /outcome/);
  s = resolve(s, t.id, { mode: 'approve', note: 'Dodge succeeded; no damage.' });
  assert.equal(remainingRequired(s).length, 0);
  s = actions('moveAttack');
  s = resolve(s, 'attack:q', { target: 10, bulk: -2, acc: 0, total: 16 }, qUser);
  assert.equal(remainingRequired(s).length, 0);
});
test('external attacks need an outcome and do not invent dice results', () => {
  let s = actions('moveAttack');
  assert.throws(
    () => resolve(s, 'attack:q', { mode: 'external', note: '' }, qUser),
    /externally resolved/,
  );
  s = resolve(s, 'attack:q', { mode: 'external', note: 'Resolved using GGA.' }, qUser);
  assert.equal(s.workflow.outcomes['attack:q'].result, null);
  assert.equal(remainingRequired(s)[0].kind, 'finish');
});
test('stunt cannot be falsely marked external; a GM ruling needs a stated outcome', () => {
  let s = prep(actions('stunt'));
  assert.throws(
    () => resolve(s, 'stunt:q', { mode: 'external', note: 'Done' }, qUser),
    /original 3d6/,
  );
  assert.throws(
    () => resolve(s, 'stunt:q', { mode: 'waive', note: 'Done', success: true }, qUser),
    /GM/,
  );
  s = resolve(s, 'stunt:q', {
    mode: 'waive',
    note: 'Automatic success using agreed ruling.',
    success: true,
  });
  assert.equal(s.checks[0].success, true);
});
test('attack availability follows actual manoeuvre and driver participation', () => {
  let s = actions();
  assert.equal(attackAllowed(s, unit(s, 'q')), false);
  s = actions('moveAttack', 'move', 'vehicle');
  assert.equal(attackAllowed(s, unit(s, 'q')), false);
  s.sides.quarry.declaration.operatorAttacks = true;
  assert.equal(attackAllowed(s, unit(s, 'q')), true);
  s.sides.quarry.declaration = null;
  assert.equal(attackAllowed(s, unit(s, 'q')), false);
});
test('atomic driver replacement demotes old driver and changes effective skill', () => {
  let s = base('vehicle');
  s.participants.push(
    newParticipant({ id: 'old', transportId: 'q', role: 'operator', skill: 12 }),
    newParticipant({ id: 'new', transportId: 'q', skill: 17 }),
  );
  s = cmd(s, 'crew', { personId: 'new', vehicleId: 'q', role: 'operator', when: 'now' });
  assert.equal(unit(s, 'old').role, 'passenger');
  assert.equal(travelStats(s, unit(s, 'q')).skill, 17);
});
test('boarding enemy vehicle retains allegiance; takeover is explicit and atomic', () => {
  let s = actions('move', 'move', 'vehicle');
  s.participants.push(newParticipant({ id: 'boarder' }));
  s = cmd(s, 'crew', { personId: 'boarder', vehicleId: 'p', role: 'passenger', when: 'now' });
  assert.equal(unit(s, 'boarder').side, 'quarry');
  assert.equal(unit(s, 'p').side, 'pursuer');
  assert.throws(
    () => cmd(s, 'crew', { personId: 'boarder', vehicleId: 'p', role: 'operator' }),
    /takeover/,
  );
  s = cmd(s, 'crew', {
    personId: 'boarder',
    vehicleId: 'p',
    role: 'operator',
    takeover: true,
    recovery: false,
  });
  assert.equal(unit(s, 'p').side, 'quarry');
  assert.equal(unit(s, 'p').status, 'closeCall');
  assert.equal(unit(s, 'p').dueRound, s.round + 1);
});
test('scheduled disembark retains current mode, applies next round and can be undone', () => {
  let s = actions('move', 'move', 'vehicle');
  s.participants.push(newParticipant({ id: 'crew', transportId: 'q' }));
  s = cmd(s, 'crew', { personId: 'crew', vehicleId: '', when: 'next' });
  assert.equal(unit(s, 'crew').transportId, 'q');
  s = cmd(s, 'override', { band: s.band, reason: 'Advance after adjudicated result' });
  assert.equal(unit(s, 'crew').transportId, '');
  assert.equal(s.pendingCrew.length, 0);
  s = cmd(s, 'undo');
  assert.equal(unit(s, 'crew').transportId, 'q');
  assert.equal(s.pendingCrew.length, 1);
});
test('destroyed scheduled destination cancels visibly without blocking the next round', () => {
  let s = actions('move', 'move', 'vehicle');
  s.participants.push(newParticipant({ id: 'crew' }));
  s = cmd(s, 'crew', { personId: 'crew', vehicleId: 'q', when: 'next' });
  s = cmd(s, 'condition', { id: 'q', status: 'wreck' });
  s = cmd(s, 'override', { band: s.band, reason: 'Continue survivors' });
  assert.equal(s.round, 2);
  assert.equal(unit(s, 'crew').transportId, '');
  assert.match(s.crewAlerts[0], /cancelled/);
});
test('embark task enforces next-round timing and normal task order', () => {
  let s = actions('embark', 'moveAttack', 'vehicle');
  s.sides.pursuer.declaration.operatorAttacks = true;
  s.participants.push(newParticipant({ id: 'crew', transportId: 'q' }));
  s = prep(s);
  assert.throws(
    () => cmd(s, 'crew', { taskId: 'embark:q', personId: 'crew', vehicleId: '', when: 'next' }),
    /pursuer actions/,
  );
  s = cmd(s, 'passSide');
  assert.throws(
    () => cmd(s, 'crew', { taskId: 'embark:q', personId: 'crew', vehicleId: '', when: 'now' }),
    /next round/,
  );
  s = cmd(s, 'crew', { taskId: 'embark:q', personId: 'crew', vehicleId: '', when: 'next' });
  assert.ok(tasks(s).find((t) => t.id === 'embark:q').done);
});
test('after contest dice start, immediate crew changes are rejected with scheduling guidance', () => {
  let s = actions('move', 'move', 'vehicle');
  s.participants.push(newParticipant({ id: 'crew', transportId: 'q' }));
  s = cmd(s, 'actionsDone', { confirmed: true });
  assert.throws(
    () => cmd(s, 'crew', { personId: 'crew', vehicleId: '', when: 'now' }),
    /next round/,
  );
  assert.doesNotThrow(() => cmd(s, 'crew', { personId: 'crew', vehicleId: '', when: 'next' }));
});
test('additive migration preserves legacy participants, rolls, epochs and history', () => {
  let s = actions();
  s = cmd(s, 'actionsDone', { confirmed: true });
  s = cmd(s, 'roll', { side: 'quarry' }, qUser, { total: 11 });
  delete s.workflow;
  delete s.workflowVersion;
  delete s.pendingCrew;
  const old = structuredClone(s),
    up = upgrade(s);
  assert.deepEqual(up.participants, old.participants);
  assert.deepEqual(up.sides, old.sides);
  assert.equal(up.epoch, old.epoch);
  assert.deepEqual(up.history, old.history);
  assert.equal(up.workflow.legacyResolved, true);
  assert.equal(s.workflow, undefined);
  const next = cmd(up, 'roll', { side: 'pursuer' }, pUser, { total: 12 });
  assert.equal(next.phase, 'range');
});
test('legacy action rounds acquire missing required tasks without losing recorded successes', () => {
  let s = actions('stunt');
  s.checks = [{ id: 'q', purpose: 'stunt', success: true, total: 10, target: 12 }];
  delete s.workflow;
  const up = upgrade(s);
  assert.equal(up.workflow.legacyResolved, false);
  assert.ok(tasks(up).find((t) => t.id === 'stunt:q').done);
  assert.equal(remainingRequired(up)[0].kind, 'scene');
});
test('participant editing ignores unrelated updates but rejects conflicting edits', () => {
  let s = base(),
    p = structuredClone(unit(s, 'q')),
    expectedParticipant = JSON.stringify(p);
  s = cmd(s, 'note', { text: 'Unrelated ruling' });
  s = cmd(s, 'participant', { data: { ...p, name: 'Renamed' }, expectedParticipant });
  assert.equal(unit(s, 'q').name, 'Renamed');
  assert.throws(
    () => cmd(s, 'participant', { data: p, expectedParticipant }),
    /participant changed/,
  );
});
test('running participant edits preserve phase and allow ad hoc additions in one command', () => {
  const s = actions();
  const next = cmd(s, 'participant', {
    data: newParticipant({ id: 'extra' }),
    expectedParticipant: 'null',
    pauseForEdit: true,
  });
  assert.equal(next.status, 'running');
  assert.equal(next.phase, 'actions');
  assert.ok(unit(next, 'extra'));
  assert.throws(
    () => cmd(s, 'participant', { data: newParticipant(), pauseForEdit: true }, qUser),
    /GM/,
  );
});
test('starting range and private settings reject post-setup changes rather than ignoring them', () => {
  const s = actions();
  assert.throws(
    () => cmd(s, 'configure', { data: { name: s.name, band: 0, blind: true } }),
    /locked after setup/,
  );
  assert.equal(
    cmd(s, 'configure', { data: { name: 'Updated scene', environment: 'Rain' } }).name,
    'Updated scene',
  );
});
test('ad hoc driver can be created and assigned in one crew command', () => {
  let s = base('vehicle');
  s = cmd(s, 'crew', {
    newPerson: {
      id: 'driver',
      name: 'Impromptu driver',
      side: 'quarry',
      skill: 16,
      controllers: ['alice'],
    },
    originVehicleId: 'q',
    vehicleId: 'q',
    role: 'operator',
    when: 'now',
  });
  assert.equal(unit(s, 'driver').actorUuid, '');
  assert.equal(unit(s, 'driver').role, 'operator');
  assert.equal(travelStats(s, unit(s, 'q')).skill, 16);
  assert.deepEqual(unit(s, 'driver').controllers, ['alice']);
});
test('a failed scheduled takeover cannot partly demote an existing driver', () => {
  let s = actions('move', 'move', 'vehicle');
  s.participants.push(
    newParticipant({ id: 'incoming', side: 'quarry' }),
    newParticipant({ id: 'existing', side: 'quarry', transportId: 'q', role: 'operator' }),
  );
  s = cmd(s, 'crew', { personId: 'incoming', vehicleId: 'q', role: 'operator', when: 'next' });
  unit(s, 'q').side = 'pursuer';
  unit(s, 'existing').side = 'pursuer';
  s = cmd(s, 'override', { band: s.band, reason: 'Ownership changed before transfer' });
  assert.equal(unit(s, 'existing').role, 'operator');
  assert.equal(unit(s, 'incoming').transportId, '');
  assert.ok(s.crewAlerts.length);
});
test('failed Reverse needs original dice and explicit consequence review', () => {
  let s = actions('reverse');
  s = cmd(s, 'actionsDone', { confirmed: true });
  s = cmd(s, 'roll', { side: 'quarry' }, qUser, { total: 12 });
  s = cmd(s, 'roll', { side: 'pursuer' }, pUser, { total: 10 });
  assert.equal(s.phase, 'reverseCheck');
  const original = { id: 'q', target: s.sides.quarry.roll.target, total: 12 };
  assert.throws(() => cmd(s, 'check', original), /consequences/);
  s = cmd(s, 'check', { ...original, reviewed: true });
  assert.equal(s.phase, 'range');
});
