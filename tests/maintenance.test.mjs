import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newChase,
  newParticipant,
  successRoll,
  contest,
  rangeChoices,
  clone,
} from '../scripts/rules.mjs';
import { upgrade } from '../scripts/workflow.mjs';
import { readChase, chaseDocuments } from '../scripts/store.mjs';
import { applyCommand } from '../scripts/engine.mjs';
import { renderTracker } from '../scripts/view.mjs';
const gm = { id: 'gm', isGM: true },
  player = { id: 'player', isGM: false };
function saved() {
  const s = newChase('Saved <chase>');
  s.status = 'running';
  s.phase = 'range';
  s.participants = [
    newParticipant({ id: 'q', skill: 15, stealth: 20 }),
    newParticipant({ id: 'p', side: 'pursuer', skill: 15 }),
  ];
  for (const [side, id] of [
    ['quarry', 'q'],
    ['pursuer', 'p'],
  ])
    Object.assign(s.sides[side], {
      leader: id,
      declaration: { key: 'move' },
      roll: successRoll(20, 12),
    });
  s.result = contest(s);
  return s;
}
function cmd(s, type, data = {}, user = gm) {
  return applyCommand(s, { type, epoch: s.epoch, revision: s.revision, ...data }, user);
}
test('documented both-failed Hide convention can offer escape without a shift threshold', () => {
  const s = saved();
  s.sides.quarry.declaration.key = 'hide';
  s.sides.quarry.roll = successRoll(20, 18);
  s.sides.pursuer.roll = successRoll(11, 14);
  const r = contest(s);
  assert.equal(r.type, 'hideWin');
  assert.equal(r.margin, 2);
  assert.ok(rangeChoices(s, r).some((x) => x.key === 'escape'));
  const next = cmd(s, 'range', { choice: 'escape' });
  assert.equal(next.status, 'ended');
});
test('documented both-failed moving contest can grant the automatic failure a range shift', () => {
  const s = saved();
  s.sides.quarry.roll = successRoll(26, 18);
  s.sides.pursuer.roll = successRoll(11, 17);
  const r = contest(s);
  assert.equal(r.winner, 'quarry');
  assert.equal(r.margin, 5);
  assert.equal(r.steps, 1);
  const next = cmd(s, 'range', { choice: 'open-1' });
  assert.equal(next.band, 3);
});
test('range recompute failures preserve originals, pause, remove stale results and render safely', () => {
  for (const damage of [
    (s) => (s.sides.quarry.declaration = null),
    (s) => (s.sides.pursuer.declaration = { key: 'unknown' }),
    (s) => (s.sides.pursuer.roll.total = 99),
    (s) => (s.sides.quarry.leader = 'missing'),
    (s) => (s.participants[0].speed = 'bad'),
    (s) => (s.sides.quarry.extra = 'bad'),
  ]) {
    const raw = saved();
    damage(raw);
    const before = clone(raw),
      s = upgrade(raw);
    assert.deepEqual(raw, before);
    assert.equal(s.status, 'paused');
    assert.equal(s.result, null);
    assert.equal(s.recovery.kind, 'round');
    assert.deepEqual(s.recovery.original, before);
    assert.deepEqual(upgrade(s), s);
    assert.deepEqual(upgrade(JSON.parse(JSON.stringify(s))), s);
    const html = renderTracker({ state: s, user: gm });
    assert.match(html, /recovery required/);
    assert.match(html, /GM outcome \/ end chase/);
    assert.doesNotMatch(html, /data-do="resume"|data-do="range"|data-do="roll"/);
  }
});
test('structurally damaged records stay discoverable without exposing normal editing or progression', () => {
  for (const damage of [
    (s) => (s.participants = null),
    (s) => (s.sides = {}),
    (s) => (s.checks = null),
    (s) => (s.log = {}),
    (s) => (s.pendingCrew = {}),
    (s) => (s.workflow.approved = null),
    (s) => (s.participants[0] = null),
  ]) {
    const raw = saved();
    damage(raw);
    const doc = {
      id: 'doc',
      name: 'Chase · Original',
      getFlag: () => JSON.stringify(raw),
      testUserPermission: () => true,
    };
    globalThis.game = { user: gm, journal: [doc] };
    const s = readChase(doc);
    assert.equal(s.recovery.kind, 'data');
    assert.deepEqual(s.recovery.original, raw);
    assert.equal(chaseDocuments().length, 1);
    const html = renderTracker({ state: s, user: gm, documents: [doc] });
    assert.match(html, /Download original saved data/);
    assert.doesNotMatch(html, /data-do="override"|data-do="edit"|data-do="resume"/);
    assert.throws(
      () => cmd(s, 'override', { band: 2, end: true, reason: 'Cannot fabricate missing data' }),
      /recovery/,
    );
  }
});
test('malformed JSON retains exact original text while ordinary journals remain excluded', () => {
  const text = '{"schema":1, broken';
  const s = readChase({ name: 'Chase · Broken', getFlag: () => text });
  assert.equal(s.recovery.original, text);
  assert.equal(s.name, 'Broken');
  assert.equal(readChase({ getFlag: () => null }), null);
  assert.equal(readChase({ getFlag: () => '{}' }), null);
});
test('recovery rejects stale or player commands and requires an explicit reason', () => {
  const raw = saved();
  raw.sides.quarry.declaration = null;
  const s = upgrade(raw);
  for (const type of ['resume', 'roll', 'range', 'actionsDone', 'restart'])
    assert.throws(() => cmd(s, type), /saved round/);
  assert.throws(
    () => cmd(s, 'override', { band: 2, end: true, reason: 'End' }, player),
    /Only a GM/,
  );
  assert.throws(() => cmd(s, 'override', { band: 2 }), /reason/);
});
test('GM recovery advances once, retains original data, and Undo restores the recovery prompt', () => {
  const raw = saved();
  raw.sides.quarry.declaration = null;
  const s = upgrade(raw);
  const next = cmd(s, 'override', { band: 3, reason: 'Resolve the damaged round at Long' });
  assert.equal(next.round, 2);
  assert.equal(next.band, 3);
  assert.equal(next.status, 'running');
  assert.equal(next.recovery, undefined);
  assert.equal(next.outcomeRequired, '');
  assert.deepEqual(next.recoveryArchive.original, raw);
  assert.equal(next.sides.quarry.roll, null);
  assert.equal(next.sides.pursuer.declaration, null);
  const undo = cmd(next, 'undo');
  assert.equal(undo.status, 'paused');
  assert.equal(undo.recovery.kind, 'round');
  assert.deepEqual(undo.recovery.original, raw);
});
test('GM ending a damaged round clears unsafe display values and retains the archive', () => {
  const raw = saved();
  raw.sides.quarry.declaration = { key: 'unknown' };
  const next = cmd(upgrade(raw), 'override', { band: 2, end: true, reason: 'End here' });
  assert.equal(next.status, 'ended');
  assert.equal(next.round, 1);
  assert.equal(next.recovery, undefined);
  assert.equal(next.result, null);
  assert.deepEqual(next.recoveryArchive.original, raw);
  globalThis.game = { user: gm, users: [] };
  assert.doesNotThrow(() => renderTracker({ state: next, user: gm }));
});
test('invalid participant data must be reviewed before a recovery outcome can continue', () => {
  const raw = saved();
  raw.participants[0].speed = -1;
  let s = upgrade(raw);
  assert.equal(s.recovery.kind, 'round');
  assert.throws(() => cmd(s, 'override', { band: 2, reason: 'Continue' }), /Top speed/);
  s = cmd(s, 'participant', { data: { ...s.participants[0], speed: 5 } });
  assert.equal(s.recovery.kind, 'round');
  assert.equal(s.recovery.original.participants[0].speed, -1);
  s = cmd(s, 'override', { band: 2, reason: 'Corrected invalid speed, adjudicated round' });
  assert.equal(s.status, 'running');
  assert.equal(s.participants[0].speed, 5);
});
