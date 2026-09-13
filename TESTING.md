# Testing

Start with the setup commands in [CONTRIBUTING.md](CONTRIBUTING.md).

## Automated coverage

Recovered tests cover chase rules, declarations, contests, crew actions, permissions, request authentication, concurrent/stale commands, undo, saved-state upgrades, damaged-data recovery, and UI workflows. Chromium checks exercise an example chase, editing, declarations, tasks, rolls, range changes, undo, and narrow layout with mocked Foundry documents.

The suite exercises these behaviours but does not claim complete coverage or reproduce a connected Foundry world. All automated cases should run; the standard test command treats skipped Node tests as a failure. Test output is saved under `test-output/`; browser diagnostics also use `tests/artifacts/` or `tests/results.json`.

## Source fixtures

No external source download is needed. Setup confirms that the suite uses its local fixtures or mocks.

## Live check

Open an existing chase, create an example chase, enter declarations and crew actions, roll a contest, apply a range change, and undo. Check a player request and the saved chase after reopening.

Use your normal Foundry/GGA versions and module combination, and refresh connected clients after updating. Record unexpected notifications, visibility changes, or changed resource totals, together with the module versions and steps to reproduce them.

## Package verification

The build checks module/package versions, install URLs, declared assets, local imports, the allowed archive file list, and every archived file's bytes. The release ZIP contains only runtime files, the licence, and user documentation.
