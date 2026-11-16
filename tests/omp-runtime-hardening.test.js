import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { applyInstall } from '../scripts/install-apply.js';
import { hostAutoApproves, readPluginSwitches } from '../targets/omp-bridge.mjs';

// The bridge reads OMP's machine-level plugin registry at startup. Pin it to a path that does not
// exist so a developer's Settings → Plugins toggles never change what these tests exercise.
process.env.RSC_OMP_PLUGIN_CONFIG = join(mkdtempSync(join(tmpdir(), 'rsc-omp-plugin-config-')), 'none.json');
delete process.env.RSC_OMP_STRICT_PLAN;
delete process.env.RSC_OMP_STRICT_EXEC;

const project = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rsc-omp-policy-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd });
  return cwd;
};
const pluginPath = (cwd) => join(cwd, 'registry.json');

function handlersFor(cwd) {
  return import(pathToFileURL(join(cwd, '.rsc', 'omp-bridge.mjs')).href).then(async ({ default: factory }) => {
    const handlers = new Map();
    await factory({
      pi: { settings: {} },
      on(name, fn) { handlers.set(name, fn); },
      getActiveTools: () => ['read', 'write', 'edit', 'bash', 'eval', 'task'],
    });
    return handlers;
  });
}

function ctx(cwd, mode) {
  return {
    cwd, agent: { kind: 'main' }, hasUI: false, mode: 'tui',
    sessionModes: { getState: () => ({ plan: mode }) },
    sessionManager: { getSessionId: () => 'policy-test', getSessionFile: () => null },
  };
}

test('Plan denies direct mutators and preserves read-only tools', async () => {
  const cwd = project();
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldPlugin = process.env.RSC_NO_OMP_PLUGIN;
  process.env.PI_CODING_AGENT_DIR = join(cwd, 'agent');
  process.env.RSC_NO_OMP_PLUGIN = '1';
  try {
    await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd });
    const handlers = await handlersFor(cwd);
    const call = handlers.get('tool_call');
    assert.equal(typeof call, 'function');
    for (const name of ['write', 'edit', 'bash', 'eval']) {
      const result = await call({ toolName: name, input: { command: 'echo ok', file_path: 'report.md' } }, ctx(cwd, 'active'));
      assert.equal(result?.block, true, `Plan must block ${name}`);
      assert.match(result.reason, /Plan mode/);
    }
    assert.equal(await call({ toolName: 'read', input: { file_path: 'README.md' } }, ctx(cwd, 'active')), undefined);
    assert.equal(await call({ toolName: 'write', input: { file_path: 'README.md' } }, ctx(cwd, 'inactive')), undefined);
  } finally {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldPlugin === undefined) delete process.env.RSC_NO_OMP_PLUGIN;
    else process.env.RSC_NO_OMP_PLUGIN = oldPlugin;
    rmSync(cwd, { force: true, recursive: true });
  }
});

test('Strict exec blocks eval without disabling native task, todo or read tools', async () => {
  const cwd = project();
  const old = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    RSC_NO_OMP_PLUGIN: process.env.RSC_NO_OMP_PLUGIN,
    RSC_OMP_STRICT_EXEC: process.env.RSC_OMP_STRICT_EXEC,
  };
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: join(cwd, 'agent'),
    RSC_NO_OMP_PLUGIN: '1',
    RSC_OMP_STRICT_EXEC: '1',
  });
  try {
    await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd });
    const handlers = await handlersFor(cwd);
    const call = handlers.get('tool_call');
    const result = await call({ toolName: 'eval', input: { code: "await Bun.$`git commit -am unsafe`" } }, ctx(cwd, 'inactive'));
    assert.equal(result?.block, true);
    assert.match(result.reason, /strict execution/);
    assert.equal(await call({ toolName: 'read', input: {} }, ctx(cwd, 'inactive')), undefined);
    assert.equal(await call({ toolName: 'todo', input: {} }, ctx(cwd, 'inactive')), undefined);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(cwd, { force: true, recursive: true });
  }
});

test('Project override takes precedence over OMP global plugin toggles', () => {
  const cwd = project();
  try {
    // PI_CONFIG_DIR moves the machine root only; OMP's project-local directory is always `.omp`.
    const env = { RSC_OMP_PLUGIN_CONFIG: pluginPath(cwd), PI_CONFIG_DIR: '.custom-omp' };
    writeFileSync(pluginPath(cwd), JSON.stringify({ settings: { 'rsc-harness': { guards: false, native: true } } }));
    assert.equal(readPluginSwitches(env, cwd).guards, false);
    mkdirSync(join(cwd, '.omp'), { recursive: true });
    writeFileSync(join(cwd, '.omp', 'plugin-overrides.json'), JSON.stringify({ settings: { 'rsc-harness': { guards: true, native: false } } }));
    const result = readPluginSwitches(env, cwd);
    assert.equal(result.guards, true);
    assert.equal(result.native, false);
  } finally { rmSync(cwd, { force: true, recursive: true }); }
});

test('A plugin linked by an older version still supersedes the managed hook', async () => {
  const cwd = project();
  const home = mkdtempSync(join(tmpdir(), 'rsc-omp-linked-home-'));
  const previous = {
    HOME: process.env.HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    RSC_NO_OMP_PLUGIN: process.env.RSC_NO_OMP_PLUGIN,
  };
  Object.assign(process.env, {
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, '.omp', 'agent'),
    RSC_NO_OMP_PLUGIN: '1',
  });
  try {
    const { existsSync } = await import('node:fs');
    const { wireOmpUserLoader, ompUserLoaderPath } = await import('../targets/omp-bridge.js');
    const hook = ompUserLoaderPath();
    wireOmpUserLoader();
    assert.equal(existsSync(hook), true);
    const plugins = join(home, '.omp', 'plugins');
    mkdirSync(join(plugins, 'node_modules', 'rsc-harness'), { recursive: true });
    writeFileSync(join(plugins, 'omp-plugins.lock.json'), JSON.stringify({
      plugins: { 'rsc-harness': { version: '0.0.1', enabled: true } }, settings: {},
    }));
    const result = await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd });
    assert.equal(result.ompBridge.plugin.registered, false);
    assert.equal(result.ompBridge.plugin.linked, true);
    assert.equal(existsSync(hook), false, 'a linked plugin OMP still loads must not double with the hook');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(cwd, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test('Strict exec applies even when bash guards are switched off', async () => {
  const cwd = project();
  const previous = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    RSC_NO_OMP_PLUGIN: process.env.RSC_NO_OMP_PLUGIN,
    RSC_OMP_PLUGIN_CONFIG: process.env.RSC_OMP_PLUGIN_CONFIG,
    RSC_OMP_STRICT_EXEC: process.env.RSC_OMP_STRICT_EXEC,
  };
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: join(cwd, 'agent'),
    RSC_NO_OMP_PLUGIN: '1',
    RSC_OMP_PLUGIN_CONFIG: join(cwd, 'registry.json'),
    RSC_OMP_STRICT_EXEC: '1',
  });
  try {
    writeFileSync(join(cwd, 'registry.json'), JSON.stringify({ settings: { 'rsc-harness': { guards: false } } }));
    await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd });
    const handlers = await handlersFor(cwd);
    const call = handlers.get('tool_call');
    const blocked = await call({ toolName: 'eval', input: { code: '1' } }, ctx(cwd, 'inactive'));
    assert.equal(blocked?.block, true);
    assert.match(blocked.reason, /strict execution/);
    delete process.env.RSC_OMP_STRICT_EXEC;
    assert.equal(await call({ toolName: 'eval', input: { code: '1' } }, ctx(cwd, 'inactive')), undefined,
      'without strict exec the eval tool keeps the host policy');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(cwd, { force: true, recursive: true });
  }
});

test('Plan gate follows the native switch, not the lane switch', async () => {
  const cwd = project();
  const previous = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    RSC_NO_OMP_PLUGIN: process.env.RSC_NO_OMP_PLUGIN,
    RSC_OMP_PLUGIN_CONFIG: process.env.RSC_OMP_PLUGIN_CONFIG,
  };
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: join(cwd, 'agent'),
    RSC_NO_OMP_PLUGIN: '1',
    RSC_OMP_PLUGIN_CONFIG: join(cwd, 'registry.json'),
  });
  try {
    writeFileSync(join(cwd, 'registry.json'), JSON.stringify({ settings: { 'rsc-harness': { native: true, lane: false } } }));
    await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd });
    let handlers = await handlersFor(cwd);
    let call = handlers.get('tool_call');
    assert.equal((await call({ toolName: 'write', input: { file_path: 'x' } }, ctx(cwd, 'active')))?.block, true,
      'native alone enforces Plan');
    assert.equal((await handlers.get('before_subagent_spawn')({ agent: 'developer' }, ctx(cwd, 'active')))?.block, true);

    writeFileSync(join(cwd, 'registry.json'), JSON.stringify({ settings: { 'rsc-harness': { native: false, lane: true } } }));
    handlers = await handlersFor(cwd);
    call = handlers.get('tool_call');
    assert.equal(await call({ toolName: 'write', input: { file_path: 'x' } }, ctx(cwd, 'active')), undefined,
      'the lane switch does not own the Plan gate');
    assert.equal(await handlers.get('before_subagent_spawn')({ agent: 'developer' }, ctx(cwd, 'active')), undefined);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(cwd, { force: true, recursive: true });
  }
});

test('A bash guard exception denies instead of failing open', async () => {
  const cwd = project();
  const previous = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    RSC_NO_OMP_PLUGIN: process.env.RSC_NO_OMP_PLUGIN,
  };
  Object.assign(process.env, { PI_CODING_AGENT_DIR: join(cwd, 'agent'), RSC_NO_OMP_PLUGIN: '1' });
  try {
    await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd });
    const handlers = await handlersFor(cwd);
    const call = handlers.get('tool_call');
    const event = { toolName: 'bash', get input() { throw new Error('boom'); } };
    const result = await call(event, ctx(cwd, 'inactive'));
    assert.equal(result?.block, true);
    assert.match(result.reason, /bash guard evaluation failed/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(cwd, { force: true, recursive: true });
  }
});

test('An absent settings registry cannot vouch for interactive critical approval', () => {
  assert.equal(hostAutoApproves(null, {}), true);
  assert.equal(hostAutoApproves({ lookup: () => ({ get: () => 'always-ask' }) }, {}), false);
  assert.equal(hostAutoApproves({ lookup: () => ({ get: () => 'yolo' }) }, {}), true);
});

test('Disabling OMP plugin applies to project hook and project-level overrides', async () => {
  const cwd = project();
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldPlugin = process.env.RSC_NO_OMP_PLUGIN;
  const oldConfig = process.env.RSC_OMP_PLUGIN_CONFIG;
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: join(cwd, 'agent'),
    RSC_NO_OMP_PLUGIN: '1',
    RSC_OMP_PLUGIN_CONFIG: join(cwd, 'registry.json'),
  });
  try {
    await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd });
    writeFileSync(join(cwd, 'registry.json'), JSON.stringify({ plugins: { 'rsc-harness': { enabled: false } }, settings: {} }));
    const disabled = await handlersFor(cwd);
    assert.equal(disabled.size, 0, 'committed loader must not silently run a disabled plugin');
    writeFileSync(join(cwd, 'registry.json'), JSON.stringify({ plugins: { 'rsc-harness': { enabled: true } }, settings: {} }));
    mkdirSync(join(cwd, '.omp'), { recursive: true });
    writeFileSync(join(cwd, '.omp', 'plugin-overrides.json'), JSON.stringify({ disabled: ['rsc-harness'] }));
    const byProject = await handlersFor(cwd);
    assert.equal(byProject.size, 0);
  } finally {
    for (const [key, value] of Object.entries({ PI_CODING_AGENT_DIR: oldAgent, RSC_NO_OMP_PLUGIN: oldPlugin, RSC_OMP_PLUGIN_CONFIG: oldConfig })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(cwd, { force: true, recursive: true });
  }
});

test('Registered plugin supersedes only the RSC-owned global resolver', async () => {
  const cwd = project();
  const home = mkdtempSync(join(tmpdir(), 'rsc-omp-plugin-home-'));
  const previous = {
    HOME: process.env.HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    RSC_NO_OMP_PLUGIN: process.env.RSC_NO_OMP_PLUGIN,
  };
  Object.assign(process.env, {
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, '.omp', 'agent'),
    RSC_NO_OMP_PLUGIN: '1',
  });
  try {
    const { wireOmpUserLoader, ompUserLoaderPath } = await import('../targets/omp-bridge.js');
    const { existsSync, readFileSync } = await import('node:fs');
    const global = ompUserLoaderPath();
    wireOmpUserLoader();
    assert.equal(existsSync(global), true);
    const plugins = join(home, '.omp', 'plugins');
    mkdirSync(join(plugins, 'node_modules', 'rsc-harness'), { recursive: true });
    // Manifest version must equal the package being installed, otherwise OMP
    // attempts an upgrade (which would require the real executable).
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
    writeFileSync(join(plugins, 'omp-plugins.lock.json'), JSON.stringify({
      plugins: { 'rsc-harness': { version, enabled: true } }, settings: {},
    }));
    await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd });
    assert.equal(existsSync(global), false, 'registered OMP plugin replaces managed machine hook');
    assert.equal(existsSync(join(cwd, '.omp', 'hooks', 'pre', 'rsc.js')), true,
      'committed project loader remains for root sessions');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(cwd, { force: true, recursive: true });
    rmSync(home, { force: true, recursive: true });
  }
});

test('Plan blocks implementation subagents; strict Plan also blocks research delegation', async () => {
  const cwd = project();
  const prev = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    RSC_NO_OMP_PLUGIN: process.env.RSC_NO_OMP_PLUGIN,
    RSC_OMP_STRICT_PLAN: process.env.RSC_OMP_STRICT_PLAN,
  };
  Object.assign(process.env, { PI_CODING_AGENT_DIR: join(cwd, 'agent'), RSC_NO_OMP_PLUGIN: '1' });
  try {
    await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd });
    const handlers = await handlersFor(cwd);
    const spawn = handlers.get('before_subagent_spawn');
    assert.equal((await spawn({ agent: 'developer' }, ctx(cwd, 'active')))?.block, true);
    assert.equal(await spawn({ agent: 'explore' }, ctx(cwd, 'active')), undefined,
      'normal Plan can still delegate read-only research');
    process.env.RSC_OMP_STRICT_PLAN = '1';
    assert.equal((await spawn({ agent: 'explore' }, ctx(cwd, 'active')))?.block, true,
      'strict Plan prevents all task/eval agent delegation');
    assert.equal(await spawn({ agent: 'developer' }, ctx(cwd, 'inactive')), undefined);
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(cwd, { recursive: true, force: true });
  }
});
