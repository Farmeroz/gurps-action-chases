import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createHelpController, helpResolver } from '../scripts/tooltip-engine.mjs';
const tick = (ms = 35) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture() {
  const { document, window } = parseHTML(
    '<html><body><section class="owned"><form><input id="first"><button data-action="apply" title="Apply" aria-describedby="existing"><i></i></button><p role="alert">Review before applying</p></form></section><button id="other" title="Unrelated">Other</button></body></html>',
  );
  const button = document.querySelector('button');
  button.getBoundingClientRect = () => ({ left: 12, top: 20, bottom: 40 });
  let enabled = true,
    definition;
  globalThis.game = {
    settings: {
      get: () => enabled,
      register: (_id, _key, value) => {
        definition = value;
      },
    },
  };
  const resolve = helpResolver({
    id: 'test-module',
    actions: { apply: 'Apply <reviewed> values.' },
  });
  const controller = createHelpController({
    id: 'test-module',
    scope: '.owned',
    resolve,
    delay: 10,
  });
  controller.register();
  controller.start(document);
  return {
    document,
    window,
    button,
    controller,
    definition,
    disable: () => {
      enabled = false;
      definition.onChange(false);
    },
  };
}
test('client preference defaults on, applies immediately, and preserves accessible names and alerts', async () => {
  const f = fixture();
  assert.equal(f.definition.scope, 'client');
  assert.equal(f.definition.default, true);
  assert.equal(f.button.getAttribute('aria-label'), 'Apply');
  assert.equal(f.button.hasAttribute('title'), false);
  assert.equal(f.document.querySelector('#other').getAttribute('title'), 'Unrelated');
  f.button.dispatchEvent(new f.window.Event('focus'));
  await tick();
  assert.ok(f.document.querySelector('[role="tooltip"]'));
  f.disable();
  assert.equal(f.document.querySelector('[role="tooltip"]'), null);
  f.button.dispatchEvent(new f.window.Event('mouseenter'));
  await tick();
  assert.equal(f.document.querySelector('[role="tooltip"]'), null);
  assert.equal(f.button.getAttribute('aria-label'), 'Apply');
  assert.equal(f.document.querySelector('[role="alert"]').textContent, 'Review before applying');
});
test('focus and hover use escaped text, preserve descriptions, dismiss on Escape, and never apply actions', async () => {
  const f = fixture();
  let applied = 0;
  f.button.addEventListener('click', () => applied++);
  f.controller.attach(f.document.querySelector('.owned'));
  f.controller.attach(f.document.querySelector('.owned'));
  f.button.dispatchEvent(new f.window.Event('focus'));
  await tick();
  assert.equal(f.document.querySelectorAll('[role="tooltip"]').length, 1);
  assert.equal(
    f.document.querySelector('[role="tooltip"]').textContent,
    'Apply <reviewed> values.',
  );
  assert.equal(f.document.querySelector('reviewed'), null);
  assert.match(f.button.getAttribute('aria-describedby'), /^existing test-module-help-/);
  const event = new f.window.Event('keydown', { bubbles: true });
  event.key = 'Escape';
  f.button.dispatchEvent(event);
  assert.equal(f.document.querySelector('[role="tooltip"]'), null);
  assert.equal(f.button.getAttribute('aria-describedby'), 'existing');
  f.button.dispatchEvent(new f.window.Event('mouseenter'));
  await tick();
  f.button.dispatchEvent(new f.window.Event('mouseleave'));
  assert.equal(f.document.querySelector('[role="tooltip"]'), null);
  assert.equal(applied, 0);
});
test('dynamic controls receive help, removed targets clean up, and quick hover cannot leave a tooltip behind', async () => {
  const f = fixture();
  f.button.dispatchEvent(new f.window.Event('mouseenter'));
  f.button.dispatchEvent(new f.window.Event('mouseleave'));
  await tick();
  assert.equal(f.document.querySelector('[role="tooltip"]'), null);
  const added = f.document.createElement('button');
  added.dataset.help = 'New control';
  added.textContent = 'New';
  added.getBoundingClientRect = f.button.getBoundingClientRect;
  f.document.querySelector('.owned').append(added);
  await tick();
  added.dispatchEvent(new f.window.Event('focus'));
  await tick();
  assert.equal(f.document.querySelector('[role="tooltip"]').textContent, 'New control');
  added.remove();
  await tick();
  assert.equal(f.document.querySelector('[role="tooltip"]'), null);
  assert.equal(added.getAttribute('aria-describedby'), null);
});
test('indexed native forms are not mistaken for jQuery wrappers', () => {
  const f = fixture();
  const form = f.document.querySelector('form');
  form[0] = form.querySelector('input');
  f.controller.attach(form);
  assert.equal(f.button.dataset.helpOwner, 'test-module');
});
