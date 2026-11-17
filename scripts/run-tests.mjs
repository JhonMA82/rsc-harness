#!/usr/bin/env node
// run-tests.mjs — one scratch root per run, removed on every exit path.
//
// The name must not match Node's own test-file globs (`test-*.mjs`): `node --test` would execute
// this file as a test, it would spawn `node --test` without arguments, and the runner would call
// itself forever. `run-tests.mjs` is outside every default pattern.
//
// Why this exists: test files build their fixtures with
// `mkdtempSync(join(tmpdir(), 'rsc-…'))` and 71 of 114 never remove them. One full pass leaves
// ~2300 directories and ~155k files (2.0 GB measured); the next pass over that litter dies with
// ENOSPC inside whichever test happened to call mkdtemp. Rather than add cleanup to 71 files —
// and miss the 72nd written next week — the root itself is owned here and deleted at the end.
//
// The base is chosen, not inherited. An ambient TMPDIR under `$HOME` would put every fixture
// below `~/.claude/CLAUDE.md`, and `targets/agents-md-shadow.js` walks ancestors on purpose: it
// would refuse to plant the shadow and `tests/agents-md-shadow.test.js` would fail with no hint
// that the environment was the variable. /var/tmp keeps the suite off a small tmpfs and out of
// $HOME. RSC_TEST_TMPDIR overrides the base explicitly for a machine that knows better.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function scratchBase() {
  const explicit = process.env.RSC_TEST_TMPDIR;
  if (explicit) {
    if (!statSync(explicit, { throwIfNoEntry: false })?.isDirectory()) {
      console.error(`test-runner: RSC_TEST_TMPDIR is not a directory: ${explicit}`);
      process.exit(2);
    }
    return explicit;
  }
  try {
    accessSync('/var/tmp', constants.W_OK);
    if (statSync('/var/tmp').isDirectory()) return '/var/tmp';
  } catch {
    // No /var/tmp (Windows, a locked-down container): fall back to the platform temp dir.
  }
  return tmpdir();
}

let root = null;
function cleanup() {
  if (!root) return;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // A scratch root we could not delete must not turn a passing suite into a failing one.
  }
  root = null;
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

root = mkdtempSync(join(scratchBase(), 'rsc-tests-'));
const env = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
// `node --test` exports NODE_TEST_CONTEXT to the files it runs. Pass it on and a nested run
// reports success no matter what the fixture does — measured: a deliberately failing fixture
// exits 0 with it set and 1 without. The runner is a plain parent, not a test file.
delete env.NODE_TEST_CONTEXT;
const child = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
cleanup();
process.exit(child.status ?? 1);
