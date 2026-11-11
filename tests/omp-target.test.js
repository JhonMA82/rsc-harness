// Oh My Pi (omp) as a first-class rsc target. OMP discovers skills under `.omp/skills`, agents
// under `.omp/agents`, commands under `.omp/commands` and a project context file at
// `.omp/AGENTS.md`; its lifecycle hooks are extension factories under `.omp/hooks/pre/`. There is no
// project settings JSON, so rsc commits one thin loader and materializes the real bridge under
// `.rsc/`. These tests exercise that whole contract without installing OMP itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyInstall, removeTargetInstall } from '../scripts/install-apply.js';
import { doctor } from '../scripts/doctor.js';
import { detectTarget, targetPaths, TARGET_IDS } from '../targets/index.js';
import { OMP_LOADER, inspectOmpBridge, ompBridgeManagedPaths } from '../targets/omp-bridge.js';

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
    assert.match(read(cwd, '.omp', 'AGENTS.md'), /rsc-suggest:start/, 'the always-on block is in the project context file');

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

    const healthy = doctor({ target: 'omp', cwd });
    assert.equal(healthy.hookWired, true);
    assert.equal(healthy.ompBridge.mode, 'wired');
    assert.equal(healthy.healthy, true);

    rmSync(join(cwd, '.rsc', 'omp-bridge.mjs'));
    const broken = doctor({ target: 'omp', cwd });
    assert.equal(broken.ompBridge.mode, 'degraded');
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
    const loader = readFileSync(join(cwd, ...OMP_LOADER.split('/')), 'utf8');
    assert.equal(loader.match(/rsc-omp:managed/g).length, 1);

    removeTargetInstall({ target: 'omp', cwd });
    assert.ok(!existsSync(join(cwd, ...OMP_LOADER.split('/'))), 'the committed loader is withdrawn');
    assert.ok(!existsSync(join(cwd, '.rsc', 'omp-bridge.mjs')), 'the machine-local bridge is withdrawn');
    assert.ok(!existsSync(join(cwd, '.omp', 'skills', 'suggest')), 'the managed skill is withdrawn');
    assert.doesNotMatch(readFileSync(join(cwd, '.omp', 'AGENTS.md'), 'utf8'), /rsc-suggest:start/);
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
    await factory({ on(name, fn) { handlers.set(name, fn); } });
    for (const event of ['session_start', 'before_agent_start', 'tool_call', 'tool_result', 'session_stop', 'session_shutdown']) {
      assert.equal(typeof handlers.get(event), 'function', `${event} is subscribed`);
    }

    const ctx = {
      cwd,
      agent: { kind: 'main' },
      hasUI: false,
      sessionManager: { getSessionId: () => 'omp-main', getSessionFile: () => null },
    };
    await handlers.get('session_start')({}, ctx);
    assert.ok(existsSync(join(cwd, '.rsc', 'memory', 'anchors', 'omp--omp-main.json')), 'the session is journaled under its own id');

    const start = await handlers.get('before_agent_start')({ reason: 'prompt' }, ctx);
    assert.match(start.message.content, /rsc lane decisor/, 'the per-turn lane gate reaches the model');
    assert.equal(start.message.display, false, 'rsc context is not printed as if the person wrote it');

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
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
