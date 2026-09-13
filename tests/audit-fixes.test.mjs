import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newChase,
  newParticipant,
  unit,
  travelStats,
  breakdown,
  driverProblems,
  missingDriver,
} from '../scripts/rules.mjs';
import { applyCommand, exportChase, importChase } from '../scripts/engine.mjs';
import { upgrade, tasks, taskAccess, attackAllowed, suggestedCheck } from '../scripts/workflow.mjs';
import { participantFromActor } from '../scripts/integration.mjs';

const gm = { id: 'gm', isGM: true },
  alice = { id: 'alice' },
  bob = { id: 'bob' };
const cmd = (s, type, data = {}, user = gm) =>
  applyCommand(s, { type, epoch: s.epoch, revision: s.revision, ...data }, user);
function setup() {
  const s = newChase('Audit regression');
  s.participants = [
    newParticipant({
      id: 'van',
      kind: 'vehicle',
      name: 'Van',
      skill: 11,
      speed: 30,
      sr: 4,
      controllers: ['alice'],
    }),
    newParticipant({ id: 'driver', name: 'Alex', transportId: 'van', role: 'operator', skill: 16 }),
    newParticipant({
      id: 'sam',
      name: 'Sam',
      transportId: 'van',
      skill: 14,
      controllers: ['alice'],
    }),
    newParticipant({
      id: 'bike',
      kind: 'vehicle',
      name: 'Bike',
      side: 'pursuer',
      skill: 14,
      speed: 40,
      controllers: ['bob'],
    }),
    newParticipant({ id: 'backup', kind: 'vehicle', name: 'Backup', skill: 12 }),
  ];
  s.sides.quarry.leader = 'van';
  s.sides.pursuer.leader = 'bike';
  return s;
}
function actions(q = 'move', p = 'move') {
  let s = cmd(setup(), 'start');
  s = cmd(s, 'declare', { side: 'quarry', data: { key: q, penalty: -2, operatorAttacks: true } });
  return cmd(s, 'declare', {
    side: 'pursuer',
    data: { key: p, penalty: -2, operatorAttacks: true },
  });
}
function rolled() {
  let s = actions();
  s = cmd(s, 'actionsDone', { confirmed: true });
  s = cmd(s, 'manualRoll', { side: 'quarry', total: 10 });
  return cmd(s, 'manualRoll', { side: 'pursuer', total: 12 });
}
const next = (s) =>
  cmd(s, 'override', { band: s.band, reason: 'Next round after resolved actions' });

test('late leader choice queues without changing the current contest, then applies and undoes atomically', () => {
  let s = rolled();
  const result = structuredClone(s.result),
    roll = structuredClone(s.sides.quarry.roll);
  s = cmd(s, 'leader', { side: 'quarry', id: 'backup' });
  assert.equal(s.sides.quarry.leader, 'van');
  assert.deepEqual(s.sides.quarry.roll, roll);
  assert.deepEqual(s.result, result);
  assert.equal(s.pendingLeaders.quarry, 'backup');
  assert.throws(() => cmd(s, 'leader', { side: 'quarry', id: 'backup', when: 'now' }), /locked/);
  s = cmd(s, 'range', { choice: 'hold' });
  assert.equal(s.sides.quarry.leader, 'backup');
  assert.equal(s.round, 2);
  assert.deepEqual(s.pendingLeaders, {});
  s = cmd(s, 'undo');
  assert.equal(s.sides.quarry.leader, 'van');
  assert.equal(s.pendingLeaders.quarry, 'backup');
  assert.deepEqual(s.result, result);
});
test('a queued leader follows role reversal, and an unavailable selection cancels visibly', () => {
  let s = cmd(rolled(), 'leader', { side: 'quarry', id: 'backup' });
  s = cmd(s, 'override', { band: 0, swap: true, reason: 'Reverse the chase' });
  assert.equal(s.sides.pursuer.leader, 'backup');
  s = cmd(rolled(), 'leader', { side: 'quarry', id: 'backup' });
  s = cmd(s, 'condition', { id: 'backup', status: 'out' });
  s = next(s);
  assert.equal(s.sides.quarry.leader, 'van');
  assert.match(s.crewAlerts[0], /no longer eligible/);
});
test('an old incomplete range result is gated on load instead of applied', () => {
  const old = rolled();
  old.sides.quarry.roll = null;
  const s = upgrade(old);
  assert.equal(s.result, null);
  assert.equal(s.status, 'paused');
  assert.match(s.outcomeRequired, /incomplete contest/);
  assert.throws(() => cmd(s, 'range', { choice: 'hold' }));
  assert.throws(() => cmd(s, 'resume'), /incomplete contest/);
  const ended = cmd(s, 'override', { band: 2, end: true, reason: 'GM resolved the saved round' });
  assert.equal(ended.status, 'ended');
  assert.equal(ended.outcomeRequired, '');
});
test('incapacitation and removal require a real replacement, without silently using fallback skill', () => {
  for (const type of ['condition', 'remove']) {
    let s = actions();
    assert.equal(travelStats(s, unit(s, 'van')).skill, 16);
    s = cmd(
      s,
      type,
      type === 'condition' ? { id: 'driver', status: 'out' } : { id: 'driver', pauseForEdit: true },
    );
    assert.equal(missingDriver(s, unit(s, 'van')), true);
    assert.equal(travelStats(s, unit(s, 'van')).skill, null);
    assert.throws(() => breakdown(s, 'quarry'), /replacement driver/);
    assert.ok(tasks(s).some((t) => t.kind === 'driver'));
    assert.throws(() => cmd(s, 'actionsDone', { confirmed: true }), /missing-driver/);
    s = cmd(s, 'crew', {
      taskId: 'driver:van',
      personId: 'sam',
      vehicleId: 'van',
      role: 'operator',
      when: 'now',
    });
    assert.equal(travelStats(s, unit(s, 'van')).skill, 14);
    assert.equal(unit(s, 'van').dueRound, 2);
    assert.equal(driverProblems(s).length, 0);
  }
});
test('a second lost driver in the same round gets a fresh required resolution', () => {
  let s = cmd(actions(), 'condition', { id: 'driver', status: 'out' });
  s = cmd(s, 'crew', {
    taskId: 'driver:van',
    personId: 'sam',
    vehicleId: 'van',
    role: 'operator',
    when: 'now',
  });
  s = cmd(s, 'condition', { id: 'sam', status: 'out' });
  assert.equal(tasks(s).find((t) => t.kind === 'driver').done, false);
  assert.throws(
    () =>
      cmd(s, 'task', { taskId: 'driver:van', mode: 'approve', stop: true, note: 'Crash' }, alice),
    /GM/,
  );
  s = cmd(s, 'task', {
    taskId: 'driver:van',
    mode: 'approve',
    stop: true,
    note: 'Wreck and occupant injury resolved.',
  });
  assert.equal(unit(s, 'van').status, 'wreck');
  assert.equal(s.sides.quarry.leader, 'backup');
});
test('losing the rolled leader or driver invalidates the outcome but preserves the dice for the GM', () => {
  for (const id of ['van', 'driver']) {
    let s = rolled();
    const roll = s.sides.quarry.roll;
    s = cmd(s, 'condition', { id, status: 'out' });
    assert.equal(s.status, 'paused');
    assert.equal(s.result, null);
    assert.deepEqual(s.sides.quarry.roll, roll);
    assert.match(s.outcomeRequired, /after Chase Rolls/);
    if (id === 'driver') {
      assert.equal(
        taskAccess(
          s,
          tasks(s).find((t) => t.kind === 'driver'),
          gm,
        ),
        '',
      );
      s = cmd(s, 'crew', {
        taskId: 'driver:van',
        personId: 'sam',
        vehicleId: 'van',
        role: 'operator',
        when: 'now',
      });
      assert.equal(driverProblems(s).length, 0);
    }
    assert.throws(() => cmd(s, 'resume'), /after Chase Rolls/);
    s = next(s);
    assert.equal(s.status, 'running');
    assert.equal(s.outcomeRequired, '');
  }
});
test('a genuinely ad hoc vehicle still uses fallback, and legacy inactive drivers are detected', () => {
  let s = setup();
  assert.equal(travelStats(s, unit(s, 'bike')).skill, 14);
  delete unit(s, 'van').driverRequired;
  unit(s, 'driver').status = 'out';
  s = upgrade(s);
  assert.ok(missingDriver(s, unit(s, 'van')));
  assert.equal(driverProblems(s).length, 1);
});
test('immediate and scheduled recovery is due after takeover, retaining any earlier emergency', () => {
  let s = actions();
  s.round = 4;
  s = cmd(s, 'crew', {
    personId: 'sam',
    vehicleId: 'van',
    role: 'operator',
    when: 'now',
    recovery: true,
  });
  assert.equal(unit(s, 'van').dueRound, 5);
  s = actions();
  s.round = 4;
  s = cmd(s, 'crew', {
    personId: 'sam',
    vehicleId: 'van',
    role: 'operator',
    when: 'next',
    recovery: true,
  });
  assert.equal(unit(s, 'van').status, 'active');
  s = next(s);
  assert.equal(s.round, 5);
  assert.equal(unit(s, 'van').dueRound, 6);
  s = actions();
  s.round = 4;
  s = cmd(s, 'condition', { id: 'van', status: 'closeCall', dueRound: 4 });
  s = cmd(s, 'crew', {
    personId: 'sam',
    vehicleId: 'van',
    role: 'operator',
    when: 'now',
    recovery: true,
  });
  assert.equal(unit(s, 'van').dueRound, 4);
});
test('hostile passenger eligibility, modifiers, order, finish task and ownership follow the actual vehicle', () => {
  let s = actions('moveAttack', 'move');
  unit(s, 'sam').side = 'pursuer';
  unit(s, 'sam').controllers = ['bob'];
  assert.equal(attackAllowed(s, unit(s, 'sam')), true);
  const t = tasks(s).find((t) => t.id === 'passenger:sam');
  assert.equal(t.group, 'quarry');
  assert.equal(t.side, 'pursuer');
  assert.equal(taskAccess(s, t, bob), '');
  assert.match(taskAccess(s, t, alice), /controller/);
  s = cmd(
    s,
    'task',
    { taskId: t.id, action: 'Attack', mode: 'manual', target: 18, total: 8, bulk: -4, acc: 5 },
    bob,
  );
  const result = s.workflow.outcomes[t.id].result;
  assert.equal(result.modifiers.movement, -1);
  assert.equal(result.modifiers.accuracy, 0);
  assert.equal(result.target, 10);
  const finish = tasks(s).find((t) => t.id === 'finish:passenger:sam');
  assert.equal(finish.group, 'quarry');
  s = actions('move', 'moveAttack');
  unit(s, 'sam').side = 'pursuer';
  assert.equal(attackAllowed(s, unit(s, 'sam')), false);
  assert.throws(
    () => cmd(s, 'passenger', { id: 'sam', action: 'Attack' }),
    /pursuer actions|vehicle’s manoeuvre/,
  );
});
test('hostile passenger cannot act before the host action group, even with a different allegiance', () => {
  let s = actions('move', 'moveAttack');
  unit(s, 'sam').side = 'pursuer';
  unit(s, 'sam').controllers = ['bob'];
  const t = tasks(s).find((t) => t.id === 'passenger:sam');
  assert.match(taskAccess(s, t, bob), /pursuer actions/);
  s = cmd(s, 'passSide');
  assert.equal(taskAccess(s, t, bob), '');
});
test('foot stunts require a real stunt skill, with no Running fallback', () => {
  let s = actions();
  const foot = newParticipant({ id: 'runner', skillName: 'Running', skill: 18 });
  s.participants.push(foot);
  s.sides.quarry.leader = 'runner';
  s.sides.quarry.declaration = { key: 'stunt', penalty: -2 };
  assert.equal(suggestedCheck(s, foot), null);
  foot.jumping = 13;
  assert.equal(suggestedCheck(s, foot), 11);
  assert.throws(
    () => cmd(s, 'task', { taskId: 'scene:quarry', mode: 'approve' }),
    /Minimum penalty/,
  );
  assert.throws(
    () => cmd(s, 'task', { taskId: 'scene:quarry', mode: 'approve', minimumPenalty: -4 }),
    /too easy/,
  );
  s = cmd(s, 'task', { taskId: 'scene:quarry', mode: 'approve', minimumPenalty: -2 });
  assert.throws(
    () =>
      cmd(s, 'task', {
        taskId: 'stunt:runner',
        mode: 'manual',
        target: 16,
        total: 10,
        stuntSkill: 'running',
      }),
    /Acrobatics/,
  );
  s = cmd(s, 'task', {
    taskId: 'stunt:runner',
    mode: 'manual',
    target: 11,
    total: 10,
    stuntSkill: 'jumping',
  });
  assert.equal(s.checks.at(-1).stuntSkill, 'jumping');
  assert.equal(s.checks.at(-1).target, 11);
});
test('successful and scheduled transfers retain reasons in state and log', () => {
  let s = cmd(actions(), 'crew', {
    personId: 'sam',
    vehicleId: 'van',
    role: 'operator',
    when: 'now',
    note: 'Alex treats his injured hand.',
  });
  assert.ok(s.log.some((x) => x.text.includes('Alex treats his injured hand.')));
  s = cmd(s, 'crew', {
    personId: 'sam',
    vehicleId: '',
    when: 'next',
    leaveSource: true,
    note: 'Take the alley on foot.',
  });
  assert.equal(s.pendingCrew[0].note, 'Take the alley on foot.');
  s = next(s);
  assert.ok(s.log.some((x) => x.round === 2 && x.text.includes('Take the alley on foot.')));
});
test('last crew departure retires the abandoned vehicle and follows the crew, with Undo and an explicit keep option', () => {
  let s = actions();
  s = cmd(s, 'crew', { personId: 'driver', vehicleId: '', when: 'next', leaveSource: true });
  s = cmd(s, 'crew', { personId: 'sam', vehicleId: '', when: 'next', leaveSource: true });
  const before = structuredClone(s);
  s = next(s);
  assert.equal(unit(s, 'van').status, 'out');
  assert.equal(unit(s, 'sam').transportId, '');
  assert.equal(unit(s, 'driver').transportId, '');
  assert.ok(['driver', 'sam'].includes(s.sides.quarry.leader));
  assert.equal(driverProblems(s).length, 0);
  s = cmd(s, 'undo');
  assert.deepEqual(s.participants, before.participants);
  assert.equal(s.pendingCrew.length, 2);
  let keep = actions();
  keep.participants = keep.participants.filter((x) => x.id !== 'driver');
  unit(keep, 'van').driverRequired = false;
  keep = cmd(keep, 'crew', { personId: 'sam', vehicleId: '', when: 'now', leaveSource: false });
  assert.equal(unit(keep, 'van').status, 'active');
  assert.equal(keep.sides.quarry.leader, 'van');
});
test('retiring a vehicle follows the final crew member into a friendly destination vehicle', () => {
  let s = actions();
  s = cmd(s, 'crew', {
    personId: 'driver',
    vehicleId: 'backup',
    role: 'operator',
    when: 'next',
    leaveSource: true,
  });
  s = cmd(s, 'crew', { personId: 'sam', vehicleId: 'backup', when: 'next', leaveSource: true });
  s = next(s);
  assert.equal(s.sides.quarry.leader, 'backup');
  assert.equal(unit(s, 'van').status, 'out');
});
test('named Gunslinger imports from ordinary and nested advantages without guessing unrelated names', () => {
  const actor = {
    name: 'Shooter',
    system: {
      attributes: { DX: { value: 12 } },
      ads: { a: { name: 'Combat traits', collapsed: { b: { name: 'Gunslinger (Pistols)' } } } },
    },
  };
  assert.equal(participantFromActor(actor).gunslinger, true);
  actor.system.ads = { a: { name: 'Gunslinger fan club' } };
  assert.equal(participantFromActor(actor).gunslinger, false);
});
test('Undo of a log ruling removes that note without rewinding the preceding action', () => {
  let s = actions();
  const before = structuredClone(s);
  s = cmd(s, 'note', { text: 'Wet road' });
  s = cmd(s, 'undo');
  assert.deepEqual(s.sides, before.sides);
  assert.equal(s.phase, 'actions');
  assert.ok(!s.log.some((x) => x.text.includes('Wet road')));
});
test('portable import clears queued leaders while retaining missing-driver safety', () => {
  let s = cmd(rolled(), 'leader', { side: 'quarry', id: 'backup' });
  s = cmd(s, 'condition', { id: 'driver', status: 'out' });
  const imported = upgrade(importChase(exportChase(s)));
  assert.deepEqual(imported.pendingLeaders, {});
  assert.equal(imported.outcomeRequired, '');
  assert.ok(missingDriver(imported, unit(imported, 'van')));
});
test('disembarking reviews foot skill without replacing the driver skill used on reboarding', () => {
  let s = actions();
  unit(s, 'driver').skillName = 'Driving (Automobile)';
  assert.throws(
    () => cmd(s, 'crew', { personId: 'driver', vehicleId: '', when: 'next', leaveSource: true }),
    /on-foot chase skill/,
  );
  s = cmd(s, 'crew', {
    personId: 'driver',
    vehicleId: '',
    when: 'next',
    leaveSource: true,
    footSkill: 12,
    footSkillName: 'DX',
  });
  s = next(s);
  assert.equal(travelStats(s, unit(s, 'driver')).skill, 12);
  assert.equal(unit(s, 'driver').skill, 16);
  s = cmd(s, 'crew', { personId: 'driver', vehicleId: 'van', role: 'operator', when: 'now' });
  assert.equal(travelStats(s, unit(s, 'van')).skill, 16);
});
test('rules choices are saved once, applied to rolls and tasks, portable, and locked during play', () => {
  let s = setup();
  unit(s, 'van').speed = 6;
  s = cmd(s, 'configure', {
    data: {
      name: s.name,
      band: 2,
      blind: false,
      speedRounding: 'table',
      driverShots: 'passengers',
    },
  });
  s = cmd(s, 'start');
  s = cmd(s, 'declare', { side: 'quarry', data: { key: 'embark' } });
  s = cmd(s, 'declare', { side: 'pursuer', data: { key: 'move' } });
  assert.equal(attackAllowed(s, unit(s, 'van')), false);
  assert.equal(attackAllowed(s, unit(s, 'sam')), true);
  unit(s, 'driver').gunslinger = true;
  assert.equal(attackAllowed(s, unit(s, 'van')), true);
  s.sides.quarry.declaration = { key: 'move' };
  assert.equal(breakdown(s, 'quarry').parts.find((x) => x.label === 'Speed').value, 2);
  assert.throws(
    () => cmd(s, 'configure', { data: { name: s.name, speedRounding: 'action' } }),
    /lock/,
  );
  assert.deepEqual(importChase(exportChase(s)).ruleOptions, {
    speedRounding: 'table',
    driverShots: 'passengers',
  });
  const legacy = setup();
  delete legacy.ruleOptions;
  assert.deepEqual(upgrade(legacy).ruleOptions, {
    speedRounding: 'action',
    driverShots: 'general',
  });
});
