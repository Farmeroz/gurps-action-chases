import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
let count = 0;
for (const directory of ['scripts', 'tests', 'tools']) {
  for (const name of await readdir(new URL(directory + '/', root))) {
    if (!/\.[cm]?js$/.test(name)) continue;
    const run = spawnSync(
      process.execPath,
      ['--check', fileURLToPath(new URL(`${directory}/${name}`, root))],
      { stdio: 'inherit' },
    );
    if (run.status !== 0) process.exit(run.status ?? 1);
    count++;
  }
}
console.log(`Syntax checked ${count} JavaScript files.`);
