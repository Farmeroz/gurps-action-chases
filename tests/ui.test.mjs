import test from 'node:test';
import assert from 'node:assert/strict';
import { newChase, newParticipant, ID } from '../scripts/rules.mjs';
import { applyCommand } from '../scripts/engine.mjs';
import { queue, execute } from '../scripts/store.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let parseHTML;
try {
  ({ parseHTML } = require(process.env.GAC_TEST_DOM_PATH || 'linkedom'));
} catch {}
test('rendered controls and ApplicationV2 lifecycle harness', { skip: !parseHTML }, async (t) => {
  const { window } = parseHTML('<!doctype html><html><body></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  // LinkeDOM lacks the browser's checked/defaultChecked reflection.
  const checkedState = new WeakMap();
  Object.defineProperty(window.HTMLInputElement.prototype, 'checked', {
    configurable: true,
    get() {
      return checkedState.has(this) ? checkedState.get(this) : this.hasAttribute('checked');
    },
    set(value) {
      checkedState.set(this, !!value);
    },
  });
  globalThis.FormData = class {
    constructor(form) {
      this.data = [...form.querySelectorAll('input,select,textarea')]
        .filter((x) => x.name && !x.disabled && (x.type !== 'checkbox' || x.checked))
        .map((x) => [x.name, x.type === 'checkbox' ? 'on' : (x.value ?? '')]);
    }
    [Symbol.iterator]() {
      return this.data[Symbol.iterator]();
    }
  };
  window.HTMLElement.prototype.reportValidity = () => true;
  await import('./browser-fixture.mjs');
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  const click = async (selector) => {
    const el = document.querySelector(selector);
    assert.ok(el, `Missing control ${selector}`);
    assert.ok(!el.disabled, `Disabled control ${selector}`);
    el.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flush();
  };
  const fill = (name, value) => {
    const el = document.querySelector(`.gac-editor [name="${name}"]`);
    assert.ok(el, `Missing field ${name}`);
    if (el.tagName === 'SELECT') {
      for (const o of el.options) o.removeAttribute('selected');
      [...el.options].find((o) => o.value === value)?.setAttribute('selected', '');
    } else el.value = value;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const save = async () => {
    const form = document.querySelector('.gac-editor form');
    assert.ok(form);
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const error = document.querySelector('.gac-error:not([hidden])');
    assert.equal(error?.textContent ?? '', '');
  };
  const state = () => JSON.parse([...game.journal][0].getFlag('gurps-action-chases', 'data'));
  await flush();
  await t.test('example creates a persistent ad hoc roster', async () => {
    await click('[data-do="demo"]');
    assert.equal(document.querySelectorAll('.gac-person').length, 4);
    assert.equal(state().participants.filter((p) => p.actorUuid).length, 0);
  });
  await t.test('participant form fields and save handler preserve entered values', async () => {
    await click('[data-do="edit"]');
    fill('name', 'Van <img src=x onerror=alert(1)>');
    fill('skill', '16');
    await save();
    assert.equal(state().participants[0].name, 'Van <img src=x onerror=alert(1)>');
    assert.equal(state().participants[0].skill, 16);
    assert.equal(document.querySelectorAll('.gac-person img').length, 0);
  });
  await t.test('declaration sequence runs through rendered forms', async () => {
    await click('[data-do="start"]');
    await click('[data-do="declare"][data-side="quarry"]');
    fill('key', 'moveAttack');
    await save();
    assert.equal(state().phase, 'pursuer');
    await click('[data-do="declare"][data-side="pursuer"]');
    fill('key', 'move');
    await save();
    assert.equal(state().phase, 'actions');
  });
  await t.test('passenger controls save a separate action', async () => {
    await click('[data-do="task"][data-task^="passenger:"]');
    fill('action', 'Attack');
    fill('mode', 'external');
    fill('note', 'Covering fire');
    await save();
    await click('[data-do="task"][data-task^="finish:"]');
    fill('note', 'Defence and damage resolved.');
    await save();
    assert.equal(Object.values(state().passengerActions)[0].action, 'Attack');
  });
  await t.test('GM confirmation unlocks actual Chase Roll buttons', async () => {
    await click('[data-do="actionsDone"]');
    assert.equal(document.querySelector('.gac-editor'), null);
    assert.equal(state().phase, 'chase');
    await click('[data-do="roll"][data-side="quarry"]');
    await click('[data-do="roll"][data-side="pursuer"]');
    assert.equal(state().phase, 'range');
    assert.equal(document.querySelectorAll('.gac-roll').length, 2);
  });
  await t.test('one range click advances exactly one round after many re-renders', async () => {
    await click('[data-do="range"]');
    assert.equal(state().round, 2);
    assert.equal(state().phase, 'quarry');
    assert.deepEqual(state().passengerActions, {});
  });
  await t.test('undo restores the prior range-resolution state', async () => {
    await click('[data-do="undo"]');
    assert.equal(state().round, 1);
    assert.equal(state().phase, 'range');
  });
  await t.test('player view hides GM controls and shows only authorised actions', async () => {
    game.user = game.users.get('alice');
    game.modules.get('gurps-action-chases').api.open();
    await flush();
    assert.equal(document.querySelectorAll('[data-do="configure"],[data-do="edit"]').length, 0);
    game.user = game.users.get('gm');
    game.modules.get('gurps-action-chases').api.open();
    await flush();
  });
  await t.test('closing and reopening reloads the persistent chase', async () => {
    const before = state();
    const app = game.modules.get('gurps-action-chases').api.open();
    await flush();
    await app.close();
    game.modules.get('gurps-action-chases').api.open();
    await flush();
    assert.deepEqual(state(), before);
    assert.equal(document.querySelectorAll('.gac-person').length, 4);
  });
  const scenario = async (q = 'move', p = 'move', kind = 'character') => {
    game.user = game.users.get('gm');
    let value = newChase('Form test');
    value.participants = [
      newParticipant({ id: 'q', kind, name: 'Quarry', skill: 14, controllers: ['alice'] }),
      newParticipant({ id: 'p', kind, name: 'Pursuer', side: 'pursuer', skill: 14 }),
    ];
    value.sides.quarry.leader = 'q';
    value.sides.pursuer.leader = 'p';
    if (q) {
      for (const c of [
        { type: 'start' },
        { type: 'declare', side: 'quarry', data: { key: q, penalty: -2 } },
        { type: 'declare', side: 'pursuer', data: { key: p, penalty: -2 } },
      ])
        value = applyCommand(
          value,
          { ...c, epoch: value.epoch, revision: value.revision },
          game.user,
        );
    }
    const doc = [...game.journal][0];
    await doc.update({ [`flags.${ID}.data`]: JSON.stringify(value) });
    await flush();
    return doc;
  };
  await t.test('common manoeuvres and Continue work directly without opening forms', async () => {
    await scenario(null);
    await click('[data-do="start"]');
    await click('[data-do="quickDeclare"][data-side="quarry"][data-key="move"]');
    await click('[data-do="quickDeclare"][data-side="pursuer"][data-key="move"]');
    await click('[data-do="actionsDone"]');
    assert.equal(document.querySelector('.gac-editor'), null);
    assert.equal(state().phase, 'chase');
  });
  await t.test(
    'calculation and log details default closed and retain expansion after updates',
    async () => {
      const log = document.querySelector('[data-persist="log"]');
      assert.ok(!log.open);
      assert.ok(!document.querySelector('[data-persist="calculation-quarry"]').open);
      log.open = true;
      await click('[data-do="roll"][data-side="quarry"]');
      assert.equal(document.querySelector('[data-persist="log"]').open, true);
    },
  );
  await t.test('post-setup settings omit locked fields', async () => {
    await click('[data-do="configure"]');
    assert.equal(document.querySelector('.gac-editor [name="band"]'), null);
    assert.equal(document.querySelector('.gac-editor [name="blind"]'), null);
    fill('name', 'Updated');
    await save();
    assert.equal(state().name, 'Updated');
  });
  await t.test(
    'managed stunt form records dice and consequence form supplies missing SR',
    async () => {
      await scenario('stunt', 'move', 'vehicle');
      await click('[data-do="task"][data-task="scene:quarry"]');
      await save();
      await click('[data-do="task"][data-task="stunt:q"]');
      fill('target', '8');
      await save();
      assert.equal(state().checks[0].total, 10);
      assert.equal(state().checks[0].pending, true);
      await click('[data-do="task"][data-task^="consequence:"]');
      fill('sr', '3');
      assert.match(document.querySelector('[data-consequence-preview]').textContent, /close call/);
      await save();
      assert.equal(state().checks[0].total, 10);
      assert.equal(state().participants[0].status, 'closeCall');
      assert.equal(state().checks[0].reviewed, true);
    },
  );
  await t.test('manoeuvre fields disclose stunt risk only when relevant', async () => {
    await scenario(null);
    await click('[data-do="start"]');
    await click('[data-do="declare"][data-side="quarry"]');
    assert.equal(document.querySelector('[data-stunt]').hidden, true);
    assert.equal(document.querySelector('[name="penalty"]').disabled, true);
    fill('key', 'stunt');
    assert.equal(document.querySelector('[data-stunt]').hidden, false);
    fill('key', 'hide');
    assert.match(document.querySelector('[data-requirements]').textContent, /Stealth/);
    assert.equal(document.querySelector('[data-operator-choice]').hidden, true);
    await click('.gac-editor [data-cancel]');
  });
  await t.test('actor import selects skill, reviews fields and saves in one window', async () => {
    await scenario(null);
    const actor = {
      id: 'actor',
      uuid: 'Actor.actor',
      name: 'Runner actor',
      testUserPermission: () => true,
      system: {
        attributes: { DX: { value: 12 }, HT: { value: 10 } },
        basicmove: { value: 6 },
        skills: {
          a: { name: 'Running', level: 13, relativelevel: 'HT+3' },
          b: { name: 'Climbing', level: 14, relativelevel: 'DX+2' },
        },
      },
    };
    game.actors.set(actor.id, actor);
    await click('[data-do="actor"]');
    assert.equal(document.querySelectorAll('.gac-editor').length, 1);
    assert.equal(document.querySelector('[name="skill"]').value, '15');
    fill('sourceSkill', '1');
    assert.equal(document.querySelector('[name="skill"]').value, '14');
    fill('name', 'Reviewed runner');
    await save();
    assert.equal(state().participants.at(-1).name, 'Reviewed runner');
    assert.equal(state().participants.at(-1).actorUuid, 'Actor.actor');
    assert.equal(document.querySelectorAll('.gac-editor').length, 0);
  });
  await t.test(
    'crew dialog replaces driver in one operation and retains vehicle grouping',
    async () => {
      const doc = await scenario('move', 'move', 'vehicle'),
        value = state();
      value.participants.push(
        newParticipant({
          id: 'driver',
          name: 'Old driver',
          transportId: 'q',
          role: 'operator',
          skill: 12,
        }),
        newParticipant({ id: 'new', name: 'New driver', transportId: 'q', skill: 17 }),
      );
      await doc.update({ [`flags.${ID}.data`]: JSON.stringify(value) });
      await flush();
      await click('[data-id="q"] [data-do="crew"]');
      fill('personId', 'new');
      fill('vehicleId', 'q');
      fill('role', 'operator');
      fill('when', 'now');
      await save();
      assert.equal(state().participants.find((p) => p.id === 'driver').role, 'passenger');
      assert.match(
        document.querySelector('[data-id="q"] .gac-person-stats').textContent,
        /New driver/,
      );
      assert.equal(document.querySelectorAll('.gac-crew .gac-person').length, 2);
    },
  );
  await t.test(
    'embarkation of an ad hoc vehicle permits creating its driver in the same form',
    async () => {
      await scenario('embark', 'move', 'vehicle');
      await click('[data-do="task"][data-task="scene:quarry"]');
      await save();
      await click('[data-do="task"][data-task="embark:q"]');
      assert.match(document.querySelector('[name="personId"]').value, /^new:/);
      assert.equal(document.querySelector('[data-new-crew]').hidden, false);
      fill('newName', 'Van driver');
      fill('vehicleId', '');
      fill('footSkill', '12');
      await save();
      const person = state().participants.find((p) => p.name === 'Van driver');
      assert.ok(person);
      assert.equal(person.transportId, 'q');
      assert.equal(state().pendingCrew[0].vehicleId, '');
    },
  );
  await t.test(
    'rejected player form remains open with its draft; accepted retry closes it',
    async () => {
      const doc = await scenario(null);
      let value = state();
      value = applyCommand(value, { type: 'start', epoch: value.epoch }, game.user);
      await doc.update({ [`flags.${ID}.data`]: JSON.stringify(value) });
      game.user = game.users.get('alice');
      game.modules.get(ID).api.open();
      await flush();
      await click('[data-do="declare"][data-side="quarry"]');
      fill('key', 'stunt');
      fill('notes', 'Jump the canal');
      const root = document.querySelector('.gac-editor form');
      root.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      assert.ok(document.querySelector('.gac-editor'));
      assert.equal(root.querySelector('[type="submit"]').disabled, true);
      assert.match(document.querySelector('.gac-feedback').textContent, /Sending/);
      let request = [...game.messages].findLast((m) => m.getFlag(ID, 'request'));
      game.user = game.users.get('gm');
      await request.update({
        [`flags.${ID}.receipt`]: {
          ok: false,
          by: 'gm',
          nonce: request.getFlag(ID, 'request').nonce,
          error: 'Scene changed; review your choice.',
        },
      });
      game.user = game.users.get('alice');
      await flush();
      assert.ok(document.querySelector('.gac-editor'));
      assert.equal(document.querySelector('[name="notes"]').value, 'Jump the canal');
      assert.match(document.querySelector('.gac-error').textContent, /Scene changed/);
      assert.equal(root.querySelector('[type="submit"]').disabled, false);
      root.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      request = [...game.messages].findLast((m) => m.getFlag(ID, 'request'));
      game.user = game.users.get('gm');
      Hooks.call('createChatMessage', request, {}, 'alice');
      await queue(async () => {});
      game.user = game.users.get('alice');
      await flush();
      assert.equal(document.querySelector('.gac-editor'), null);
      assert.equal(state().sides.quarry.declaration.key, 'stunt');
      game.user = game.users.get('gm');
      game.modules.get(ID).api.open();
      await flush();
    },
  );
  await t.test(
    'missing driver resolves through the actual replacement and wreck forms',
    async () => {
      const doc = await scenario('move', 'move', 'vehicle'),
        value = state();
      value.participants.push(
        newParticipant({
          id: 'driver',
          name: 'Alex',
          transportId: 'q',
          role: 'operator',
          skill: 15,
        }),
        newParticipant({ id: 'sam', name: 'Sam', transportId: 'q', skill: 13 }),
      );
      await doc.update({ [`flags.${ID}.data`]: JSON.stringify(value) });
      await flush();
      await click('[data-id="driver"] [data-do="condition"]');
      fill('status', 'out');
      await save();
      assert.match(document.querySelector('.gac-next').textContent, /vehicle control/);
      assert.match(
        document.querySelector('[data-id="q"] .gac-person-stats').textContent,
        /No active driver/,
      );
      await click('[data-do="task"][data-task="driver:q"]');
      fill('personId', 'sam');
      fill('note', 'Sam takes the wheel.');
      await save();
      assert.equal(state().participants.find((p) => p.id === 'q').dueRound, 2);
      assert.equal(state().participants.find((p) => p.id === 'sam').role, 'operator');
      assert.ok(state().log.some((x) => x.text.includes('Sam takes the wheel.')));
      await click('[data-id="sam"] [data-do="condition"]');
      fill('status', 'out');
      await save();
      await click('[data-do="task"][data-task="driver:q"]');
      fill('resolution', 'wreck');
      fill('note', 'Wreck and injury resolved.');
      await save();
      assert.equal(state().participants.find((p) => p.id === 'q').status, 'wreck');
    },
  );
  await t.test(
    'late leader form offers next round and keeps original dice until the outcome',
    async () => {
      const doc = await scenario(),
        value = state();
      value.participants.push(newParticipant({ id: 'backup', name: 'Replacement' }));
      await doc.update({ [`flags.${ID}.data`]: JSON.stringify(value) });
      await flush();
      await click('[data-do="actionsDone"]');
      await click('[data-do="roll"][data-side="quarry"]');
      await click('[data-do="roll"][data-side="pursuer"]');
      const original = state().sides.quarry.roll;
      await click('[data-do="leader"][data-side="quarry"]');
      assert.equal(document.querySelector('[name="when"]').options.length, 1);
      fill('id', 'backup');
      await save();
      assert.deepEqual(state().sides.quarry.roll, original);
      assert.equal(state().sides.quarry.leader, 'q');
      assert.match(
        document.querySelector('.gac-team.quarry').textContent,
        /Leader next round: Replacement/,
      );
      await click('[data-do="range"]');
      assert.equal(state().sides.quarry.leader, 'backup');
    },
  );
  await t.test(
    'foot stunt UI starts blank without a real skill and confirms minimum feat difficulty',
    async () => {
      await scenario('stunt');
      assert.match(document.querySelector('.gac-team.quarry').textContent, /Stunt pending/);
      await click('[data-do="task"][data-task="scene:quarry"]');
      assert.equal(document.querySelector('[name="minimumPenalty"]').value, '');
      fill('minimumPenalty', '-2');
      await save();
      await click('[data-do="task"][data-task="stunt:q"]');
      assert.equal(document.querySelector('[name="target"]').value, '');
      assert.equal(document.querySelector('[name="stuntSkill"]').value, '');
      fill('stuntSkill', 'jumping');
      fill('target', '12');
      await save();
      assert.equal(state().checks[0].stuntSkill, 'jumping');
      assert.doesNotMatch(document.querySelector('.gac-team.quarry').textContent, /Stunt pending/);
    },
  );
  await t.test(
    'ad hoc disembarkation reviews foot skill and follows the departing crew at the boundary',
    async () => {
      await scenario('embark', 'move', 'vehicle');
      await click('[data-do="task"][data-task="scene:quarry"]');
      await save();
      await click('[data-do="task"][data-task="embark:q"]');
      fill('newName', 'Courier');
      fill('vehicleId', '');
      assert.equal(document.querySelector('[data-foot]').hidden, false);
      fill('footSkillName', 'DX');
      fill('footSkill', '13');
      fill('note', 'Leave the van in the alley.');
      await save();
      const person = state().participants.find((p) => p.name === 'Courier');
      await click('[data-do="actionsDone"]');
      await click('[data-do="roll"][data-side="quarry"]');
      await click('[data-do="roll"][data-side="pursuer"]');
      await click('[data-do="range"]');
      assert.equal(state().participants.find((p) => p.id === 'q').status, 'out');
      assert.equal(state().sides.quarry.leader, person.id);
      assert.match(
        document.querySelector(`[data-id="${person.id}"] .gac-person-stats`).textContent,
        /DX 13/,
      );
    },
  );
  await t.test('hostile passenger attack form uses host manoeuvre modifiers', async () => {
    const doc = await scenario('moveAttack', 'move', 'vehicle'),
      value = state();
    value.participants.push(
      newParticipant({ id: 'boarder', name: 'Boarder', side: 'pursuer', transportId: 'q' }),
    );
    await doc.update({ [`flags.${ID}.data`]: JSON.stringify(value) });
    await flush();
    await click('[data-do="task"][data-task="passenger:boarder"]');
    fill('action', 'Attack');
    fill('target', '18');
    fill('acc', '5');
    assert.equal(document.querySelector('[name="bulk"]').disabled, true);
    assert.equal(document.querySelector('[data-bulk]').hidden, true);
    assert.match(document.querySelector('[data-attack-rule]').textContent, /flat −1/);
    fill('mode', 'manual');
    assert.equal(document.querySelector('[name="bulk"]').disabled, true);
    assert.match(
      document.querySelector('[data-attack-preview]').textContent,
      /movement -1, Acc \+0/,
    );
    fill('mode', 'external');
    fill('note', 'Resolved aboard the hostile van.');
    await save();
    assert.equal(state().workflow.outcomes['passenger:boarder'].group, 'quarry');
  });
  await t.test('setup rules choices save and become read-only after Start chase', async () => {
    await scenario(null);
    await click('[data-do="configure"]');
    fill('speedRounding', 'table');
    fill('driverShots', 'passengers');
    await save();
    assert.deepEqual(state().ruleOptions, { speedRounding: 'table', driverShots: 'passengers' });
    await click('[data-do="start"]');
    await click('[data-do="configure"]');
    assert.equal(document.querySelector('[name="speedRounding"]'), null);
    assert.match(document.querySelector('.gac-editor').textContent, /table rounding/);
    await click('.gac-editor [data-cancel]');
  });
  await t.test(
    'ordinary operator attack keeps Bulk editable and applies the entered penalty',
    async () => {
      const doc = await scenario('moveAttack', 'move', 'vehicle'),
        value = state();
      value.sides.quarry.declaration.operatorAttacks = true;
      await doc.update({ [`flags.${ID}.data`]: JSON.stringify(value) });
      await flush();
      await click('[data-do="task"][data-task="attack:q"]');
      assert.equal(document.querySelector('[name="bulk"]').disabled, false);
      fill('target', '18');
      fill('bulk', '-6');
      assert.match(document.querySelector('[data-attack-preview]').textContent, /movement -6/);
      fill('mode', 'manual');
      fill('total', '16');
      await save();
      assert.equal(state().workflow.outcomes['attack:q'].result.modifiers.movement, -6);
      const gdoc = await scenario('moveAttack', 'move', 'vehicle'),
        gs = state();
      gs.participants[0].gunslinger = true;
      gs.sides.quarry.declaration.operatorAttacks = true;
      await gdoc.update({ [`flags.${ID}.data`]: JSON.stringify(gs) });
      await flush();
      await click('[data-do="task"][data-task="attack:q"]');
      assert.equal(document.querySelector('[name="bulk"]').disabled, true);
      assert.match(document.querySelector('[data-attack-rule]').textContent, /Gunslinger ignores/);
      await click('.gac-editor [data-cancel]');
      await scenario('embark', 'move', 'vehicle');
      await click('[data-do="task"][data-task="scene:quarry"]');
      await save();
      await click('[data-do="task"][data-task="attack:q"]');
      fill('acc', '4');
      assert.match(document.querySelector('[data-attack-rule]').textContent, /Embark is static/);
      assert.match(
        document.querySelector('[data-attack-preview]').textContent,
        /movement -2, Acc \+0/,
      );
      await click('.gac-editor [data-cancel]');
    },
  );
  await t.test(
    'saved automatic failure displays its corrected margin when the tracker reopens',
    async () => {
      const doc = await scenario(),
        value = state();
      value.phase = 'range';
      value.sides.quarry.roll = { target: 25, total: 17, margin: 8, success: false };
      value.sides.pursuer.roll = { target: 22, total: 16, margin: 6, success: true };
      value.result = { type: 'shift', winner: 'quarry', margin: 2, steps: 0 };
      await doc.update({ [`flags.${ID}.data`]: JSON.stringify(value) });
      await flush();
      assert.match(
        document.querySelector('.gac-team.quarry .gac-roll').textContent,
        /Contest margin -1/,
      );
      assert.match(document.querySelector('.gac-next').textContent, /Contest margin 7/);
    },
  );
  await t.test(
    'damaged saved round opens recovery and a GM outcome restores normal play',
    async () => {
      const doc = await scenario(),
        value = state();
      value.phase = 'range';
      value.sides.quarry.roll = { target: 20, total: 12, margin: 8, success: true };
      value.sides.pursuer.roll = { target: 20, total: 14, margin: 6, success: true };
      value.sides.quarry.declaration = null;
      await doc.update({ [`flags.${ID}.data`]: JSON.stringify(value) });
      await flush();
      assert.match(document.querySelector('.gac-next').textContent, /recovery required/);
      assert.ok(document.querySelector('[data-do="exportRecovery"]'));
      assert.equal(document.querySelector('[data-do="resume"]'), null);
      assert.deepEqual(state(), value); // Reading/rendering recovery never overwrites the Journal.
      game.user = game.users.get('alice');
      game.modules.get(ID).api.open();
      await flush();
      assert.equal(document.querySelector('[data-do="override"]'), null);
      assert.match(document.querySelector('.gac-shell').textContent, /Waiting for the GM/);
      game.user = game.users.get('gm');
      game.modules.get(ID).api.open();
      await flush();
      await click('[data-do="override"]');
      fill('reason', 'Keep Medium and continue after reviewing the saved rolls.');
      await save();
      assert.equal(state().round, 2);
      assert.equal(state().recovery, undefined);
      assert.deepEqual(state().recoveryArchive.original, value);
      assert.ok(document.querySelector('[data-do="quickDeclare"]'));
      await click('[data-do="undo"]');
      assert.match(document.querySelector('.gac-next').textContent, /recovery required/);
    },
  );
  await t.test('structural damage remains in the picker with a safe recovery screen', async () => {
    const doc = await scenario(),
      value = state();
    value.participants = null;
    await doc.update({ [`flags.${ID}.data`]: JSON.stringify(value) });
    await flush();
    assert.ok(
      [...document.querySelector('[data-chase-picker]').options].some((o) => o.value === doc.id),
    );
    assert.match(document.querySelector('.gac-shell').textContent, /cannot safely reconstruct/);
    assert.equal(document.querySelector('[data-do="override"]'), null);
    assert.ok(document.querySelector('[data-do="exportRecovery"]'));
    assert.deepEqual(state(), value);
  });
  await t.test('no unexpected runtime notifications', () => {
    assert.deepEqual(fixtureErrors, []);
  });
});
