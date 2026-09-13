import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { zipSync, unzipSync } from 'fflate';

const root = new URL('../', import.meta.url);
const manifestBytes = await readFile(new URL('module.json', root));
const manifest = JSON.parse(manifestBytes);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const repository = 'Farmeroz/gurps-action-chases';
const tag = `v${manifest.version}`;
const archiveName = `${manifest.id}-${tag}.zip`;
assert.equal(manifest.id, 'gurps-action-chases');
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(pkg.version, manifest.version, 'Package and module versions must match.');
assert.equal(manifest.url, `https://github.com/${repository}`);
assert.equal(
  manifest.manifest,
  `https://github.com/${repository}/releases/latest/download/module.json`,
);
assert.equal(
  manifest.download,
  `https://github.com/${repository}/releases/download/${tag}/${archiveName}`,
);

// Explicitly list shipped files: development files cannot enter a release by accident.
const files = JSON.parse(await readFile(new URL('tools/package-files.json', root), 'utf8'));
for (const path of [
  ...(manifest.esmodules || []),
  ...(manifest.styles || []),
  ...(manifest.languages || []).map((item) => item.path),
  manifest.readme,
  manifest.license,
].filter(Boolean)) {
  assert.ok(files.includes(path), `Missing manifest entry in package: ${path}`);
}
const inputs = {};
assert.ok(
  files.every((path) => !/(^|\/)(tests|tools|node_modules|development|\.github)(\/|$)/.test(path)),
  'Development files cannot be shipped.',
);
for (const path of files) {
  const bytes = await readFile(new URL(path, root));
  inputs[`${manifest.id}/${path}`] = bytes;
  if (/\.[cm]?js$/.test(path)) {
    for (const match of bytes
      .toString()
      .matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
      const dependency = new URL(match[1], new URL(path, root));
      if (dependency.href.startsWith(root.href)) {
        assert.ok(
          files.includes(dependency.href.slice(root.href.length)),
          `Missing local import from ${path}: ${match[1]}`,
        );
      }
    }
  }
}
const archive = zipSync(inputs, { level: 9, mtime: new Date(1980, 0, 1) });
const contents = unzipSync(archive);
assert.deepEqual(Object.keys(contents).sort(), Object.keys(inputs).sort());
for (const [path, bytes] of Object.entries(inputs))
  assert.deepEqual(Buffer.from(contents[path]), bytes, path);
const dist = new URL('dist/', root);
await mkdir(dist, { recursive: true });
await writeFile(new URL(archiveName, dist), archive);
await writeFile(new URL('module.json', dist), manifestBytes);

console.log(
  `Built and verified dist/${archiveName}: ${files.length} user files, ${archive.length} bytes.`,
);
