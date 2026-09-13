# Contributing

Use Node.js 22 or later and npm, from the repository root.

```sh
npm ci
npm run test:setup
npx playwright install chromium
npm run check
```

On Linux, `npx playwright install --with-deps chromium` also installs operating-system dependencies. Set `GCS_CHROMIUM_EXECUTABLE` to use an existing compatible Chromium executable.

No Foundry installation or world is required for the standard automated checks. A licensed live world remains a separate integration environment.

## Commands

| Command                | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `npm run format`       | Format supported source, test, and documentation files.             |
| `npm run format:check` | Check formatting without changing files.                            |
| `npm run check:syntax` | Parse runtime code, test entry points, and tools.                   |
| `npm test`             | Run the automated suite; unexpected skipped tests fail the command. |
| `npm run test:browser` | Run the Chromium workflow checks.                                   |
| `npm run build`        | Build and verify the clean ZIP and manifest in `dist/`.             |
| `npm run check`        | Run all formatting, syntax, test, and build checks.                 |

## Editing and releases

Keep formatting-only changes separate from behaviour changes. Prettier is pinned in the lockfile. Foundry Handlebars templates and attributed third-party fixtures are excluded from formatting. Runtime console calls use `scripts/log.mjs`; pass the original error object to preserve stack traces, and keep user notifications at their call sites.

Pull requests run the checks and attach the verified package. Merging to `main` repeats the checks and publishes a new version only after they pass. The release consumes the verified artifact and does not replace an existing release.

For a release, update `module.json`, `package.json`, the versioned manifest download URL, and any runtime version constant. Run `npm install --package-lock-only` to synchronise the lockfile. Preserve saved-data schema versions unless the data format changes.

`tools/package-files.json` is the explicit list of user files. Add new runtime assets to it. Tests, contributor documentation, package files, build tools, caches, and workflows stay out of the user ZIP. Keep `node_modules/`, `.cache/`, `test-output/`, and `dist/` out of git.

See [TESTING.md](TESTING.md) for coverage, source setup, and live checks.
