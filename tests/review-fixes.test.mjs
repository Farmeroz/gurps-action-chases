import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newChase,
  newParticipant,
  successRoll,
  contestMargin,
  contest,
  breakdown,
  attackModifiers,
  wipeout,
  rangeChoices,
} from '../scripts/rules.mjs';
import { upgrade } from '../scripts/workflow.mjs';
import { applyCommand } from '../scripts/engine.mjs';
const gm = { id: 'gm', isGM: true };
function state(qTarget = 25, qDice = 17, pTarget = 22, pDice = 16) {
  const s = newChase('Review regressions');
  s.status = 'running';
  s.phase = 'range';
  s.participants = [
    newParticipant({ id: 'q', skill: 15, speed: 30 }),
    newParticipant({ id: 'p', side: 'pursuer', skill: 15, speed: 30 }),
  ];
  for (const [side, id, target, total] of [
    ['quarry', 'q', qTarget, qDice],
    ['pursuer', 'p', pTarget, pDice],
  ]) {
    Object.assign(s.sides[side], {
      leader: id,
      declaration: { key: 'move', penalty: 0 },
      roll: successRoll(target, total),
    });
  }
  s.result = contest(s);
  return s;
}
test('17 and 18 at high skill lose to a successful Chase Roll, with usable range margin', () => {
  for (const total of [17, 18]) {
    const s = state(25, total);
    assert.equal(s.sides.quarry.roll.success, false);
    assert.equal(s.result.winner, 'pursuer');
    assert.equal(s.result.margin, 7);
    assert.equal(s.result.steps, 1);
    assert.ok(rangeChoices(s, s.result).some((x) => x.key === 'close-1'));
  }
});
test('automatic results have explicit minimum margins while original dice arithmetic is preserved', () => {
  for (const [target, total, expected] of [
    [25, 17, -1],
    [25, 18, -1],
    [17, 17, -1],
    [16, 18, -2],
    [15, 18, -3],
    [1, 3, 0],
    [2, 4, 0],
    [15, 5, 10],
  ]) {
    const r = successRoll(target, total);
    assert.equal(contestMargin(r), expected);
    assert.equal(r.margin, target - total);
  }
});
test('automatic success beats failure, both failures compare margins, and criticals give no priority', () => {
  assert.equal(state(1, 3, 5, 6).result.winner, 'quarry');
  assert.equal(state(25, 17, 10, 12).result.winner, 'quarry');
  assert.equal(state(25, 18, 40, 17).result.winner, null);
  assert.equal(state(14, 3, 30, 10).result.winner, 'pursuer');
});
test('contest margins preserve success precedence across low and high skill boundaries', () => {
  for (const qt of [1, 3, 12, 15, 16, 17, 22, 25])
    for (const pt of [1, 3, 12, 15, 16, 17, 22, 25])
      for (let qd = 3; qd <= 18; qd++)
        for (let pd = 3; pd <= 18; pd++) {
          const q = successRoll(qt, qd),
            p = successRoll(pt, pd);
          if (q.success !== p.success) assert.equal(contestMargin(q) > contestMargin(p), q.success);
          else if (q.margin >= 0 && p.margin >= 0 && q.success)
            assert.equal(
              Math.sign(contestMargin(q) - contestMargin(p)),
              Math.sign(q.margin - p.margin),
            );
        }
});
test('unfinished old range decisions and Undo use corrected contest results without rewriting finished chases', () => {
  let s = state();
  s.result = { type: 'shift', winner: 'quarry', margin: 2, steps: 0 };
  const upgraded = upgrade(s);
  assert.equal(upgraded.result.winner, 'pursuer');
  assert.deepEqual(upgraded.sides.quarry.roll, s.sides.quarry.roll);
  s = applyCommand(s, { type: 'range', epoch: s.epoch, choice: 'close-1' }, gm);
  assert.equal(s.band, 1);
  assert.equal(s.round, 2);
  s = applyCommand(s, { type: 'undo', epoch: s.epoch }, gm);
  assert.equal(s.result.winner, 'pursuer');
  assert.equal(s.result.margin, 7);
  s.status = 'ended';
  s.phase = 'ended';
  s.result = { type: 'shift', winner: 'quarry', margin: 2, steps: 0 };
  assert.deepEqual(upgrade(s).result, s.result);
});
test('stunt preview earns its bonus only on recorded success', () => {
  const s = state();
  s.sides.quarry.declaration = { key: 'stunt', penalty: -4 };
  assert.equal(breakdown(s, 'quarry').target, 22);
  assert.equal(breakdown(s, 'quarry').pendingStunt, true);
  s.checks = [{ id: 'q', purpose: 'stunt', success: true }];
  assert.equal(breakdown(s, 'quarry').target, 24);
  assert.equal(breakdown(s, 'quarry').pendingStunt, false);
  s.checks[0].success = false;
  assert.equal(breakdown(s, 'quarry').target, 22);
  assert.equal(breakdown(s, 'quarry').pendingStunt, false);
});
test('Action 2 keeps passenger flat movement and Embark shooting penalties despite static chase movement', () => {
  const s = state();
  s.sides.quarry.declaration = { key: 'embark' };
  assert.equal(breakdown(s, 'quarry').isStatic, true);
  assert.equal(breakdown(s, 'quarry').parts.find((x) => x.label === 'Speed').value, 0);
  for (const bulk of [-2, -6]) {
    const m = attackModifiers({ band: 1, manoeuvre: 'embark', role: 'passenger', bulk, acc: 4 });
    assert.equal(m.movement, -1);
    assert.equal(m.accuracy, 0);
  }
  const driver = attackModifiers({
    band: 1,
    manoeuvre: 'embark',
    role: 'operator',
    bulk: -6,
    acc: 4,
  });
  assert.equal(driver.movement, -6);
  assert.equal(driver.accuracy, 0);
  const gun = attackModifiers({
    band: 1,
    manoeuvre: 'embark',
    role: 'passenger',
    bulk: -6,
    acc: 4,
    gunslinger: true,
  });
  assert.equal(gun.movement, 0);
  assert.equal(gun.accuracy, 4);
});
test('vehicle wipeout uses SR while pedestrian critical failure wrecks', () => {
  assert.equal(wipeout({ target: 15, total: 18, kind: 'vehicle', sr: 4 }).status, 'closeCall');
  assert.equal(wipeout({ target: 15, total: 18, kind: 'vehicle', sr: 2 }).status, 'wreck');
  assert.equal(wipeout({ target: 15, total: 18, kind: 'character' }).status, 'wreck');
});
