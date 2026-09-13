import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const config = JSON.parse(await readFile(new URL('tools/test-sources.json', root), 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function prepareSources() {
  for (const source of config) {
    const hashes = {};
    for (const path of source.files) {
      const url = `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${path}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok)
        throw new Error(`Cannot fetch ${source.repository}/${path}: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const target = new URL(`.cache/${source.directory}/${path}`, root);
      await mkdir(new URL('.', target), { recursive: true });
      await writeFile(target, bytes);
      hashes[path] = digest(bytes);
    }
    await writeFile(
      new URL(`.cache/${source.directory}/source-lock.json`, root),
      JSON.stringify({ commit: source.commit, hashes }, null, 2) + '\n',
    );
    console.log(`Prepared ${source.repository} ${source.version} at ${source.commit}.`);
  }
  if (!config.length)
    console.log('No external test sources are required; the tests use local fixtures or mocks.');
}

export async function testEnvironment() {
  const env = { ...process.env };
  for (const source of config) {
    if (env[source.environment]) {
      env[source.environment] = resolve(env[source.environment]);
      for (const path of source.files) await access(resolve(env[source.environment], path));
      continue;
    }
    const directory = new URL(`.cache/${source.directory}/`, root);
    try {
      const lock = JSON.parse(await readFile(new URL('source-lock.json', directory), 'utf8'));
      if (lock.commit !== source.commit)
        throw new Error('Cached revision differs from the configured source.');
      for (const path of source.files) {
        if (digest(await readFile(new URL(path, directory))) !== lock.hashes[path])
          throw new Error(`Cached ${path} changed.`);
      }
    } catch (error) {
      throw new Error(
        `Test sources are missing or changed. Run npm run test:setup. ${error.message}`,
      );
    }
    env[source.environment] = fileURLToPath(directory);
  }
  return env;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareSources();
