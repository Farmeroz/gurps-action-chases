import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newChase,
  newParticipant,
  speedBonus,
  successRoll,
  wipeout,
  breakdown,
  contest,
  rangeChoices,
  attackModifiers,
  canControl,
  validateDeclaration,
} from '../scripts/rules.mjs';
import { applyCommand, exportChase, importChase, validateRoster } from '../scripts/engine.mjs';
import { dxBasedLevel, participantFromActor } from '../scripts/integration.mjs';
import { tasks } from '../scripts/workflow.mjs';
import { sha256 } from '../scripts/hash.mjs';
import { createHash } from 'node:crypto';
const gm = { id: 'gm', isGM: true },
  alice = { id: 'alice', isGM: false },
  bob = { id: 'bob', isGM: false };
function setup(kind = 'character') {
  const s = newChase('Test chase');
  s.participants = [
    newParticipant({
      id: 'q',
      name: 'Quarry',
      kind,
      side: 'quarry',
      controllers: ['alice'],
      skill: 14,
      speed: 5,
      sr: 3,
      stealth: 14,
    }),
    newParticipant({
      id: 'p',
      name: 'Pursuer',
      kind,
      side: 'pursuer',
      controllers: ['bob'],
      skill: 14,
      speed: 5,
      sr: 3,
    }),
  ];
  s.sides.quarry.leader = 'q';
  s.sides.pursuer.leader = 'p';
  return s;
}
function cmd(s, type, data = {}, user = gm, options = {}) {
  return applyCommand(s, { type, epoch: s.epoch, revision: s.revision, ...data }, user, options);
}
function running(q = 'move', p = 'move', kind = 'character') {
  let s = cmd(setup(kind), 'start');
  s = cmd(s, 'declare', { side: 'quarry', data: { key: q, penalty: -4 } });
  s = cmd(s, 'declare', { side: 'pursuer', data: { key: p, penalty: -4 } });
  return s;
}
function approveScene(s) {
  for (const t of tasks(s).filter((t) => t.kind === 'scene' && !t.done))
    s = cmd(s, 'task', { taskId: t.id, mode: 'approve', minimumPenalty: -4 });
  return s;
}
function rolled(qTotal, pTotal, q = 'move', p = 'move', kind = 'character') {
  let s = approveScene(running(q, p, kind));
  s = cmd(s, 'actionsDone', { confirmed: true });
  s = cmd(s, 'roll', { side: 'quarry' }, gm, { total: qTotal });
  return cmd(s, 'roll', { side: 'pursuer' }, gm, { total: pTotal });
}
test('speed bonuses honour printed examples and lower in-between values', () => {
  for (const [move, expected] of [
    [5, 2],
    [6, 3],
    [7, 3],
    [8, 3],
    [10, 4],
    [15, 5],
    [20, 6],
    [30, 7],
    [50, 8],
    [70, 9],
    [100, 10],
    [33, 7],
    [0, 0],
    [1, -2],
  ])
    assert.equal(speedBonus(move), expected, `${move}`);
});
test('reject NaN, infinity and negative speeds', () => {
  for (const x of [NaN, Infinity, -1, '']) assert.throws(() => speedBonus(x));
});
test('standard success and critical failure boundaries', () => {
  assert.equal(successRoll(16, 6).criticalSuccess, true);
  assert.equal(successRoll(15, 6).criticalSuccess, false);
  assert.equal(successRoll(25, 17).success, false);
  assert.equal(successRoll(25, 17).criticalFailure, false);
  assert.equal(successRoll(15, 17).criticalFailure, true);
  assert.equal(successRoll(7, 17).criticalFailure, true);
});
test('vehicle wipeouts use margin versus SR', () => {
  assert.equal(wipeout({ target: 12, total: 15, kind: 'vehicle', sr: 3 }).status, 'closeCall');
  assert.equal(wipeout({ target: 12, total: 16, kind: 'vehicle', sr: 3 }).status, 'wreck');
  assert.throws(() => wipeout({ target: 12, total: 15, kind: 'vehicle', sr: null }));
});
test('pedestrian critical failures wreck, ordinary failures are close calls', () => {
  assert.equal(wipeout({ target: 12, total: 14, kind: 'character' }).status, 'closeCall');
  assert.equal(wipeout({ target: 12, total: 18, kind: 'character' }).status, 'wreck');
});
test('Move and Attack only penalises attacking operators, not passenger fire', () => {
  const s = running('moveAttack', 'move', 'vehicle');
  assert.equal(breakdown(s, 'quarry').target, 16);
  s.sides.quarry.declaration.operatorAttacks = true;
  assert.equal(breakdown(s, 'quarry').target, 14);
  const foot = running('moveAttack');
  assert.equal(breakdown(foot, 'quarry').target, 14);
});
test('Hide requires Stealth for a pedestrian and applies range modifier', () => {
  const s = running('hide');
  assert.equal(breakdown(s, 'quarry').target, 6);
  s.participants[0].stealth = null;
  assert.throws(() => breakdown(s, 'quarry'), /Stealth/);
  s.sides.quarry.baseOverride = 18;
  assert.equal(breakdown(s, 'quarry').target, 10);
});
test('vehicle uses separate operator skill and its own Handling / speed', () => {
  const s = running('move', 'move', 'vehicle');
  s.participants.push(
    newParticipant({
      id: 'driver',
      skill: 18,
      side: 'quarry',
      transportId: 'q',
      role: 'operator',
      controllers: ['alice'],
    }),
  );
  s.participants[0].handling = 2;
  assert.equal(breakdown(s, 'quarry').target, 22);
});
test('unauthorised players cannot declare or edit another side', () => {
  const s = cmd(setup(), 'start');
  assert.throws(() => cmd(s, 'declare', { side: 'quarry', data: { key: 'move' } }, bob), /control/);
  assert.throws(() => cmd(s, 'configure', { data: { name: 'Hacked' } }, alice), /GM/);
});
test('actor ownership and assigned operator confer appropriate control', () => {
  const s = setup('vehicle');
  s.participants[0].controllers = [];
  s.participants.push(
    newParticipant({
      id: 'driver',
      side: 'quarry',
      transportId: 'q',
      role: 'operator',
      controllers: ['alice'],
    }),
  );
  assert.equal(canControl(s, s.participants[0], alice), true);
  assert.equal(canControl(s, s.participants[0], bob), false);
  s.participants[0].actorUuid = 'Actor.owned';
  assert.equal(
    canControl(s, s.participants[0], bob, (uuid) => uuid === 'Actor.owned'),
    true,
  );
});
test('quarry declares first, pursuer responds, duplicate clicks rejected', () => {
  let s = cmd(setup(), 'start');
  assert.throws(() => cmd(s, 'declare', { side: 'pursuer', data: { key: 'move' } }), /step/);
  s = cmd(s, 'declare', { side: 'quarry', data: { key: 'move' } }, alice);
  assert.throws(() => cmd(s, 'declare', { side: 'quarry', data: { key: 'move' } }, alice), /step/);
});
test('stale epoch and stale editor revision are rejected', () => {
  const s = setup();
  assert.throws(() => applyCommand(s, { type: 'start', epoch: 'old' }, gm), /round changed/);
  assert.throws(
    () => applyCommand(s, { type: 'configure', epoch: s.epoch, revision: 99, data: {} }, gm),
    /editor/,
  );
});
test('processed request IDs prevent replay and double mutation', () => {
  const s = setup(),
    c = { type: 'start', epoch: s.epoch };
  const next = applyCommand(s, c, gm, { requestId: 'req' });
  assert.deepEqual(applyCommand(next, c, gm, { requestId: 'req' }), next);
});
test('GM confirmation gates chase rolls', () => {
  let s = running();
  assert.throws(() => cmd(s, 'roll', { side: 'quarry' }, alice, { total: 10 }), /actions step/);
  assert.throws(() => cmd(s, 'actionsDone', { confirmed: false }), /Confirm/);
  s = cmd(s, 'actionsDone', { confirmed: true });
  assert.equal(s.phase, 'chase');
});
test('contest thresholds: 0–4 none; 5–9 one; 10+ two', () => {
  for (const [q, p, steps] of [
    [10, 10, 0],
    [10, 14, 0],
    [8, 13, 1],
    [5, 15, 2],
  ])
    assert.equal(rolled(q, p).result.steps, steps);
});
test('critical success does not trump greater margin in a Quick Contest', () => {
  const s = rolled(3, 10);
  s.sides.pursuer.roll.target = 30;
  s.sides.pursuer.roll.margin = 20;
  assert.equal(contest(s).winner, 'pursuer');
});
test('one static side loses the range choice even if it wins the contest', () => {
  const s = rolled(3, 18, 'attack', 'move');
  assert.equal(s.result.winner, 'pursuer');
  assert.equal(s.result.steps, 1);
  assert.equal(s.result.staticBonus, true);
});
test('moving winner gains a third shift against a static loser', () => {
  const s = rolled(18, 3, 'attack', 'move');
  assert.equal(s.result.steps, 3);
});
test('both static means no range change', () => {
  const s = rolled(3, 18, 'attack', 'attack');
  assert.equal(s.result.steps, 0);
  assert.equal(s.result.winner, null);
});
test('ordinary winner can open or close range', () => {
  const s = rolled(8, 14);
  const c = rangeChoices(s, s.result);
  assert.ok(c.some((x) => x.key === 'open-1'));
  assert.ok(c.some((x) => x.key === 'close-1'));
});
test('only a winning quarry can select escape beyond Extreme', () => {
  const s = rolled(5, 15);
  s.band = 4;
  assert.ok(rangeChoices(s, s.result).some((x) => x.key === 'escape'));
  s.result.winner = 'pursuer';
  assert.ok(!rangeChoices(s, s.result).some((x) => x.key === 'escape'));
});
test('Mobility Pursuit cannot spend shifts opening the gap', () => {
  const s = rolled(16, 6, 'move', 'mobilityPursuit');
  assert.ok(rangeChoices(s, s.result).every((x) => !x.key.startsWith('open')));
});
test('Hide loss sets Close regardless of ordinary contest shift', () => {
  const s = rolled(15, 5, 'hide');
  assert.equal(s.result.type, 'fixed');
  assert.equal(s.result.band, 0);
});
test('Hide victory offers escape or role reversal at three allowed bands', () => {
  let s = approveScene(running('hide'));
  s = cmd(s, 'modifiers', { side: 'quarry', data: { comp: 0, extra: 20, baseOverride: null } });
  s = cmd(s, 'actionsDone', { confirmed: true });
  s = cmd(s, 'roll', { side: 'quarry' }, gm, { total: 8 });
  s = cmd(s, 'roll', { side: 'pursuer' }, gm, { total: 12 });
  assert.equal(s.result.type, 'hideWin');
  const next = cmd(s, 'range', { choice: 'hide-1' }, alice);
  assert.equal(next.band, 1);
  assert.equal(next.sides.pursuer.leader, 'q');
  assert.equal(next.round, 2);
});
test('Reverse failure gates range pending original-roll wipeout check', () => {
  const s = rolled(12, 10, 'reverse');
  assert.equal(s.phase, 'reverseCheck');
  assert.throws(() => cmd(s, 'check', { id: 'q', target: 12, total: 12 }), /original/);
  const next = cmd(s, 'check', {
    id: 'q',
    target: s.sides.quarry.roll.target,
    total: 12,
    reviewed: true,
  });
  assert.equal(next.result.swap, false);
  assert.equal(next.result.band, 0);
});
test('Stop ends a chase without needing an opposed roll', () => {
  let s = cmd(setup(), 'start');
  s = cmd(s, 'declare', { side: 'quarry', data: { key: 'stop' } }, alice);
  assert.equal(s.status, 'ended');
});
test('manoeuvre eligibility enforces side, range, transport and recovery', () => {
  const s = cmd(setup(), 'start');
  assert.throws(() => validateDeclaration(s, 'quarry', { key: 'ram' }));
  assert.throws(() => validateDeclaration(s, 'pursuer', { key: 'ram' }));
  s.participants[0].status = 'closeCall';
  s.participants[0].dueRound = 1;
  assert.throws(() => validateDeclaration(s, 'quarry', { key: 'move' }), /Emergency/);
  assert.equal(validateDeclaration(s, 'quarry', { key: 'emergency' }).key, 'emergency');
});
test('close call recovery is required next round and can be individually recorded', () => {
  let s = running();
  s = cmd(s, 'condition', { id: 'q', status: 'closeCall', dueRound: 1 });
  assert.throws(() => cmd(s, 'actionsDone', { confirmed: true }), /Emergency/);
  s = cmd(s, 'condition', { id: 'q', status: 'active', recovered: true });
  s = cmd(s, 'actionsDone', { confirmed: true });
  assert.equal(s.phase, 'chase');
});
test('stunt needs individual results; failure gives no stunt bonus', () => {
  let s = approveScene(running('stunt'));
  assert.throws(() => cmd(s, 'actionsDone', { confirmed: true }), /resolve stunt/);
  s = cmd(s, 'check', {
    id: 'q',
    target: 10,
    total: 12,
    purpose: 'stunt',
    stuntSkill: 'acrobatics',
    reviewed: true,
  });
  assert.equal(breakdown(s, 'quarry').parts.find((x) => x.label === 'Stunt').value, 0);
  s = cmd(s, 'actionsDone', { confirmed: true });
  assert.equal(s.phase, 'chase');
});
test('successful unmatched Stunt Escape makes pursuit persistently static', () => {
  let s = approveScene(running('stuntEscape'));
  s = cmd(s, 'check', {
    id: 'q',
    target: 10,
    total: 8,
    purpose: 'stunt',
    stuntSkill: 'acrobatics',
  });
  s = cmd(s, 'actionsDone', { confirmed: true });
  assert.equal(s.sides.pursuer.forcedStatic, true);
});
test('equal-risk opposing Stunt can follow Stunt Escape', () => {
  let s = approveScene(running('stuntEscape', 'stunt'));
  for (const id of ['q', 'p'])
    s = cmd(s, 'check', { id, target: 10, total: 8, purpose: 'stunt', stuntSkill: 'acrobatics' });
  s = cmd(s, 'actionsDone', { confirmed: true });
  assert.equal(s.sides.pursuer.forcedStatic, false);
});
test('passengers get one action and cannot board beyond Close', () => {
  let s = running('moveAttack', 'move', 'vehicle');
  s.participants.push(
    newParticipant({ id: 'crew', transportId: 'q', side: 'quarry', controllers: ['alice'] }),
  );
  assert.throws(() => cmd(s, 'passenger', { id: 'crew', action: 'Board' }, alice), /Close/);
  s = cmd(s, 'passenger', { id: 'crew', action: 'Attack' }, alice);
  assert.throws(() => cmd(s, 'passenger', { id: 'crew', action: 'Other Task' }, alice), /already/i);
});
test('passengers cannot attack during an ordinary Move', () => {
  const s = running('move', 'move', 'vehicle');
  s.participants.push(
    newParticipant({ id: 'crew', transportId: 'q', side: 'quarry', controllers: ['alice'] }),
  );
  assert.throws(() => cmd(s, 'passenger', { id: 'crew', action: 'Attack' }, alice), /permit/);
});
test('ranged attack helper handles Bulk, passengers, Acc, Gunslinger and range', () => {
  assert.equal(
    attackModifiers({
      band: 2,
      manoeuvre: 'moveAttack',
      role: 'operator',
      bulk: -4,
      acc: 3,
      target: -3,
    }).total,
    -14,
  );
  assert.equal(
    attackModifiers({
      band: 2,
      manoeuvre: 'moveAttack',
      role: 'passenger',
      bulk: -4,
      acc: 3,
      target: -3,
    }).total,
    -11,
  );
  assert.equal(
    attackModifiers({
      band: 2,
      manoeuvre: 'moveAttack',
      role: 'operator',
      bulk: -4,
      acc: 3,
      gunslinger: true,
    }).total,
    -4,
  );
  assert.equal(
    attackModifiers({ band: 0, manoeuvre: 'attack', acc: 3, gunslinger: true }).total,
    4,
  );
  assert.throws(() => attackModifiers({ band: 0, manoeuvre: 'hide', gunslinger: true }));
});
test('roster disallows vehicle nesting and multiple operators', () => {
  let s = setup('vehicle');
  s.participants[0].transportId = 'p';
  assert.throws(() => validateRoster(s), /character/);
  s = setup('vehicle');
  for (const id of ['d1', 'd2'])
    s.participants.push(newParticipant({ id, transportId: 'q', role: 'operator', side: 'quarry' }));
  assert.throws(() => validateRoster(s), /more than one/);
});
test('range application resets per-round data and cannot be repeated', () => {
  const s = rolled(8, 14),
    c = { type: 'range', epoch: s.epoch, choice: 'open-1' };
  const next = applyCommand(s, c, alice);
  assert.equal(next.round, 2);
  assert.equal(next.band, 3);
  assert.equal(next.sides.quarry.roll, null);
  assert.throws(() => applyCommand(next, c, alice), /round changed/);
});
test('undo restores range and rotates epoch to reject stale requests', () => {
  const s = rolled(8, 14),
    next = cmd(s, 'range', { choice: 'open-1' }),
    undo = cmd(next, 'undo');
  assert.equal(undo.band, s.band);
  assert.equal(undo.phase, 'range');
  assert.notEqual(undo.epoch, s.epoch);
});
test('blind commitments do not leak manoeuvres into public state', () => {
  let s = setup();
  s.blind = true;
  s = cmd(s, 'start');
  s = cmd(s, 'declare', { side: 'pursuer', data: { key: 'attack', notes: 'secret ambush' } }, bob, {
    requestId: 'private-p',
  });
  assert.equal(s.sides.pursuer.declaration, null);
  assert.equal(JSON.stringify(s).includes('secret ambush'), false);
  assert.throws(() => cmd(s, 'reveal'), /Both/);
  s = cmd(s, 'declare', { side: 'quarry', data: { key: 'move' } }, alice, {
    requestId: 'private-q',
  });
  s = cmd(s, 'reveal', {}, gm, {
    privateDeclarations: { quarry: { key: 'move' }, pursuer: { key: 'attack' } },
  });
  assert.equal(s.phase, 'actions');
  assert.equal(s.sides.pursuer.declaration.key, 'attack');
});
test('export/import creates new identity and drops permissions, links, and combat coupling', () => {
  const s = setup();
  s.participants[0].actorUuid = 'Actor.A';
  s.combatId = 'combat';
  const out = importChase(exportChase(s));
  assert.notEqual(out.id, s.id);
  assert.equal(out.participants[0].actorUuid, '');
  assert.deepEqual(out.participants[0].controllers, []);
  assert.equal(out.combatId, '');
  assert.equal(out.status, 'setup');
});
test('malformed imports are rejected', () => {
  for (const text of [
    '{}',
    'not json',
    JSON.stringify({ format: 'gurps-action-chases', version: 2 }),
  ])
    assert.throws(() => importChase(text));
});
test('Running imports are DX-based and recursive skills retain their basis', () => {
  const actor = {
    name: 'Runner',
    uuid: 'Actor.R',
    system: {
      attributes: { DX: { value: 12 }, HT: { value: 10 } },
      basicmove: { value: 6 },
      skills: { a: { name: 'Running', level: 13, relativelevel: 'HT+3' } },
    },
  };
  assert.equal(dxBasedLevel(actor, actor.system.skills.a), 15);
  assert.equal(participantFromActor(actor).skill, 15);
});
test('later successful control rolls preserve earlier unresolved close calls', () => {
  let s = running('move', 'move', 'vehicle');
  s = cmd(s, 'check', { id: 'q', target: 12, total: 14 });
  s = cmd(s, 'check', { id: 'q', target: 12, total: 8 });
  assert.equal(s.participants[0].status, 'closeCall');
  assert.equal(s.participants[0].dueRound, 2);
});
test('a hostile boarder retains allegiance as a passenger, not as an operator', () => {
  const s = setup('vehicle');
  s.participants.push(
    newParticipant({ id: 'boarder', side: 'quarry', transportId: 'p', role: 'passenger' }),
  );
  assert.doesNotThrow(() => validateRoster(s));
  s.participants[2].role = 'operator';
  assert.throws(() => validateRoster(s), /same side/);
});
test('HTTP-compatible commitment digest agrees with standard SHA-256 across block boundaries', () => {
  for (const text of [
    '',
    'abc',
    'GURPS: évasion 🚗',
    'x'.repeat(55),
    'x'.repeat(56),
    'x'.repeat(64),
    'y'.repeat(1000),
  ]) {
    assert.equal(
      sha256(new TextEncoder().encode(text)),
      createHash('sha256').update(text).digest('hex'),
    );
  }
});
