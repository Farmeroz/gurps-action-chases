import test from 'node:test';
import assert from 'node:assert/strict';
import { ID, newChase, newParticipant } from '../scripts/rules.mjs';
import {
  execute,
  queue,
  readChase,
  installStoreHooks,
  submit,
  submissionStatus,
} from '../scripts/store.mjs';
const gm = { id: 'gm', name: 'GM', isGM: true, active: true },
  gm2 = { id: 'gm2', name: 'Other GM', isGM: true, active: true },
  player = { id: 'player', name: 'Player', isGM: false, active: true };
let rollCount = 0,
  saveCount = 0;
class Collection extends Map {
  [Symbol.iterator]() {
    return this.values();
  }
}
function environment() {
  const users = new Collection([
    [gm.id, gm],
    [gm2.id, gm2],
    [player.id, player],
  ]);
  users.activeGM = gm;
  const s = newChase('Network test');
  s.participants = [
    newParticipant({ id: 'q', controllers: ['player'] }),
    newParticipant({ id: 'p', side: 'pursuer' }),
  ];
  s.sides.quarry.leader = 'q';
  s.sides.pursuer.leader = 'p';
  const doc = {
    id: 'journal',
    data: JSON.stringify(s),
    getFlag: () => (JSON.parse(doc.data).schema ? doc.data : null),
    testUserPermission: () => true,
    async update(change) {
      saveCount++;
      if (change[`flags.${ID}.data`]) doc.data = change[`flags.${ID}.data`];
    },
  };
  globalThis.game = {
    user: gm,
    users,
    journal: new Collection([['journal', doc]]),
    messages: new Collection(),
  };
  globalThis.ui = { notifications: { warn: () => {} } };
  globalThis.Roll = class {
    async evaluate() {
      rollCount++;
      this.total = 10;
      return this;
    }
    async toMessage() {}
  };
  globalThis.fromUuidSync = () => null;
  return doc;
}
async function command(doc, type, data = {}, user = gm, id = '') {
  const s = readChase(doc);
  return execute(doc, { type, epoch: s.epoch, revision: s.revision, ...data }, user, id);
}
test('serial requests preserve both declarations and reject a duplicate roll', async () => {
  rollCount = 0;
  const doc = environment();
  await command(doc, 'start');
  await Promise.all([
    queue(() => command(doc, 'declare', { side: 'quarry', data: { key: 'move' } }, player)),
    queue(() => command(doc, 'declare', { side: 'pursuer', data: { key: 'move' } }, gm)),
  ]);
  assert.equal(readChase(doc).phase, 'actions');
  await command(doc, 'actionsDone', { confirmed: true });
  const results = await Promise.allSettled([
    queue(() => command(doc, 'roll', { side: 'quarry' }, player)),
    queue(() => command(doc, 'roll', { side: 'quarry' }, player)),
  ]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(rollCount, 1);
});
test('unauthorised roll requests neither roll dice nor save data', async () => {
  const doc = environment();
  await command(doc, 'start');
  await command(doc, 'declare', { side: 'quarry', data: { key: 'move' } });
  await command(doc, 'declare', { side: 'pursuer', data: { key: 'move' } });
  await command(doc, 'actionsDone', { confirmed: true });
  rollCount = 0;
  const old = doc.data;
  await assert.rejects(() => command(doc, 'roll', { side: 'pursuer' }, player), /control/);
  assert.equal(rollCount, 0);
  assert.equal(doc.data, old);
});
test('only the active GM applies world writes', async () => {
  const doc = environment();
  game.user = gm2;
  await assert.rejects(() => command(doc, 'start'), /active GM/);
  game.user = gm;
});
test('JSON persistence clears removed keys rather than merging old passenger actions', async () => {
  const doc = environment();
  let s = readChase(doc);
  s.passengerActions = { old: { action: 'Attack' } };
  doc.data = JSON.stringify(s);
  await command(doc, 'start');
  assert.deepEqual(readChase(doc).passengerActions, {});
});
test('private commitments reject edited payloads at reveal', async () => {
  const doc = environment();
  let s = readChase(doc);
  s.blind = true;
  doc.data = JSON.stringify(s);
  await command(doc, 'start');
  for (const [side, id, key] of [
    ['quarry', 'rq', 'move'],
    ['pursuer', 'rp', 'attack'],
  ]) {
    const state = readChase(doc),
      c = { type: 'declare', epoch: state.epoch, revision: state.revision, side, data: { key } };
    const request = { docId: doc.id, command: c, nonce: crypto.randomUUID() };
    game.messages.set(id, { getFlag: () => request });
    await execute(doc, c, gm, id);
  }
  assert.equal(readChase(doc).sides.pursuer.declaration, null);
  game.messages.get('rp').getFlag().command.data.key = 'move';
  await assert.rejects(() => command(doc, 'reveal'), /missing or changed/);
});
test('private commitments reveal when their original messages remain intact', async () => {
  const doc = environment();
  let s = readChase(doc);
  s.blind = true;
  doc.data = JSON.stringify(s);
  await command(doc, 'start');
  for (const [side, id, key] of [
    ['quarry', 'rq', 'move'],
    ['pursuer', 'rp', 'attack'],
  ]) {
    const state = readChase(doc),
      c = { type: 'declare', epoch: state.epoch, revision: state.revision, side, data: { key } };
    const request = { docId: doc.id, command: c, nonce: crypto.randomUUID() };
    game.messages.set(id, { getFlag: () => request });
    await execute(doc, c, gm, id);
  }
  await command(doc, 'reveal');
  assert.equal(readChase(doc).phase, 'actions');
  assert.equal(readChase(doc).sides.pursuer.declaration.key, 'attack');
});
test('request transport authenticates creator hook identity, not spoofed payload', async () => {
  const doc = environment(),
    callbacks = {};
  globalThis.Hooks = {
    on: (key, fn) => {
      callbacks[key] = fn;
    },
  };
  installStoreHooks(() => {});
  const s = readChase(doc),
    request = {
      docId: doc.id,
      userId: 'gm',
      command: { type: 'start', epoch: s.epoch, revision: s.revision },
    };
  const message = {
    id: 'spoof',
    getFlag: (key) => request,
    async update(data) {
      this.updated = data;
    },
  };
  callbacks.createChatMessage(message, {}, 'player');
  await queue(async () => {});
  assert.equal(readChase(doc).status, 'setup');
  assert.match(message.updated.content, /Only a GM/);
});

test('managed stunt rolls validate ownership before dice and save exactly one original result', async () => {
  const doc = environment();
  await command(doc, 'start');
  await command(doc, 'declare', { side: 'quarry', data: { key: 'stunt', penalty: -2 } });
  await command(doc, 'declare', { side: 'pursuer', data: { key: 'move' } });
  await command(doc, 'task', { taskId: 'scene:quarry', mode: 'approve', minimumPenalty: -2 });
  rollCount = 0;
  await assert.rejects(
    () =>
      command(
        doc,
        'task',
        { taskId: 'stunt:q', mode: 'roll', target: 12, stuntSkill: 'acrobatics' },
        { id: 'intruder' },
      ),
    /controller/,
  );
  assert.equal(rollCount, 0);
  await command(
    doc,
    'task',
    { taskId: 'stunt:q', mode: 'roll', target: 12, stuntSkill: 'acrobatics' },
    player,
  );
  assert.equal(rollCount, 1);
  assert.equal(readChase(doc).checks[0].total, 10);
  await assert.rejects(
    () =>
      command(
        doc,
        'task',
        { taskId: 'stunt:q', mode: 'roll', target: 12, stuntSkill: 'acrobatics' },
        player,
      ),
    /Already/,
  );
  assert.equal(rollCount, 1);
});
function clientTransport() {
  const doc = environment(),
    callbacks = {};
  globalThis.Hooks = {
    on: (key, fn) => {
      callbacks[key] = fn;
    },
  };
  installStoreHooks(() => {});
  let count = 0,
    message;
  globalThis.ChatMessage = {
    getWhisperRecipients: () => [gm],
    async create(data) {
      count++;
      message = { id: 'client-request', ...data, getFlag: (id, key) => message.flags?.[id]?.[key] };
      return message;
    },
  };
  game.user = player;
  return {
    doc,
    callbacks,
    get count() {
      return count;
    },
    get message() {
      return message;
    },
    receipt(ok, error = '', updater = 'gm') {
      message.flags[ID].receipt = {
        ok,
        error,
        by: updater,
        nonce: message.flags[ID].request.nonce,
      };
      callbacks.updateChatMessage(message, {}, {}, updater);
    },
  };
}
test('player submission waits for authenticated acceptance and deduplicates pending clicks', async () => {
  const env = clientTransport(),
    command = { type: 'note', text: 'Pending test' },
    first = submit(env.doc, command),
    second = submit(env.doc, command);
  assert.equal(first, second);
  assert.equal(env.count, 1);
  let settled = false;
  first.then(() => (settled = true));
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(submissionStatus(env.doc.id).kind, 'pending');
  env.receipt(true, '', 'player');
  await Promise.resolve();
  assert.equal(settled, false);
  env.receipt(true);
  await first;
  assert.equal(submissionStatus(env.doc.id).kind, 'accepted');
  game.user = gm;
});
test('rejected receipt preserves a useful reason for the player form and permits correction', async () => {
  const env = clientTransport(),
    first = submit(env.doc, { type: 'note', text: 'Test' });
  const rejected = assert.rejects(first, /round changed/);
  env.receipt(false, 'The chase round changed. Your entries are retained.');
  await rejected;
  assert.equal(submissionStatus(env.doc.id).kind, 'rejected');
  const retry = submit(env.doc, { type: 'note', text: 'Corrected' });
  assert.equal(env.count, 2);
  env.receipt(true);
  await retry;
  game.user = gm;
});
test('GM invitation uses authenticated creator identity and observer permission', () => {
  const doc = environment(),
    callbacks = {},
    opened = [];
  globalThis.Hooks = { on: (key, fn) => (callbacks[key] = fn) };
  installStoreHooks(
    () => {},
    (id) => opened.push(id),
  );
  game.user = player;
  const message = { getFlag: (id, key) => (key === 'invitation' ? { docId: doc.id } : null) };
  callbacks.createChatMessage(message, {}, 'player');
  assert.deepEqual(opened, []);
  callbacks.createChatMessage(message, {}, 'gm');
  assert.deepEqual(opened, [doc.id]);
  doc.testUserPermission = () => false;
  callbacks.createChatMessage(message, {}, 'gm');
  assert.equal(opened.length, 1);
  game.user = gm;
});
test('different drafts for the same pending action are rejected rather than falsely acknowledged', async () => {
  const env = clientTransport(),
    first = submit(env.doc, { type: 'note', text: 'Original' });
  await assert.rejects(
    () => submit(env.doc, { type: 'note', text: 'Different draft' }),
    /Another submission/,
  );
  assert.equal(env.count, 1);
  env.receipt(true);
  await first;
  game.user = gm;
});

test('high-skill automatic failure publishes the corrected contest margin in chat and log', async () => {
  const doc = environment();
  let s = readChase(doc);
  s.participants[0].skill = 23;
  doc.data = JSON.stringify(s);
  await command(doc, 'start');
  await command(doc, 'declare', { side: 'quarry', data: { key: 'move' } });
  await command(doc, 'declare', { side: 'pursuer', data: { key: 'move' } });
  await command(doc, 'actionsDone', { confirmed: true });
  let flavor = '';
  globalThis.Roll = class {
    async evaluate() {
      this.total = 17;
      return this;
    }
    async toMessage(data) {
      flavor = data.flavor;
    }
  };
  await command(doc, 'roll', { side: 'quarry' });
  assert.match(flavor, /contest margin -1/);
  assert.match(flavor, /minimum success 0 \/ failure 1/);
  assert.match(readChase(doc).log.at(-1).text, /contest margin -1/);
  assert.equal(readChase(doc).sides.quarry.roll.margin, 8);
});
