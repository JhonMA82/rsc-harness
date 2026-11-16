// Oh My Pi (omp) as a first-class rsc target. OMP discovers skills under `.omp/skills`, agents
// under `.omp/agents`, commands under `.omp/commands` and a project context file at
// `.omp/AGENTS.md`; its lifecycle hooks are extension factories under `.omp/hooks/pre/`. There is no
// project settings JSON, so rsc commits one thin loader and materializes the real bridge under
// `.rsc/`. These tests exercise that whole contract without installing OMP itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { applyInstall, removeTargetInstall, managedPathsForInstall } from '../scripts/install-apply.js';
import { doctor } from '../scripts/doctor.js';
import { detectTarget, targetPaths, TARGET_IDS } from '../targets/index.js';
import {
  OMP_LOADER, OMP_USER_LOADER_MARKER, OMP_PLUGIN_NAME, OMP_TODO_MARKER, inspectOmpBridge, inspectOmpPlugin,
  inspectOmpTodo, ompAgentDir, ompBridgeManagedPaths, ompPluginDir, ompUserLoaderPath, wireOmpPlugin, wireOmpUserLoader,
} from '../targets/omp-bridge.js';
import { applyOmpTodoDefault, guardRuntime, hostAutoApproves, pinOmpTodoDefault, readPluginSwitches } from '../targets/omp-bridge.mjs';
import {
  inspectOmpRules, ompRulesPath, unwireOmpRules, wireOmpRules,
} from '../targets/omp-rules.js';

// Every install in this file writes the machine-level resolver too. Keep it in a temp agent dir so a
// test run never touches the developer's ~/.omp. The plugin registration is exercised with a fake
// `omp` in omp08; never let it reach the real registry from the other tests.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'rsc-omp-agent-'));
process.env.RSC_NO_OMP_PLUGIN = '1';
// The bridge reads the machine plugin registry at startup; a developer's Settings → Plugins
// toggles must not change these results.
process.env.RSC_OMP_PLUGIN_CONFIG = join(mkdtempSync(join(tmpdir(), 'rsc-omp-plugin-config-')), 'none.json');
delete process.env.RSC_OMP_STRICT_PLAN;
delete process.env.RSC_OMP_STRICT_EXEC;
// A full-suite run on a two-core box can starve the four guard child processes past the production
// five-second ceiling. The guards are local scripts, so the test gives them room instead of flaking.
process.env.RSC_OMP_GUARD_TIMEOUT = '15000';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function project() {
  const cwd = mkdtempSync(join(tmpdir(), 'rsc-omp-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd });
  return cwd;
}

const read = (cwd, ...parts) => readFileSync(join(cwd, ...parts), 'utf8');

test('omp01 · omp is a target and a .omp directory is detected as Oh My Pi', () => {
  assert.ok(TARGET_IDS.includes('omp'));
  const cwd = mkdtempSync(join(tmpdir(), 'rsc-omp-detect-'));
  mkdirSync(join(cwd, '.omp'));
  try {
    assert.equal(detectTarget(cwd), 'omp');
    const paths = targetPaths('omp', undefined, cwd);
    assert.equal(paths.root, join(cwd, '.omp', 'skills'));
    assert.equal(paths.hookTarget, join(cwd, '.omp', 'AGENTS.md'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('omp02 · install writes the native surfaces, the committed loader and the bridge; doctor sees them', async () => {
  const cwd = project();
  const previous = process.env.RSC_NO_UPDATE_CHECK;
  process.env.RSC_NO_UPDATE_CHECK = '1';
  try {
    const state = await applyInstall({
      skillIds: ['suggest', 'plan'],
      agentIds: ['go-reviewer'],
      target: 'omp',
      cwd,
    });

    assert.ok(existsSync(join(cwd, '.omp', 'skills', 'suggest', 'SKILL.md')), 'skills live where OMP discovers them');
    const agentsMd = read(cwd, '.omp', 'AGENTS.md');
    assert.match(agentsMd, /rsc-suggest:start/, 'the always-on block is in the project context file');
    assert.match(agentsMd, /Native todo panel/, 'the main session is told how to feed OMP\'s live todo panel');
    assert.match(agentsMd, /Native question form/, 'the main session is told to use OMP\'s native ask form');
    assert.match(agentsMd, /`ask` tool/, 'the question section names the tool');
    assert.match(read(cwd, '.omp', 'RULES.md'), /rsc-omp-rules:start/, 'the sticky rules block reaches task subagents');
    assert.match(readFileSync(join(cwd, '.rsc', 'omp-bridge.mjs'), 'utf8'), new RegExp(OMP_TODO_MARKER),
      'the bridge owns the todo default');
    assert.equal(inspectOmpTodo(cwd).mode, 'wired');

    const loaderPath = join(cwd, ...OMP_LOADER.split('/'));
    const loader = readFileSync(loaderPath, 'utf8');
    assert.match(loader, /rsc-omp:managed/);
    assert.match(loader, /\.\.\/\.\.\/\.\.\/\.rsc\/omp-bridge\.mjs/, 'the loader points at the machine-local bridge');
    assert.ok(existsSync(join(cwd, '.rsc', 'omp-bridge.mjs')));
    assert.equal(git(cwd, 'check-ignore', '.rsc/omp-bridge.mjs'), '.rsc/omp-bridge.mjs');
    assert.throws(() => git(cwd, 'check-ignore', '-q', OMP_LOADER), 'the loader is committed, not local state');

    const agent = read(cwd, '.omp', 'agents', 'go-reviewer.md');
    assert.doesNotMatch(agent, /^model:/m, 'OMP agents inherit the session model by default');
    assert.match(agent, /^tools: \[read, grep\]$/m, 'rsc capabilities are rendered with OMP tool names');

    const command = read(cwd, '.omp', 'commands', 'go-review.md');
    assert.match(command, /Pass the invocation arguments unchanged: \$ARGUMENTS/, 'OMP file commands use $ARGUMENTS');

    assert.equal(state.memory.mode, 'full');
    assert.equal(state.memory.reason, 'wired');
    assert.equal(state.update.mode, 'hook');
    assert.equal(state.update.reason, 'bridge');
    assert.equal(state.knowledge.mode, 'wired');
    assert.equal(state.ompBridge.mode, 'wired');
    assert.ok(state.ompBridge.paths.every((path) => existsSync(path)));
    const manifest = JSON.parse(readFileSync(join(ompPluginDir(), 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.omp.settings), ['guards', 'native', 'memory', 'knowledge', 'lane', 'update']);
    assert.ok(Object.values(manifest.omp.settings).every((s) => s.type === 'boolean' && s.default === true),
      'Settings → Plugins renders one on/off row per switch, on by default');
    assert.equal(state.ompRules.mode, 'wired');
    assert.equal(inspectOmpRules(cwd).mode, 'wired');

    const healthy = doctor({ target: 'omp', cwd });
    assert.equal(healthy.hookWired, true);
    assert.equal(healthy.ompBridge.mode, 'wired');
    assert.equal(healthy.ompTodo.mode, 'wired');
    assert.equal(healthy.ompRules.mode, 'wired');
    assert.equal(healthy.healthy, true);

    rmSync(join(cwd, '.omp', 'RULES.md'));
    const brokenRules = doctor({ target: 'omp', cwd });
    assert.equal(brokenRules.ompRules.mode, 'missing');
    assert.equal(brokenRules.healthy, false, 'a missing sticky-rules block is not a healthy OMP install');

    rmSync(join(cwd, '.rsc', 'omp-bridge.mjs'));
    const broken = doctor({ target: 'omp', cwd });
    assert.equal(broken.ompBridge.mode, 'degraded');
    assert.equal(broken.ompTodo.mode, 'missing');
    assert.ok(broken.ompBridge.missing.includes(join(cwd, '.rsc', 'omp-bridge.mjs')));
    assert.equal(broken.healthy, false, 'a loader with no bridge is not a wired hook');
  } finally {
    if (previous === undefined) delete process.env.RSC_NO_UPDATE_CHECK; else process.env.RSC_NO_UPDATE_CHECK = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('omp03 · reinstall is idempotent and removal takes the loader, bridge and managed surfaces back', async () => {
  const cwd = project();
  try {
    await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd });
    await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd });

    const agentsMd = read(cwd, '.omp', 'AGENTS.md');
    assert.equal(agentsMd.match(/rsc-suggest:start/g).length, 1, 'the always-on block is not duplicated');
    const rulesMd = read(cwd, '.omp', 'RULES.md');
    assert.equal(rulesMd.match(/rsc-omp-rules:start/g).length, 1, 'the rules block is not duplicated');
    const loader = readFileSync(join(cwd, ...OMP_LOADER.split('/')), 'utf8');
    assert.equal(loader.match(/rsc-omp:managed/g).length, 1);

    removeTargetInstall({ target: 'omp', cwd });
    assert.ok(!existsSync(join(cwd, ...OMP_LOADER.split('/'))), 'the committed loader is withdrawn');
    assert.ok(!existsSync(join(cwd, '.rsc', 'omp-bridge.mjs')), 'the machine-local bridge is withdrawn');
    assert.ok(!existsSync(join(cwd, '.rsc', 'omp-native.mjs')), 'the native module is withdrawn with it');
    assert.ok(!existsSync(join(cwd, '.omp', 'skills', 'suggest')), 'the managed skill is withdrawn');
    assert.doesNotMatch(readFileSync(join(cwd, '.omp', 'AGENTS.md'), 'utf8'), /rsc-suggest:start/);
    assert.ok(!existsSync(ompRulesPath(cwd)), 'a rules file that held only rsc\'s block is withdrawn');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('omp04 · the bridge injects context, runs every guard and blocks on tool_call', async () => {
  const cwd = project();
  const previous = process.env.RSC_NO_UPDATE_CHECK;
  process.env.RSC_NO_UPDATE_CHECK = '1';
  try {
    await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd });
    // A forbidden phrase in the project wiki proves the Stop-side copy guard rides the same bridge.
    mkdirSync(join(cwd, '02-DOCS', 'wiki'), { recursive: true });
    writeFileSync(join(cwd, '02-DOCS', 'wiki', 'voice.md'), '## Frases prohibidas\n\n- "libertad financiera"\n');

    const { default: factory } = await import(join(cwd, '.rsc', 'omp-bridge.mjs'));
    const handlers = new Map();
    await factory({
      on(name, fn) { handlers.set(name, fn); },
      getActiveTools() { return ['ask']; },
    });
    for (const event of ['session_start', 'before_agent_start', 'tool_call', 'tool_result', 'session_stop', 'session_shutdown']) {
      assert.equal(typeof handlers.get(event), 'function', `${event} is subscribed`);
    }

    const ctx = {
      cwd,
      mode: 'tui',
      agent: { kind: 'main' },
      hasUI: true,
      sessionManager: { getSessionId: () => 'omp-main', getSessionFile: () => null },
    };
    await handlers.get('session_start')({}, ctx);
    assert.ok(existsSync(join(cwd, '.rsc', 'memory', 'anchors', 'omp--omp-main.json')), 'the session is journaled under its own id');

    const start = await handlers.get('before_agent_start')({ reason: 'prompt' }, ctx);
    assert.match(start.message.content, /rsc lane decisor/, 'the per-turn lane gate reaches the model');
    assert.match(start.message.content, /Native question form/, 'the interactive turn is told to use the native ask form');
    assert.equal(start.message.display, false, 'rsc context is not printed as if the person wrote it');

    const printStart = await handlers.get('before_agent_start')({ reason: 'prompt' }, { ...ctx, mode: 'print', hasUI: false });
    assert.doesNotMatch(printStart.message.content, /Native question form/, 'headless turns do not advertise ask');

    const blocked = await handlers.get('tool_call')({ toolName: 'bash', input: { command: 'rm -rf /' } }, ctx);
    assert.equal(blocked.block, true, 'a dangerous command is denied');
    assert.match(blocked.reason, /rm with -r and -f/);
    assert.equal(await handlers.get('tool_call')({ toolName: 'bash', input: { command: 'echo hola' } }, ctx), undefined);

    const sub = { ...ctx, agent: { kind: 'sub' }, sessionManager: { getSessionId: () => 'omp-sub', getSessionFile: () => null } };
    await handlers.get('session_start')({}, sub);
    assert.ok(!existsSync(join(cwd, '.rsc', 'memory', 'anchors', 'omp--omp-sub.json')), 'a subagent does not own the person\'s journal');
    const subBlocked = await handlers.get('tool_call')({ toolName: 'bash', input: { command: 'rm -rf /' } }, sub);
    assert.equal(subBlocked.block, true, 'a destructive command is guarded in a subagent too');

    const stop = await handlers.get('session_stop')({
      session_id: 'omp-main',
      stop_hook_active: false,
      last_assistant_message: { role: 'assistant', content: [{ type: 'text', text: 'Te doy libertad financiera hoy.' }] },
    }, ctx);
    assert.equal(stop.continue, true, 'a forbidden phrase asks the model for one more turn');
    assert.match(stop.additionalContext, /libertad financiera/);
    assert.equal(await handlers.get('session_stop')({ session_id: 'omp-main', stop_hook_active: false }, ctx), undefined,
      'one stop decision per turn, so the hook cannot wake itself');

    // A new prompt is a new turn: the next stop must be judged again instead of inheriting the
    // previous turn's silence.
    await handlers.get('before_agent_start')({ reason: 'prompt' }, ctx);
    const nextTurn = await handlers.get('session_stop')({
      session_id: 'omp-main',
      stop_hook_active: false,
      last_assistant_message: { role: 'assistant', content: [{ type: 'text', text: 'Otra vez libertad financiera.' }] },
    }, ctx);
    assert.equal(nextTurn.continue, true, 'the copy guard runs on every turn, not only the first');
  } finally {
    if (previous === undefined) delete process.env.RSC_NO_UPDATE_CHECK; else process.env.RSC_NO_UPDATE_CHECK = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('omp05 · the bridge paths are the loader plus exactly the modules the accepted plan selected', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rsc-omp-paths-'));
  try {
    const full = ompBridgeManagedPaths({ cwd, policy: { dangerGuard: true, codeHooks: true, laneGate: true } });
    assert.equal(full[0], join(cwd, ...OMP_LOADER.split('/')));
    for (const name of ['omp-bridge.mjs', 'danger-guard.mjs', 'ship-guard.mjs', 'ftd-nudge.mjs', 'copy-guard.mjs']) {
      assert.ok(full.includes(join(cwd, '.rsc', name)), name);
    }
    const narrow = ompBridgeManagedPaths({ cwd, policy: { dangerGuard: false, codeHooks: false, laneGate: false } });
    for (const name of ['danger-guard.mjs', 'ship-guard.mjs', 'gitmoji-guard.mjs', 'ftd-nudge.mjs']) {
      assert.ok(!narrow.includes(join(cwd, '.rsc', name)), `${name} is not in a narrower plan`);
    }
    assert.ok(narrow.includes(join(cwd, '.rsc', 'omp-bridge.mjs')), 'the bridge itself is always installed');
    assert.equal(inspectOmpBridge(cwd, {}).mode, 'degraded', 'nothing is wired before an install');
    // Code guards parse real shell commands, so they keep their shared unwrapper even when only the
    // danger guard was turned off.
    const codeOnly = ompBridgeManagedPaths({ cwd, policy: { dangerGuard: false, codeHooks: true } });
    assert.ok(codeOnly.includes(join(cwd, '.rsc', 'shell-unwrap.mjs')), 'code guards keep shell-unwrap');
    assert.ok(codeOnly.includes(join(cwd, '.rsc', 'ship-guard.mjs')));
    assert.ok(!codeOnly.includes(join(cwd, '.rsc', 'danger-guard.mjs')));
    // A plan that declined the always-on layer never writes the rules block, so the plan must not
    // declare it as a governed path either.
    assert.ok(managedPathsForInstall({ skillIds: ['suggest'], target: 'omp', cwd, policy: { alwaysOn: true } }).includes(ompRulesPath(cwd)));
    assert.ok(!managedPathsForInstall({ skillIds: ['suggest'], target: 'omp', cwd, policy: { alwaysOn: false } }).includes(ompRulesPath(cwd)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('omp06 · a hand-written machine-level resolver is never replaced', () => {
  assert.equal(ompAgentDir({ PI_PROFILE: 'work' }), join(homedir(), '.omp', 'profiles', 'work', 'agent'));
  assert.equal(ompAgentDir({ PI_PROFILE: '../../escape' }), join(homedir(), '.omp', 'agent'), 'a path-shaped profile falls back');
  const env = { PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), 'rsc-omp-agent-own-')) };
  const path = ompUserLoaderPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '// mine\n');
  try {
    assert.deepEqual(wireOmpUserLoader(env), { mode: 'manual', reason: 'loader-collision', path });
    assert.equal(readFileSync(path, 'utf8'), '// mine\n');
  } finally {
    rmSync(env.PI_CODING_AGENT_DIR, { recursive: true, force: true });
  }
});

test('omp07 · the machine-level resolver loads the bridge from a subdirectory, and not twice at the root', async () => {
  const cwd = project();
  const home = mkdtempSync(join(tmpdir(), 'rsc-omp-resolver-home-'));
  const previous = {
    HOME: process.env.HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    RSC_NO_OMP_PLUGIN: process.env.RSC_NO_OMP_PLUGIN,
  };
  Object.assign(process.env, {
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, '.omp', 'agent'),
    // Exercise the resolver fallback deterministically; the registered-plugin path has its own test.
    RSC_NO_OMP_PLUGIN: '1',
  });
  try {
    await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd });
    const userLoader = ompUserLoaderPath();
    assert.ok(existsSync(userLoader), 'the resolver lands in OMP\'s user hook directory');
    assert.match(readFileSync(userLoader, 'utf8'), new RegExp(OMP_USER_LOADER_MARKER));

    const { default: resolver } = await import(pathToFileURL(userLoader).href);
    const handlersAt = async (dir) => {
      const saved = process.cwd();
      const handlers = new Map();
      process.chdir(dir);
      try { await resolver({ on: (name, fn) => handlers.set(name, fn) }); } finally { process.chdir(saved); }
      return handlers;
    };
    const sub = join(cwd, 'packages', 'api');
    mkdirSync(sub, { recursive: true });
    assert.ok((await handlersAt(sub)).has('session_start'), 'OMP started in a subdirectory still gets the adapter');
    assert.equal((await handlersAt(cwd)).size, 0, 'OMP at the project root discovers the committed loader itself');
    const report = doctor({ target: 'omp', cwd });
    assert.equal(report.ompUserLoader.mode, 'wired', 'doctor names the machine-level resolver');
    assert.notEqual(report.ompPlugin.mode, 'absent', 'doctor names the OMP plugin package');
    assert.ok(existsSync(join(ompPluginDir(), 'package.json')));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor reads a registered plugin as the resolver when the managed hook is gone', async () => {
  const cwd = project();
  const home = mkdtempSync(join(tmpdir(), 'rsc-omp-doctor-home-'));
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
    mkdirSync(join(home, '.omp', 'plugins', 'node_modules', 'rsc-harness'), { recursive: true });
    writeFileSync(join(home, '.omp', 'plugins', 'omp-plugins.lock.json'), JSON.stringify({
      plugins: { 'rsc-harness': { version: '0.0.1', enabled: true } }, settings: {},
    }));
    await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd });
    assert.ok(!existsSync(ompUserLoaderPath()), 'the managed hook was superseded');
    const report = doctor({ target: 'omp', cwd });
    assert.equal(report.ompPlugin.registered, true);
    assert.equal(report.ompUserLoader.mode, 'superseded-by-plugin');
    assert.equal(report.ompUserLoader.action, null, 'doctor must not ask for a hook the plugin replaces');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('omp09 · RULES.md keeps the user prose, is idempotent and takes only its own block back', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rsc-omp-rules-'));
  const path = ompRulesPath(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '# My rules\n\nKeep this.\n');
    wireOmpRules(cwd);
    wireOmpRules(cwd);
    const body = readFileSync(path, 'utf8');
    assert.match(body, /# My rules/);
    assert.equal(body.match(/rsc-omp-rules:start/g).length, 1, 'reinstall replaces the block instead of duplicating it');
    assert.equal(inspectOmpRules(cwd).mode, 'wired');

    unwireOmpRules(cwd);
    const left = readFileSync(path, 'utf8');
    assert.match(left, /# My rules/, 'the user\'s prose survives');
    assert.doesNotMatch(left, /rsc-omp-rules:start/, 'only rsc\'s block is taken back');
    assert.equal(inspectOmpRules(cwd).mode, 'manual');

    // A file rsc created solely for its block is removed, not left as an empty shell.
    const clean = mkdtempSync(join(tmpdir(), 'rsc-omp-rules-only-'));
    try {
      wireOmpRules(clean);
      assert.ok(existsSync(ompRulesPath(clean)));
      unwireOmpRules(clean);
      assert.ok(!existsSync(ompRulesPath(clean)));
    } finally { rmSync(clean, { recursive: true, force: true }); }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('omp10 · the todo default is a default, never an override of the person\'s setting', async () => {
  const calls = [];
  const setting = (configured) => ({
    isConfigured: () => configured,
    override: (_scope, value) => calls.push(value),
  });
  const pi = { pi: { settings: { marker: true } } };
  assert.equal(pinOmpTodoDefault(pi, () => setting(false)), true);
  assert.deepEqual(calls, ['always']);
  calls.length = 0;
  assert.equal(pinOmpTodoDefault(pi, () => setting(true)), false, 'a configured value wins');
  assert.deepEqual(calls, []);
  assert.equal(pinOmpTodoDefault(pi, () => undefined), false);
  assert.equal(pinOmpTodoDefault({}, () => setting(false)), false, 'not an OMP runtime');

  const previous = process.env.RSC_NO_OMP_TODO;
  process.env.RSC_NO_OMP_TODO = '1';
  try {
    assert.equal(await applyOmpTodoDefault(pi), false, 'the env opt-out wins before any import');
  } finally {
    if (previous === undefined) delete process.env.RSC_NO_OMP_TODO; else process.env.RSC_NO_OMP_TODO = previous;
  }
});

test('omp11 · doctor names a bridge from before the todo default as stale, not broken', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rsc-omp-todo-stale-'));
  try {
    mkdirSync(join(cwd, '.rsc'), { recursive: true });
    writeFileSync(join(cwd, '.rsc', 'omp-bridge.mjs'), '// rsc-omp-bridge:managed\n');
    const report = inspectOmpTodo(cwd);
    assert.equal(report.mode, 'stale');
    assert.match(report.action, /sync/, 'the way forward is the normal sync, not a repair');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('omp08 · the plugin package is registered through OMP and appears as installed', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'rsc-omp-home-'));
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const fake = join(bin, 'omp');
  writeFileSync(fake, `#!/bin/sh
set -eu
[ "$1" = plugin ] && [ "$2" = install ]
mkdir -p "$HOME/.omp/plugins/node_modules"
ln -sfn "$3" "$HOME/.omp/plugins/node_modules/${OMP_PLUGIN_NAME}"
printf '{"plugins":{"${OMP_PLUGIN_NAME}":{"version":"0.0.0","enabled":true}},"settings":{}}\\n' > "$HOME/.omp/plugins/omp-plugins.lock.json"
`);
  chmodSync(fake, 0o755);
  const env = {
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    PI_CODING_AGENT_DIR: join(home, 'agent'),
    RSC_NO_OMP_PLUGIN: '',
  };
  try {
    const written = wireOmpPlugin(env, '9.9.9');
    assert.equal(written.mode, 'wired');
    assert.equal(written.registered, true);
    const dir = ompPluginDir(env);
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name, OMP_PLUGIN_NAME);
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).omp.extensions[0], './index.js');
    assert.ok(existsSync(join(home, '.omp', 'plugins', 'node_modules', OMP_PLUGIN_NAME)), 'OMP owns the link');
    assert.equal(inspectOmpPlugin(env).mode, 'wired');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('omp13 · a critical ask blocks when the host auto-approves it', async () => {
  const previous = process.env.RSC_NO_UPDATE_CHECK;
  process.env.RSC_NO_UPDATE_CHECK = '1';
  // The bridge imports OMP's settings registry by bare specifier, so a project-local node_modules
  // decides what the host reports about its own approval policy.
  const writeRegistry = (cwd, mode) => {
    const dir = join(cwd, 'node_modules', '@oh-my-pi', 'pi-coding-agent');
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: '@oh-my-pi/pi-coding-agent',
      version: '0.0.0',
      type: 'module',
      exports: { './config/registry': './config/registry.js' },
    }));
    writeFileSync(join(dir, 'config', 'registry.js'), [
      `const values = { "tools.approvalMode": ${JSON.stringify(mode)}, "tools.approval": {} };`,
      'const handle = (id) => ({',
      '  get: () => values[id],',
      '  isConfigured: () => id in values,',
      '  override: (scope, value) => { values[id] = value; },',
      '});',
      'export function lookup(id) { return handle(id); }',
    ].join('\n'));
  };
  const fakeRegistry = (mode, bash) => ({
    lookup: (id) => ({
      get: () => id === 'tools.approvalMode' ? mode : id === 'tools.approval' ? { bash } : undefined,
    }),
  });
  const approveOnce = async () => 'once';
  // A technical profile turns the wipe rule into an `ask`; a non-technical one denies outright and
  // would never exercise the host's approval at all.
  const technicalProfile = (cwd) => {
    mkdirSync(join(cwd, '02-DOCS', 'wiki', 'harness'), { recursive: true });
    writeFileSync(join(cwd, '02-DOCS', 'wiki', 'harness', 'user-profile.md'), '---\ntechnical_level: technical\n---\n');
  };
  const contextAt = (cwd) => ({
    cwd,
    mode: 'tui',
    agent: { kind: 'main' },
    hasUI: true,
    ui: { approve: approveOnce },
    sessionManager: { getSessionId: () => 'omp-main', getSessionFile: () => null },
  });
  const handlersFor = async (cwd) => {
    const { default: factory } = await import(pathToFileURL(join(cwd, '.rsc', 'omp-bridge.mjs')).href);
    const handlers = new Map();
    await factory({ on(name, fn) { handlers.set(name, fn); }, pi: { settings: {} } });
    return handlers;
  };
  const cwd = project();
  const alwaysAsk = project();
  try {
    assert.equal(hostAutoApproves(fakeRegistry('yolo'), {}), true);
    assert.equal(hostAutoApproves(fakeRegistry('always-ask'), {}), false);
    assert.equal(hostAutoApproves(fakeRegistry('always-ask-cached'), {}), false);
    assert.equal(hostAutoApproves(fakeRegistry('write'), {}), false);
    assert.equal(hostAutoApproves(fakeRegistry('write', 'allow'), {}), true);
    assert.equal(hostAutoApproves(fakeRegistry('always-ask', 'prompt'), {}), false);
    assert.equal(hostAutoApproves(fakeRegistry('yolo', 'prompt'), {}), false, 'a per-tool prompt overrides yolo');
    assert.equal(hostAutoApproves(null, {}), true, 'without a registry an auto-grant cannot prove human approval');

    // yolo: OMP auto-approves exec, so `ui.approve` says yes without asking anyone. The critical
    // guard must block instead of pretending the person confirmed.
    await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd });
    technicalProfile(cwd);
    writeRegistry(cwd, 'yolo');
    const handlers = await handlersFor(cwd);
    const blocked = await handlers.get('tool_call')({ toolName: 'bash', input: { command: 'rm -rf /' } }, contextAt(cwd));
    assert.equal(blocked?.block, true, 'the wipe is blocked even though ui.approve returned once');
    assert.match(blocked.reason, /recursively deletes/);
    assert.match(blocked.reason, /tools\.approvalMode = yolo/, 'the refusal says why no prompt reached the person');
    assert.equal(await handlers.get('tool_call')({ toolName: 'bash', input: { command: 'echo hola' } }, contextAt(cwd)), undefined,
      'a benign command is unaffected');

    // The same ask with a mode that does prompt exec keeps trusting the host's answer.
    await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd: alwaysAsk });
    technicalProfile(alwaysAsk);
    writeRegistry(alwaysAsk, 'always-ask');
    const prompting = await handlersFor(alwaysAsk);
    assert.equal(await prompting.get('tool_call')({ toolName: 'bash', input: { command: 'rm -rf /' } }, contextAt(alwaysAsk)), undefined,
      'a real host prompt is still honored');
  } finally {
    if (previous === undefined) delete process.env.RSC_NO_UPDATE_CHECK; else process.env.RSC_NO_UPDATE_CHECK = previous;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(alwaysAsk, { recursive: true, force: true });
  }
});

test('omp12 · guards run under Node when the OMP host binary is not Node', async () => {
  const cwd = project();
  const node = process.execPath;
  const bun = Object.getOwnPropertyDescriptor(process.versions, 'bun');
  try {
    await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd });
    // OMP ships as a Bun-compiled `omp` binary: inside its extension host `process.execPath` is that
    // binary, and `omp <script>` starts a nested session instead of the guard. The guard then dies
    // by timeout and every critical guard denies the command. A guard is plain Node, so the host
    // may supply the path only when the host itself is Node.
    assert.equal(guardRuntime('/opt/omp/bin/omp', { bun: '1.2.0' }), 'node');
    assert.equal(guardRuntime('/opt/omp/bin/omp', {}), 'node');
    assert.equal(guardRuntime(node, { bun: '1.2.0' }), 'node', 'a Bun host never trusts its execPath');
    assert.equal(guardRuntime(node, {}), node);

    const { default: factory } = await import(pathToFileURL(join(cwd, '.rsc', 'omp-bridge.mjs')).href);
    const handlers = new Map();
    await factory({ on(name, fn) { handlers.set(name, fn); } });
    const ctx = {
      cwd,
      mode: 'tui',
      agent: { kind: 'main' },
      hasUI: false,
      sessionManager: { getSessionId: () => 'omp-main', getSessionFile: () => null },
    };
    // The host reports a binary that cannot run a script, exactly like the real `omp` binary. Before
    // the fix every command was denied here, benign ones included.
    Object.defineProperty(process, 'execPath', { value: join(tmpdir(), 'rsc-omp-guard-no-node'), configurable: true });
    process.versions.bun = '1.2.0';
    assert.equal(await handlers.get('tool_call')({ toolName: 'bash', input: { command: 'echo hola' } }, ctx), undefined,
      'a benign command stays allowed');
    const blocked = await handlers.get('tool_call')({ toolName: 'bash', input: { command: 'rm -rf /' } }, ctx);
    assert.equal(blocked?.block, true, 'the guard really ran and still blocks a destructive command');
    assert.match(blocked.reason, /rm with -r and -f/);
  } finally {
    Object.defineProperty(process, 'execPath', { value: node, configurable: true });
    if (bun) Object.defineProperty(process.versions, 'bun', bun); else delete process.versions.bun;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('omp14 · the plugin toggles turn features off for the whole bridge', async () => {
  const saved = process.env.RSC_OMP_PLUGIN_CONFIG;
  const cwd = project();
  const quiet = project();
  const writeSwitches = (dir, switches) => {
    const file = join(dir, 'plugin-registry.json');
    writeFileSync(file, JSON.stringify({ plugins: {}, settings: { 'rsc-harness': switches } }));
    return file;
  };
  try {
    assert.deepEqual(readPluginSwitches({ RSC_OMP_PLUGIN_CONFIG: join(cwd, 'missing.json') }),
      { guards: true, native: true, memory: true, knowledge: true, lane: true, update: true },
      'no registry means nothing was turned off');
    const partial = writeSwitches(cwd, { guards: 'false', native: false, memory: true });
    assert.equal(readPluginSwitches({ RSC_OMP_PLUGIN_CONFIG: partial }).guards, false);
    assert.equal(readPluginSwitches({ RSC_OMP_PLUGIN_CONFIG: partial }).native, false);
    assert.equal(readPluginSwitches({ RSC_OMP_PLUGIN_CONFIG: partial }).memory, true);

    await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd });
    const ctx = {
      cwd,
      mode: 'tui',
      agent: { kind: 'main' },
      hasUI: false,
      sessionManager: { getSessionId: () => 'omp-main', getSessionFile: () => null },
    };
    const handlersAt = async (dir) => {
      process.env.RSC_OMP_PLUGIN_CONFIG = join(dir, 'plugin-registry.json');
      const { default: factory } = await import(pathToFileURL(join(dir, '.rsc', 'omp-bridge.mjs')).href);
      const handlers = new Map();
      await factory({ on(name, fn) { handlers.set(name, fn); }, getActiveTools: () => ['ask'], pi: { settings: {} } });
      return handlers;
    };
    const wipe = { toolName: 'bash', input: { command: 'rm -rf /' } };

    writeSwitches(cwd, {});
    const on = await handlersAt(cwd);
    assert.equal((await on.get('tool_call')(wipe, ctx))?.block, true, 'on by default: the wipe is blocked');

    writeSwitches(cwd, { guards: false });
    const off = await handlersAt(cwd);
    assert.equal(await off.get('tool_call')(wipe, ctx), undefined, 'guards off: the bridge stays out of the way');

    await applyInstall({ skillIds: ['suggest'], target: 'omp', cwd: quiet });
    writeSwitches(quiet, { guards: false, native: false, memory: false, knowledge: false, lane: false, update: false });
    const silent = await handlersAt(quiet);
    const quietCtx = { ...ctx, cwd: quiet, sessionManager: { getSessionId: () => 'omp-quiet', getSessionFile: () => null } };
    await silent.get('session_start')({}, quietCtx);
    assert.ok(!existsSync(join(quiet, '.rsc', 'memory', 'anchors', 'omp--omp-quiet.json')),
      'memory off: no journal for the session');
    assert.equal(await silent.get('before_agent_start')({ reason: 'prompt' }, quietCtx), undefined,
      'everything off: no context chunk at all');
  } finally {
    if (saved === undefined) delete process.env.RSC_OMP_PLUGIN_CONFIG; else process.env.RSC_OMP_PLUGIN_CONFIG = saved;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(quiet, { recursive: true, force: true });
  }
});
