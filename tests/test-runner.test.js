// test-runner.test.js — the runner owns the scratch root, and that contract is what makes the
// other test files safe to leak into it. A regression here is invisible until a machine runs out
// of disk, so it is asserted directly: the root is empty afterwards, on pass AND on failure, and
// an ambient TMPDIR is not the one used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'run-tests.mjs');

// A fixture that leaves a temp tree behind, exactly like the test files that do.
const fixture = (expected) => `
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('writes scratch', () => {
  mkdtempSync(join(tmpdir(), 'rsc-fixture-'));
  assert.equal(1, ${expected});
});
`;

// One root holding the runner's base, an ambient decoy, and the fixture file.
function scenario(expected) {
  const root = mkdtempSync(join(tmpdir(), 'rsc-runner-test-'));
  const base = join(root, 'base');
  const decoy = join(root, 'decoy');
  mkdirSync(base);
  mkdirSync(decoy);
  const file = join(root, 'fixture.test.js');
  writeFileSync(file, fixture(expected));
  return { root, base, decoy, file };
}

function run({ base, decoy, file }) {
  return spawnSync(process.execPath, [RUNNER, file], {
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: decoy, RSC_TEST_TMPDIR: base },
  });
}

test('a green run exits 0 and leaves no scratch root behind', (t) => {
  const s = scenario(1);
  t.after(() => rmSync(s.root, { recursive: true, force: true }));
  const result = run(s);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(s.base), [], 'the runner left its scratch root on disk');
  assert.deepEqual(readdirSync(s.decoy), [], 'the ambient TMPDIR was used instead of the own base');
});

test('a red run still exits non-zero and cleans up', (t) => {
  const s = scenario(2);
  t.after(() => rmSync(s.root, { recursive: true, force: true }));
  const result = run(s);
  assert.notEqual(result.status, 0, 'a failing fixture was reported as success');
  assert.deepEqual(readdirSync(s.base), [], 'a failing run left its scratch root on disk');
});
