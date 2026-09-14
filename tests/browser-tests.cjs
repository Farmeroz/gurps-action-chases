const { createServer } = require('node:http');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve, join, extname } = require('node:path');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const root = resolve(__dirname, '..');
const playwright = require('playwright');
const shell = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles/chases.css"><style>body{margin:0;background:#080f17;color:white;font-family:Arial;padding:20px}.application{width:min(1040px,calc(100vw - 40px));margin:auto;border:1px solid #61717f;border-radius:9px;overflow:hidden;box-shadow:0 15px 70px #0009}.window-header{background:#2b3441;display:flex;justify-content:space-between;align-items:center;height:38px;padding:0 13px;font-size:13px}.window-content{max-height:calc(100vh - 90px);overflow:auto}.gac-editor{position:fixed;top:35px;left:50%;transform:translateX(-50%);width:min(680px,calc(100vw - 30px));z-index:5}.gac-editor .window-content{max-height:calc(100vh - 110px)}button{cursor:pointer}</style></head><body><script type="module" src="/tests/browser-fixture.mjs"></script></body></html>`;
(async () => {
  const server = createServer((req, res) => {
    const path = resolve(root, '.' + req.url.split('?')[0]);
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      return res.end(shell);
    }
    if (!path.startsWith(root + '/')) return res.writeHead(403).end();
    try {
      res.setHeader(
        'Content-Type',
        extname(path) === '.mjs'
          ? 'text/javascript'
          : extname(path) === '.css'
            ? 'text/css'
            : 'text/plain',
      );
      res.end(readFileSync(path));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let browser;
  const results = [];
  const pass = (name) => {
    results.push(name);
    console.log('PASS', name);
  };
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      executablePath: process.env.GCS_CHROMIUM_EXECUTABLE || undefined,
    });
    const page = await browser.newPage({ viewport: { width: 1320, height: 1120 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const click = async (selector) => {
      const el = page.locator(selector).first();
      await el.evaluate((node) => {
        for (let p = node.parentElement; p; p = p.parentElement)
          if (p.tagName === 'DETAILS') p.open = true;
      });
      await el.click();
    };
    await page.getByRole('button', { name: 'Create example chase' }).click();
    await page.locator('.gac-person').first().waitFor();
    assert.equal(await page.locator('.gac-person').count(), 4);
    pass('create example with ad hoc vehicle, operator and passenger');
    await page.locator('[data-do="configure"]').evaluate((node) => {
      node.closest('details').open = true;
    });
    await page.locator('[data-do="configure"]').focus();
    await page.getByRole('tooltip').waitFor();
    assert.match(await page.getByRole('tooltip').textContent(), /combat timing/);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('tooltip').count(), 0);
    pass('keyboard help explains chase controls and dismisses without changing state');

    await click('[data-do="edit"]');
    await page.locator('[name="name"]').fill('Getaway van <img src=x onerror=alert(1)>');
    await page.locator('.gac-editor [type="submit"]').click();
    await page.locator('.gac-editor').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.gac-person img').count(), 0);
    pass('escape participant names instead of injecting HTML');
    await click('[data-do="edit"]');
    await page.locator('[name="name"]').fill('Getaway van');
    await page.locator('.gac-editor [type="submit"]').click();
    await page.locator('.gac-editor').waitFor({ state: 'detached' });
    await page.locator('[data-do="start"]').click();
    await page.locator('[data-do="declare"][data-side="quarry"]').click();
    await page.locator('[name="key"]').selectOption('moveAttack');
    await page.locator('.gac-editor [type="submit"]').click();
    await page.locator('.gac-editor').waitFor({ state: 'detached' });
    await page.locator('[data-do="declare"][data-side="pursuer"]').click();
    await page.locator('[name="key"]').selectOption('move');
    await page.locator('.gac-editor [type="submit"]').click();
    await page.locator('.gac-editor').waitFor({ state: 'detached' });
    pass('quarry declaration then pursuer response through actual UI');
    await page.locator('[data-do="task"][data-task^="passenger:"]').click();
    await page.locator('[name="action"]').selectOption('Attack');
    await page.locator('[name="mode"]').selectOption('external');
    await page.locator('[name="note"]').fill('Covering fire at the pursuing bike');
    await page.locator('.gac-editor [type="submit"]').click();
    await page.locator('.gac-editor').waitFor({ state: 'detached' });
    await page.locator('[data-do="task"][data-task^="finish:"]').click();
    await page.locator('[name="note"]').fill('Defence and damage resolved.');
    await page.locator('.gac-editor [type="submit"]').click();
    await page.locator('.gac-editor').waitFor({ state: 'detached' });
    pass('passenger result and GM consequence use the task workflow');
    await page.locator('[data-do="actionsDone"]').click();
    assert.equal(await page.locator('.gac-editor').count(), 0);
    await page.locator('[data-do="roll"][data-side="quarry"]').click();
    await page.locator('[data-do="roll"][data-side="pursuer"]').click();
    await page.locator('[data-do="range"]').first().waitFor();
    assert.equal(await page.locator('.gac-roll').count(), 2);
    pass('actions gate, dice, contest and range controls work');
    mkdirSync(join(root, 'tests', 'artifacts'), { recursive: true });
    await page.screenshot({ path: join(root, 'tests', 'artifacts', 'tracker.png') });
    await page.locator('[data-do="range"]').first().click();
    await page.waitForFunction(
      () => JSON.parse([...game.journal][0].getFlag('gurps-action-chases', 'data')).round === 2,
    );
    pass('applying range advances once and clears per-round actions');
    await click('[data-do="undo"]');
    await page.waitForFunction(
      () =>
        JSON.parse([...game.journal][0].getFlag('gurps-action-chases', 'data')).phase === 'range',
    );
    pass('GM undo restores previous resolution');
    await page.locator('[data-do="pause"]').click();
    await click('[data-do="edit"]');
    await page.locator('[name="controller:alice"]').check();
    await page.locator('.gac-editor [type="submit"]').click();
    await page.locator('.gac-editor').waitFor({ state: 'detached' });
    pass('assign player control directly to an ad hoc vehicle');
    // Observer view: the harness switches the current user, without pretending it is a real second Foundry session.
    await page.evaluate(() => {
      game.user = game.users.get('alice');
      game.modules.get('gurps-action-chases').api.open();
    });
    await page.waitForFunction(() => !document.querySelector('[data-do="configure"]'));
    assert.equal(await page.locator('[data-do="edit"]').count(), 0);
    pass('player view removes GM editing controls');
    await page.evaluate(() => {
      game.user = game.users.get('gm');
      game.modules.get('gurps-action-chases').api.open();
    });
    await page.locator('[data-do="configure"]').waitFor({ state: 'attached' });
    await click('[data-do="edit"]');
    await page.screenshot({ path: join(root, 'tests', 'artifacts', 'participant-editor.png') });
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll('.gac-edit-form input,.gac-edit-form select')].some(
        (el) =>
          el.getBoundingClientRect().right >
          document.querySelector('.gac-editor').getBoundingClientRect().right,
      ),
    );
    assert.equal(overflow, false);
    pass('participant editor fields stay within the window');
    await page.locator('[data-cancel]').click();
    await page.setViewportSize({ width: 700, height: 1000 });
    await page.screenshot({ path: join(root, 'tests', 'artifacts', 'narrow-tracker.png') });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
    );
    pass('narrow viewport has no horizontal page overflow');
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => fixtureErrors), []);
    pass('no JavaScript errors or unexpected notifications');
    writeFileSync(
      join(root, 'tests', 'artifacts', 'browser-results.json'),
      JSON.stringify(
        {
          environment:
            'Chromium, mocked Foundry ApplicationV2 / document lifecycle. Not a live Foundry world.',
          passed: results.length,
          checks: results,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser?.close();
    await new Promise((r) => server.close(r));
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
