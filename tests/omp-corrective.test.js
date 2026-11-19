import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { wireOmpBridge, ompPluginsRoot } from '../targets/omp-bridge.js';

function fixture(t, policy = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rsc omp audit '));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, '.rsc.json'), JSON.stringify({ targets: ['omp'], onboarding: { plan: { policy } } }));
  wireOmpBridge(root, policy);
  const subdir = join(root, 'nested folder');
  mkdirSync(subdir);
  return { root, git, subdir };
}

async function load(root, api = {}) {
  const handlers = new Map();
  const { default: factory } = await import(pathToFileURL(join(root, '.rsc', 'omp-bridge.mjs')).href);
  await factory({ ...api, on: (event, handler) => handlers.set(event, handler) });
  return handlers;
}

const bash = (command, cwd) => ({ toolName: 'bash', input: { command, cwd } });

test('Ship evaluates the checkout from the root, a subdirectory and a linked worktree', async t => {
  const { root, git, subdir } = fixture(t);
  const commit = (...args) => git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', ...args);
  commit('-m', 'base');
  git('switch', '-c', 'feature');
  commit('-m', 'local work');
  const call = (await load(root)).get('tool_call');
  assert.match((await call(bash('git switch main'), { cwd: root }))?.reason ?? '', /feature/);
  assert.match((await call(bash('git switch main'), { cwd: subdir }))?.reason ?? '', /feature/);
  const worktree = join(root, '.worktrees', 'linked checkout');
  git('worktree', 'add', '-b', 'worktree-feature', worktree, 'feature');
  assert.match((await call(bash('git switch main', worktree), { cwd: root }))?.reason ?? '', /worktree-feature/);
  assert.match((await call(bash('git switch main', pathToFileURL(worktree).href), { cwd: root }))?.reason ?? '', /worktree-feature/);
});

test('Expected critical scripts fail closed, while explicit policy choices apply', async t => {
  const { root } = fixture(t, { codeHooks: false, dangerGuard: true });
  const call = (await load(root)).get('tool_call');
  const ctx = { cwd: root };
  assert.equal(await call(bash('git status'), ctx), undefined);
  const guard = join(root, '.rsc', 'danger-guard.mjs');
  rmSync(guard);
  assert.match((await call(bash('git status'), ctx))?.reason ?? '', /danger-guard\.mjs.*rsc sync/);
  writeFileSync(join(root, '.rsc', '.no-danger-guard'), '');
  assert.equal(await call(bash('git status'), ctx), undefined);
  rmSync(join(root, '.rsc', '.no-danger-guard'));
  writeFileSync(guard, 'throw new Error("invalid guard");');
  assert.match((await call(bash('git status'), ctx))?.reason ?? '', /danger-guard\.mjs.*rsc sync/);
});

test('A nested harness applies its own policy and cannot disable the enclosing checkout', async t => {
  const { root, subdir } = fixture(t);
  execFileSync('git', ['init', '-q', subdir]);
  const policy = { codeHooks: false, dangerGuard: false };
  writeFileSync(join(subdir, '.rsc.json'), JSON.stringify({ targets: ['omp'], onboarding: { plan: { policy } } }));
  const call = (await load(root)).get('tool_call');
  rmSync(join(root, '.rsc', 'ship-guard.mjs'));
  assert.equal(await call(bash('git status', subdir), { cwd: root }), undefined);
  assert.match((await call(bash('git status'), { cwd: root }))?.reason ?? '', /ship-guard\.mjs.*rsc sync/);
});

test('Plan checks tool provenance and rejects custom and MCP mutations', async t => {
  const { root } = fixture(t);
  const tools = [
    { name: 'glob', sourceInfo: { source: 'builtin' } },
    { name: 'read', sourceInfo: { source: 'extension' } },
  ];
  const call = (await load(root, { getAllTools: () => tools })).get('tool_call');
  const ctx = { cwd: root, sessionModes: { getState: () => ({ plan: 'active' }) } };
  assert.equal(await call({ toolName: 'glob' }, ctx), undefined);
  for (const toolName of ['read', 'apply_patch', 'mcp__storage_delete']) {
    assert.equal((await call({ toolName }, ctx))?.block, true, toolName);
  }
});

test('Delivery cannot inherit authorization from a headless host or an ask timeout', async t => {
  const { root } = fixture(t);
  const handlers = await load(root);
  const ctx = {
    cwd: root, agent: { kind: 'main' }, hasUI: false,
    ui: { approve: () => assert.fail('headless approval') },
  };
  const call = handlers.get('tool_call');
  for (const command of ['git push', 'gh pr create', 'git merge feature']) {
    assert.match((await call(bash(command), ctx))?.reason ?? '', /confirm publishing or merging/);
  }
  assert.equal(await call(bash('echo "git push"'), ctx), undefined);
  assert.match((await handlers.get('tool_result')({ toolName: 'ask', details: { timedOut: true } }, ctx))
    ?.additionalContext ?? '', /NOT explicit approval/);
});

test('The journal closes the old session on switch and ignores intermediate settles', async t => {
  const { root } = fixture(t);
  const events = join(root, 'lifecycle.jsonl');
  writeFileSync(join(root, '.rsc', 'session-memory-adapter.mjs'), `
    import { appendFileSync } from 'node:fs';
    export function handleLifecycle({ event, native }) {
      appendFileSync(${JSON.stringify(events)}, JSON.stringify([event, native.session_id]) + '\\n');
    }
  `);
  const handlers = await load(root);
  const context = id => ({ cwd: root, sessionManager: { getSessionId: () => id } });
  const first = context('first');
  const resumed = context('resumed');
  const emit = (event, payload, ctx) => handlers.get(event)(payload, ctx);
  await emit('session_start', {}, first);
  await emit('agent_end', { awaitingAsyncWork: true }, first);
  await emit('agent_end', { willContinue: true }, first);
  await emit('session_stop', {}, { ...first, agent: { kind: 'sub' } });
  await emit('session_stop', {}, first);
  await emit('agent_end', {}, first);
  await emit('session_switch', { reason: 'resume' }, resumed);
  await emit('session_clear', {}, resumed);
  await emit('turn_start', {}, resumed);
  await emit('session_before_compact', {}, resumed);
  await emit('session_shutdown', {}, resumed);
  await emit('session_shutdown', {}, resumed);
  const log = readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log, [
    ['start', 'first'], ['turn', 'first'], ['end', 'first'], ['start', 'resumed'],
    ['start', 'resumed'], ['compact', 'resumed'], ['end', 'resumed'],
  ]);
});

test('A custom agent directory keeps the default-profile plugin registry outside XDG', t => {
  const { root } = fixture(t);
  const env = { HOME: root, XDG_DATA_HOME: join(root, 'data'), PI_CODING_AGENT_DIR: join(root, 'custom agent') };
  mkdirSync(join(env.XDG_DATA_HOME, 'omp'), { recursive: true });
  assert.equal(ompPluginsRoot(env), join(root, '.omp', 'plugins'));
});

test('Sync preserves a project hook owned by the operator', t => {
  const { root } = fixture(t);
  const loader = join(root, '.omp', 'hooks', 'pre', 'rsc.js');
  writeFileSync(loader, '// personal extension\n');
  assert.equal(wireOmpBridge(root).reason, 'loader-collision');
  assert.equal(readFileSync(loader, 'utf8'), '// personal extension\n');
});

test('A guard timeout or malformed decision names the broken script', async t => {
  const { root } = fixture(t, { codeHooks: false });
  const previous = process.env.RSC_OMP_GUARD_TIMEOUT;
  process.env.RSC_OMP_GUARD_TIMEOUT = '1000';
  let handlers;
  try {
    handlers = await load(root);
  } finally {
    if (previous === undefined) delete process.env.RSC_OMP_GUARD_TIMEOUT;
    else process.env.RSC_OMP_GUARD_TIMEOUT = previous;
  }
  const guard = join(root, '.rsc', 'danger-guard.mjs');
  const call = () => handlers.get('tool_call')(bash('git status'), { cwd: root });
  writeFileSync(guard, 'process.stdout.write("invalid-json");');
  assert.match((await call())?.reason ?? '', /danger-guard\.mjs.*invalid decision.*rsc sync/);
  writeFileSync(guard, 'setInterval(() => {}, 100);');
  assert.match((await call())?.reason ?? '', /danger-guard\.mjs.*timed out.*rsc sync/);
});

test('The launch directory can specialize project plugin settings', async t => {
  const { root, subdir } = fixture(t);
  mkdirSync(join(subdir, '.omp'));
  writeFileSync(join(root, '.omp', 'plugin-overrides.json'), JSON.stringify({
    settings: { 'rsc-harness': { guards: false, native: false } },
  }));
  writeFileSync(join(subdir, '.omp', 'plugin-overrides.json'), JSON.stringify({
    settings: { 'rsc-harness': { guards: true } },
  }));
  const { readPluginSwitches } = await import('../targets/omp-bridge.mjs');
  const switches = readPluginSwitches({ HOME: root }, root, subdir);
  assert.equal(switches.guards, true);
  assert.equal(switches.native, false);
});
