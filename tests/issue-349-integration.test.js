import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readPolicy, matchPolicyRules } from '../targets/risk-policy.mjs';
import * as sello from '../targets/sello.mjs';
import { branchCheck, reposWithPush } from '../targets/asdd-gate.mjs';
import { specCompleteness } from '../targets/spec-completeness.mjs';
import { ompBridgeModuleNames, wireOmpBridge } from '../targets/omp-bridge.js';

const git = (d, ...args) => execFileSync('git', ['-C', d, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const write = (d, path, text) => {
  mkdirSync(dirname(join(d, path)), { recursive: true });
  writeFileSync(join(d, path), text);
};
function repo(branch = 'main') {
  const d = temp('rsc-349i-');
  initRepo(d, branch);
  return d;
}
function initRepo(d, branch = 'main') {
  mkdirSync(d, { recursive: true });
  git(d, 'init', '-qb', branch);
  git(d, 'config', 'user.email', 't@example.com');
  git(d, 'config', 'user.name', 'Test');
  write(d, 'a.txt', 'initial');
  git(d, 'add', '.');
  git(d, 'commit', '-qm', 'initial');
}

test('integration · CRLF diff lines still match end-anchored content rules', () => {
  const rows = [{ class: 'auth', tier: 2, added: '^const secret = token;$' }];
  const details = {
    'app.js': {
      before: '',
      after: 'const secret = token;\r\n',
      status: 'M',
      added: ['const secret = token;\r'],
      removed: [],
    },
  };
  const matched = matchPolicyRules(rows, ['app.js'], details, { 'app.js': '' }, {});
  assert.deepEqual(matched['app.js'], [0], 'the \\r of a CRLF line is not part of the content');
});

test('integration · the push scanner expands ~ and $HOME like the shell', () => {
  const home = temp('rsc-349i-home-');
  const homeRepo = join(home, 'repo');
  initRepo(homeRepo);
  const outside = temp('rsc-349i-out-');
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const expected = realpathSync(homeRepo);
    assert.deepEqual(reposWithPush('cd ~/repo && git push', outside), [expected]);
    assert.deepEqual(reposWithPush('git -C ~/repo push', outside), [expected]);
    assert.deepEqual(reposWithPush('cd $HOME/repo && git push', outside), [expected]);
    assert.deepEqual(reposWithPush('git -C "$HOME/repo" push', outside), [expected]);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('integration · risk.rules and per-repository testRepos reach the effective config', () => {
  const d = repo();
  write(d, '.rsc-risk.json', JSON.stringify({
    version: 1,
    risk: { rules: [{ class: 'schema', tier: 2, path: '\\.al$' }] },
    rules: [{ class: 'api', tier: 2, path: '^\\.Page\\.al$' }],
    repositories: { '.': { testRepos: ['.'] } },
  }));
  const policy = readPolicy(d, { preview: true });
  assert.equal(policy.error, null);
  assert.deepEqual(policy.config.risk.rules.map((r) => r.class), ['schema', 'api']);
  assert.equal(policy.config.testRepo, true, 'repositories[*].testRepos marks the repo as a test repo');
});

test('integration · the sello candidate checks both paths of a rename', () => {
  const d = repo();
  write(d, 'a.al', 'table 1 X {}\n');
  git(d, 'add', '.');
  git(d, 'commit', '-qm', 'table');
  git(d, 'switch', '-qc', 'feat/rename');
  git(d, 'mv', 'a.al', 'b.al');
  const candidate = sello.computeCandidate(d);
  assert.ok(candidate, 'trunk found');
  assert.ok(Object.hasOwn(candidate.files, 'a.al'), 'the old path is part of the candidate');
  assert.ok(Object.hasOwn(candidate.files, 'b.al'), 'the new path is part of the candidate');
  assert.equal(candidate.files['a.al'], 'D');
  rmSync(d, { recursive: true, force: true });
});

test('integration · the OMP installer manages risk-policy.mjs like its importers', () => {
  assert.ok(ompBridgeModuleNames({}).includes('risk-policy.mjs'));
});

test('integration · branchCheck reads the policy from the workspace when rooted in a submodule', () => {
  const ws = repo();
  write(ws, '.rsc-risk.json', JSON.stringify({
    version: 1,
    rules: [{ class: 'schema', tier: 2, path: '\\.al$' }],
  }));
  git(ws, 'add', '.');
  git(ws, 'commit', '-qm', '🔧 policy');
  const sub = repo();
  git(ws, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'Catman');
  git(ws, 'commit', '-qm', '🔧 submodule');
  const cat = join(ws, 'Catman');
  git(cat, 'config', 'user.email', 't@example.com');
  git(cat, 'config', 'user.name', 'Test');
  git(cat, 'switch', '-qc', 'feat/x');
  write(cat, 'x.al', 'table 1 X {}\n');
  git(cat, 'add', '.');
  git(cat, 'commit', '-qm', '🐛 table');
  const why = branchCheck(cat, cat, { sello, specCompleteness }, { strict: true });
  assert.match(why || '', /risk tier 2/, 'the parent workspace policy raises the submodule branch to tier 2');
  rmSync(ws, { recursive: true, force: true });
  rmSync(sub, { recursive: true, force: true });
});

test('integration · a narrower OMP plan keeps the shared risk-policy module', () => {
  const d = temp('rsc-349i-omp-');
  mkdirSync(join(d, '.rsc'), { recursive: true });
  writeFileSync(join(d, '.rsc', 'risk-policy.mjs'), '// shared with claude\n');
  const result = wireOmpBridge(d, { codeHooks: false });
  assert.ok(existsSync(join(d, '.rsc', 'risk-policy.mjs')), 'Claude\'s reaper import survives a codeHooks:false OMP plan');
  assert.ok(!result.removed.includes(join(d, '.rsc', 'risk-policy.mjs')));
  rmSync(d, { recursive: true, force: true });
});

test('integration · home expansion keeps replacement patterns in HOME literal', () => {
  const home = temp('rsc-349i-$&-');
  const homeRepo = join(home, 'repo');
  initRepo(homeRepo);
  const outside = temp('rsc-349i-out-');
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const expected = realpathSync(homeRepo);
    assert.deepEqual(reposWithPush('git -C ~/repo push', outside), [expected]);
    assert.deepEqual(reposWithPush('git -C $HOME/repo push', outside), [expected]);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
