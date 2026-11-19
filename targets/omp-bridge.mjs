// rsc-omp-bridge:managed
//
// The runtime half of the Oh My Pi integration. OMP discovers `.omp/hooks/pre/rsc.js`, which is a
// thin committed loader; this file is the machine-local bridge that loader imports. It gives OMP
// the same lifecycle rsc gives Claude Code — session memory, update notice, knowledge sync, the
// per-turn lane gate and the deterministic guards — without pretending OMP reads Claude's settings.
//
// Memory and other optional integrations fail softly. Critical bash guard scripts are required
// when the installed policy selects them. Only the top-level session owns memory, update,
// knowledge and the copy guard: a subagent's turn is not a person's turn.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
// The native layer is optional like every sibling above: a `.rsc/` from before this module, or an
// interrupted copy, must cost the native settings, never the guards, memory or lane gate.
const native = await import('./omp-native.mjs').catch(() => null);
const NO_NATIVE = { available: false, applied: [], preserved: [], warnings: [], effective: {} };
const configureLiveOmpNative = (handle, hostRegistry) => (native?.configureLiveOmpNative
  ? native.configureLiveOmpNative(handle, hostRegistry) : Promise.resolve(NO_NATIVE));
const modeFromContext = (ctx, fallback = null) => {
  let state = fallback;
  try { state = ctx?.sessionModes?.getState?.() ?? fallback; }
  catch { /* use the last mode_changed snapshot */ }
  return state?.plan && typeof state.plan === 'object'
    ? { ...state, plan: state.plan.status }
    : state;
};
const nativeModeState = (ctx, fallback = null) => (native?.nativeModeState
  ? native.nativeModeState(ctx, fallback) : modeFromContext(ctx, fallback));
// OMP's Plan subagent allow-list plus the main-session question, task and todo controls.
const PLAN_TOOLS = new Set(['read', 'grep', 'glob', 'web_search', 'ast_grep', 'ask', 'todo', 'task']);
const PLAN_LINE = '- OMP Plan is ACTIVE: read/research/plan only; no edits, exec mutations, native /commit or implementation subagent until Plan is exited and rsc approval exists.';
const nativeGuidance = (ctx, pi, modes = null, applied = null, options = {}) => {
  if (native?.nativeGuidance) return native.nativeGuidance(ctx, pi, modes, applied, options);
  // Without the native module the Plan block still has to hold: it is the one gate that needs no
  // settings, only the mode state OMP exposes on the context.
  return nativeModeState(ctx, modes)?.plan === 'active' ? PLAN_LINE : '';
};
const liveNativeStatus = (handle, ctx, root, hostRegistry) => (native?.liveNativeStatus
  ? native.liveNativeStatus(handle, ctx, root, hostRegistry) : Promise.resolve({ ...NO_NATIVE, guardFiles: [] }));
const approvalGranted = (answer) => (native?.approvalGranted
  ? native.approvalGranted(answer) : answer === 'once');

/** Same contract as the module's, so a missing sibling can never open a critical guard. */
function guardVerdict(error, stdout, critical = false) {
  if (native?.guardVerdict) return native.guardVerdict(error, stdout, critical);
  if (error) {
    return critical
      ? { decision: 'deny', reason: 'rsc critical guard crashed/timed out; command denied. Repair harness or explicitly disable this guard.' }
      : null;
  }
  const raw = String(stdout ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw)?.hookSpecificOutput;
    if (parsed?.permissionDecision === 'allow') return null;
    if (parsed?.permissionDecision === 'ask' || parsed?.permissionDecision === 'deny') {
      return { decision: parsed.permissionDecision, reason: parsed.permissionDecisionReason || 'rsc guard denied this command.' };
    }
  } catch { /* invalid output */ }
  return critical
    ? { decision: 'deny', reason: 'rsc critical guard returned an invalid decision; command denied.' }
    : null;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
/** OMP derives its config root from os.homedir(). Git Bash exports a POSIX HOME on Windows, which
 *  path.join would turn into a drive-relative path; USERPROFILE is the native equivalent there. */
const homeOf = (env) => process.platform === 'win32'
  ? (env.USERPROFILE || env.HOME || homedir())
  : (env.HOME || homedir());
// A guard is a local Node script; five seconds is generous in normal use. Tests run many of them
// under a loaded two-core box, so the ceiling is configurable for that case only.
const GUARD_TIMEOUT = Number(process.env.RSC_OMP_GUARD_TIMEOUT) || 5000;

// A guard is plain Node, and the host is not always Node: OMP ships as a Bun-compiled `omp` binary,
// so its `process.execPath` starts a nested session instead of running the script — every critical
// guard then times out into a deny. Same rule as knowledge-sync's workerRuntime: only a real Node
// executable may run a guard. The Pi/OMP installer keeps its own Node for the `pi` launcher, but
// the `omp` binary does not put it on PATH; on a machine with no system Node that turned every
// command into `rsc critical guard crashed/timed out`. RSC_OMP_NODE overrides both candidates; a
// value that does not exist is ignored so a typo cannot brick every guard.
export function bundledNodePath(env = process.env) {
  const data = String(env.XDG_DATA_HOME || '').trim() || join(homeOf(env), '.local', 'share');
  return join(data, 'pi-node', 'current', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
}

export function guardRuntime(execPath = process.execPath, versions = process.versions, env = process.env) {
  if (!versions.bun && /^node(?:\.exe)?$/i.test(String(execPath).split(/[\\/]/).pop())) return execPath;
  const override = String(env.RSC_OMP_NODE || '').trim();
  if (override && existsSync(override)) return override;
  const bundled = bundledNodePath(env);
  return existsSync(bundled) ? bundled : 'node';
}

// Whether the host answers its own approval prompts. OMP resolves the policy before any prompt:
// under `yolo` (its default) read, write and exec are all auto-approved, and an extension's
// `ctx.ui.approve` comes back 'once' with nobody asked — so an `ask` from a critical guard would
// be granted silently. `always-ask`, `always-ask-cached` and `write` still confirm exec tools such
// as bash. An absent or unreadable registry cannot prove a prompt was shown, so it is treated the
// same way: critical guards must block instead of accepting an auto-grant.
export function hostAutoApproves(registry, scope) {
  try {
    const bash = String(registry?.lookup?.('tools.approval')?.get?.(scope)?.bash ?? '').toLowerCase();
    const mode = registry?.lookup?.('tools.approvalMode')?.get?.(scope);
    if (bash === 'allow') return true;
    if (bash === 'prompt') return false;
    // An absent/unknown registry is not evidence of a real approval dialog.
    return mode !== 'always-ask' && mode !== 'always-ask-cached' && mode !== 'write';
  } catch { return true; }
}

const HOST_AUTO_APPROVES = 'OMP answers tool approvals itself right now (tools.approvalMode = yolo, tools.approval.bash = allow, or no trustworthy approval registry), so this confirmation never reached you. Run the command yourself, or set tools.approvalMode to always-ask (or tools.approval.bash to prompt) and retry.';

// The plugin page in Settings → Plugins renders one toggle per boolean in the manifest's `settings`
// map (package.json → omp.settings). OMP stores what the person picks in its plugin registry; the
// bridge reads that registry at session start, so a toggle is the same opt-out for the committed
// project loader and for the machine-level resolver. Missing registry = every switch stays on.
export const PLUGIN_NAME = 'rsc-harness';
export const PLUGIN_SWITCHES = ['guards', 'native', 'memory', 'knowledge', 'lane', 'update'];

/** The registry OMP writes when a plugin toggle changes. Beside the agent dir; RSC_OMP_PLUGIN_CONFIG
 *  overrides it for tests and unusual layouts. */
export function pluginConfigPath(env = process.env) {
  if (env.RSC_OMP_PLUGIN_CONFIG) return env.RSC_OMP_PLUGIN_CONFIG;
  const home = homeOf(env);
  const profile = String(env.OMP_PROFILE ?? env.PI_PROFILE ?? '').trim();
  const named = /^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) && profile !== 'default'
    && profile !== '.' && profile !== '..' && !profile.endsWith('.');
  const suffix = named ? ['profiles', profile] : [];
  const normal = join(home, env.PI_CONFIG_DIR || '.omp', ...suffix);
  const useXdg = ['linux', 'darwin'].includes(process.platform)
    && (named || !String(env.PI_CODING_AGENT_DIR ?? '').trim()
      || resolve(env.PI_CODING_AGENT_DIR) === join(normal, 'agent'));
  const xdg = useXdg && env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, 'omp', ...suffix) : null;
  return join(xdg && existsSync(xdg) ? xdg : normal, 'plugins', 'omp-plugins.lock.json');
}

/** Pure read of the switch map: an unreadable or absent registry keeps the harness fully on. */
export function readPluginSwitches(env = process.env, cwd = ROOT, runtimeCwd = cwd) {
  const on = Object.fromEntries(PLUGIN_SWITCHES.map((key) => [key, true]));
  const read = (path) => { try { return JSON.parse(readFileSync(path, 'utf8'))?.settings?.[PLUGIN_NAME] || {}; } catch { return {}; } };
  const global = read(pluginConfigPath(env));
  // OMP hard-codes `.omp` for project-local files; PI_CONFIG_DIR only moves the machine root.
  const project = read(join(cwd, '.omp', 'plugin-overrides.json'));
  const local = runtimeCwd === cwd ? {} : read(join(runtimeCwd, '.omp', 'plugin-overrides.json'));
  const saved = { ...global, ...project, ...local };
  for (const key of PLUGIN_SWITCHES) {
    if (saved[key] === false || String(saved[key]).toLowerCase() === 'false') on[key] = false;
  }
  return on;
}

/** Global or project-level plugin disable is an opt-out even for a committed loader. */
export function isOmpPluginDisabled(env = process.env, cwd = ROOT) {
  try {
    const lock = JSON.parse(readFileSync(pluginConfigPath(env), 'utf8'));
    if (lock?.plugins?.[PLUGIN_NAME]?.enabled === false) return true;
  } catch { /* a project loader may run before the plugin is registered */ }
  try {
    const override = JSON.parse(readFileSync(join(cwd, '.omp', 'plugin-overrides.json'), 'utf8'));
    if (Array.isArray(override.disabled) && override.disabled.includes(PLUGIN_NAME)) return true;
  } catch { /* no project override */ }
  return false;
}

// rsc-omp-todo:managed
//
// OMP's live todo panel is fed by the model calling its native `todo` tool; an extension cannot
// write that state through a supported API. What an extension can do is make the first list the
// default: when `todo.eager` is not configured by the person, pin it to `always`. OMP then forces
// (or, on providers without forced tool choice, strongly reminds) one `todo init` before work.
// Opt-in only (`RSC_OMP_TODO_EAGER=1`): forced eager creates a list on Answer turns too, and the
// lanes decide when a panel belongs to the turn.
const TODO_EAGER_SETTING = 'todo.eager';
const TODO_OPT_OUT = 'RSC_NO_OMP_TODO';

const optional = async (name) => {
  try { return await import(new URL(name, import.meta.url)); } catch { return null; }
};

const loadAll = async () => {
  const [memory, update, knowledge, copy, ftd, gate, trunk] = await Promise.all([
    optional('./session-memory-adapter.mjs'),
    optional('./auto-update.mjs'),
    optional('./knowledge-sync.mjs'),
    optional('./copy-guard.mjs'),
    optional('./ftd-nudge.mjs'),
    optional('./hook-once.mjs'),
    optional('./trunk-policy.mjs'),
  ]);
  return { memory, update, knowledge, copy, ftd, gate, trunk };
};

const isMain = (ctx) => ctx?.agent?.kind !== 'sub';

function sessionId(event, ctx) {
  return event?.session_id || event?.sessionId || ctx?.sessionManager?.getSessionId?.()
    || `omp-${process.pid}`;
}

function messageText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  const content = message.content ?? message.message?.content ?? message.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

function nearestRoot(start, marker) {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, marker))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

function bashWorkingDirectory(sessionCwd, requestedCwd) {
  let path = requestedCwd || '.';
  if (/^file:\/\//iu.test(path)) path = fileURLToPath(path);
  // Virtual OMP directories run Bash in the session's host cwd. Bare slashes alias the workspace.
  if (/^\/+$/u.test(path) || path.includes('://')) path = '.';
  path = path.replace(/^~(?=[/\\]|$)/u, () => homedir());
  return realpathSync(resolve(sessionCwd, path));
}

function guardPolicies(policyRoot, gitRoot) {
  const state = readJson(join(policyRoot, '.omp', 'skills', '.rsc-state.json'));
  const manifest = readJson(join(policyRoot, '.rsc.json'));
  const policy = state?.policy ?? manifest?.onboarding?.plan?.policy ?? {};
  const managed = Boolean(state || (Array.isArray(manifest?.targets) && manifest.targets.includes('omp')));
  // Ship combines branch hygiene with ASDD and sello. Its marker disables only branch hygiene.
  return [
    { name: 'danger-guard.mjs', root: policyRoot,
      enabled: policy.dangerGuard !== false && !existsSync(join(policyRoot, '.rsc', '.no-danger-guard')),
      required: managed, critical: true },
    { name: 'ship-guard.mjs', root: gitRoot ?? policyRoot,
      enabled: policy.codeHooks !== false,
      required: Boolean(gitRoot) && managed, critical: true },
    { name: 'branch-guard.mjs', root: policyRoot, enabled: policy.codeHooks !== false },
    { name: 'gitmoji-guard.mjs', root: policyRoot,
      enabled: policy.codeHooks !== false && policy.gitmojiGuard !== false },
  ].map(guard => {
    const path = join(policyRoot, '.rsc', guard.name);
    return { ...guard, path, present: existsSync(path) };
  });
}

async function needsDeliveryApproval(policyRoot, command) {
  const asdd = await optional(pathToFileURL(join(policyRoot, '.rsc', 'asdd-gate.mjs')));
  if (asdd?.isPushOrPr(command)) return true;
  const shell = await optional(pathToFileURL(join(policyRoot, '.rsc', 'shell-unwrap.mjs')));
  const gitMerge = /(?:^|\s)(?:[^\s]+\/)?git\s+(?:(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--[^\s]+)\s+)*merge(?=\s|$)/u;
  return (shell?.expand(command) ?? [command]).some(segment => gitMerge.test(segment.replace(
    /"([^"\\]|\\.)*"|'[^']*'/gu, '""',
  )));
}

function runGuard(guard, payload, executionCwd) {
  if (!guard.enabled) return null;
  const { path, root, critical, present, required } = guard;
  if (!present && !required) return null;
  const failed = (reason) => ({
    decision: 'deny',
    reason: `${path}: ${reason} Run rsc sync in the harness project to repair it.`,
  });
  if (!present) return failed('Required guard is missing.');
  if (required && critical) {
    const dependencies = guard.name === 'ship-guard.mjs'
      ? ['shell-unwrap.mjs', 'sello.mjs', 'asdd-gate.mjs', 'spec-completeness.mjs', 'risk-policy.mjs', 'trunk-policy.mjs']
      : ['shell-unwrap.mjs'];
    const missing = dependencies.find(name => !existsSync(join(dirname(path), name)));
    if (missing) return failed(`Required guard dependency ${missing} is missing.`);
  }
  return new Promise((done) => {
    try {
      const child = execFile(guardRuntime(), [path, root], {
        cwd: executionCwd,
        timeout: GUARD_TIMEOUT,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 1 << 20,
        env: { ...process.env, RSC_OMP: '1' },
      }, (error, stdout) => {
        const verdict = guardVerdict(error, stdout, critical);
        if (critical && (error || verdict?.reason.startsWith('rsc critical guard returned'))) {
          done(failed(verdict.reason));
        } else {
          done(verdict);
        }
      });
      child.stdin.on('error', () => { /* the child may exit before reading */ });
      child.stdin.end(payload);
    } catch {
      done(critical ? failed('Guard could not start.') : null);
    }
  });
}

async function askPerson(ctx, reason) {
  try {
    if (isMain(ctx) && ctx?.hasUI && typeof ctx.ui?.approve === 'function') {
      const answer = await ctx.ui.approve({
        full: reason,
        compact: 'rsc guard: confirm this command before it runs',
      });
      return approvalGranted(answer);
    }
  } catch { /* no UI, or it closed: treat as not confirmed */ }
  return false;
}

/** One model-visible chunk. OMP's custom messages are not shown in the transcript by default. */
const customMessage = (chunks) => ({
  customType: 'rsc-context',
  content: chunks.join('\n\n'),
  display: false,
});

// Loaded lazily: older OMP builds do not expose the typed settings registry, and a missing package
// must cost one caught import, never a session. Cached either way.
let settingsRegistry;
let settingsRegistryTried = false;
async function loadSettingsRegistry() {
  if (settingsRegistryTried) return settingsRegistry;
  settingsRegistryTried = true;
  try { settingsRegistry = await import('@oh-my-pi/pi-coding-agent/config/registry'); }
  catch { settingsRegistry = null; }
  return settingsRegistry;
}

/**
 * Pure decision half, exported for tests: pin `todo.eager` to `always` only when the person has not
 * configured it. A project/global/env value always wins, so this is a default, not a policy.
 */
export function pinOmpTodoDefault(pi, lookup) {
  try {
    if (!pi?.pi?.settings || typeof lookup !== 'function') return false;
    const eager = lookup(TODO_EAGER_SETTING);
    // Older OMP builds without the typed registry (or without both methods) are left alone:
    // this is a convenience default, not a reason to guess at a setting we cannot read.
    if (!eager || typeof eager.isConfigured !== 'function' || typeof eager.override !== 'function') return false;
    if (eager.isConfigured(pi.pi.settings)) return false;
    eager.override(pi.pi.settings, 'always');
    return true;
  } catch {
    return false;
  }
}

/** The runtime half: honor both opt-outs, then pin the default through OMP's own registry. */
export async function applyOmpTodoDefault(pi, hostRegistry) {
  try {
    if (process.env[TODO_OPT_OUT] === '1') return false;
    if (existsSync(join(ROOT, '.rsc', '.no-omp-todo'))) return false;
    const registry = hostRegistry ?? await loadSettingsRegistry();
    return pinOmpTodoDefault(pi, registry?.lookup);
  } catch {
    return false;
  }
}

/**
 * OMP's native answer surface is `ask`, not a prose menu. The skills close with a compass whose
 * ➡️ line already carries 1–3 options; this per-turn line is what turns that menu into the native
 * form. It is intentionally limited to the interactive main session: subagents cannot prompt, and
 * print/RPC sessions throw on `ask`.
 */
export function askReminder(pi, ctx) {
  try {
    if (ctx?.mode !== 'tui' || !ctx?.hasUI) return '';
    const tools = pi?.getActiveTools?.();
    if (!Array.isArray(tools) || !tools.includes('ask')) return '';
    return '- Native question form: when the compass\'s ➡️ line offers 1–3 real options — and the lane is not autopilot — call the `ask` tool with a short HTML form and the recommended option preselected; keep the compass lines. Use prose only when `ask` is unavailable or the question is open-ended.';
  } catch {
    return '';
  }
}

const loadedApis = new WeakSet();

export default async function rscOmp(pi, hostRegistry) {
  // The project loader and the machine-level resolver can reach the same OMP process (a future OMP
  // that walks up for hooks, or an explicit --hook). Registering every event twice would double the
  // context and run every guard twice, so the API object is the identity of one registration.
  if (pi && typeof pi === 'object') {
    if (loadedApis.has(pi)) return;
    loadedApis.add(pi);
  }
  // The project loader can run independently of the plugin extension. Respect an
  // operator-disabled plugin, including the project-level disabled list.
  const launchCwd = resolve(process.cwd());
  const runtimeCwd = nearestRoot(launchCwd, '.rsc.json') === ROOT ? launchCwd : ROOT;
  if (isOmpPluginDisabled() || (runtimeCwd !== ROOT && isOmpPluginDisabled(process.env, runtimeCwd))) return;
  const mods = await loadAll();
  const switches = readPluginSwitches(process.env, ROOT, runtimeCwd);
  const initialNative = switches.native ? await configureLiveOmpNative(pi, hostRegistry) : NO_NATIVE;
  // Backward-compatible opt-in only. Unconditional todo.eager=always forces a list even on Answer.
  if (process.env.RSC_OMP_TODO_EAGER === '1') await applyOmpTodoDefault(pi, hostRegistry);
  const state = {
    resume: '',
    update: null,
    firstPrompt: true,
    stopRan: false,
    session: null,
    native: initialNative,
    nativeModes: null,
    warningsShown: false,
  };

  const projectOf = (dir) => {
    const start = resolve(dir || ROOT);
    try {
      if (mods.memory?.nearestHarness) return mods.memory.nearestHarness(start);
    } catch { /* fall through to the simple walk */ }
    let current = start;
    for (;;) {
      if (existsSync(join(current, '.rsc.json'))) return current;
      const parent = dirname(current);
      if (parent === current) return ROOT;
      current = parent;
    }
  };

  const lifecycle = (event, native, ctx) => {
    if (!switches.memory) return null;
    try {
      return mods.memory?.handleLifecycle?.({
        target: 'omp',
        event,
        native,
        cwd: resolve(ctx?.cwd || ROOT),
      }) || null;
    } catch {
      return null;
    }
  };

  // Opt-in OMP transcript presenters are display-only: never suppress tool errors or policy denials.
  if (typeof pi?.registerTranscriptPresenter === 'function') {
    pi.registerTranscriptPresenter(block => {
      if (block?.type !== 'toolCall' || block.isError || block.isPartial) return undefined;
      if (block.toolName === 'task' || block.toolName === 'todo') return 'compact';
      return undefined;
    });
  }

  // Native OMP diagnostics; reads active runtime settings, does not edit user config.
  if (typeof pi?.registerCommand === 'function') {
    pi.registerCommand('rsc-native-status', {
      description: 'Inspect OMP/rsc native capabilities, modes, approvals and memory',
      handler: async (_args, ctx) => {
        if (!native) {
          ctx?.ui?.notify?.('rsc/OMP: native module missing; run `rsc sync` to restore /rsc-native-status.', 'warning');
          return;
        }
        if (!switches.native) {
          ctx?.ui?.notify?.('rsc/OMP: the native integration is turned off in Settings → Plugins → rsc-harness.', 'info');
          return;
        }
        const applied = state.native;
        const cwd = resolve(ctx?.cwd || ROOT);
        const status = await liveNativeStatus(pi, ctx, projectOf(cwd), hostRegistry);
        const settings = ['task.steps','task.autoParallel','todo.eager','todo.midRunNudges','commit.enabled','session.worktreeScope','memory.backend']
          .map(k => k+'='+String(status[k]))
          .concat('tools.approval.eval='+String(status['tools.approval']?.eval));
        for (const key of ['tools.approvalMode', 'task.crossInstance', 'task.agentPrewalkAuto', 'mcp.evalNamespaces']) {
          if (status[key] !== undefined) settings.push(key+'='+JSON.stringify(status[key]));
        }
        const lines = [
          'rsc/OMP native',
          'Settings: '+ settings.join(', '),
          'Preserved: '+ applied.preserved.join(', '),
          'Warnings: '+ [...applied.warnings,...status.notes].join('; '),
          'Plan mode: '+ String(nativeModeState(ctx)?.plan || 'unknown'),
          'Guards: '+ guardPolicies(nearestRoot(cwd, '.rsc.json') ?? ROOT, nearestRoot(cwd, '.git'))
            .map(g => g.name+':'+(!switches.guards || !g.enabled ? 'off'
              : g.present ? 'present' : g.required ? 'missing (run rsc sync)' : 'optional')).join(', '),
        ];
        ctx?.ui?.notify?.(lines.join('\n'),'info');
      },
    });
  }

  const memoryChunks = (result) => {
    const chunks = [];
    if (!switches.memory) return chunks;
    try {
      const context = mods.memory?.contextFromNativeOutput?.('omp', result?.output);
      if (context) chunks.push(context);
    } catch { /* no adapter, no context */ }
    if (result?.output?.systemMessage) chunks.push(result.output.systemMessage);
    return chunks;
  };

  const begin = async (ctx) => {
    try {
      if (!isMain(ctx)) return;
      // A settings reload can drop a runtime override; re-pin before the first prompt of a session.
      const cwd = resolve(ctx?.cwd || ROOT);
      const id = sessionId(null, ctx);
      if (state.session && state.session.id !== id) {
        lifecycle('end', { session_id: state.session.id }, { cwd: state.session.cwd });
      }
      const session = { id, cwd };
      state.session = session;
      const settings = switches.native ? await configureLiveOmpNative(pi, hostRegistry) : NO_NATIVE;
      if (process.env.RSC_OMP_TODO_EAGER === '1') await applyOmpTodoDefault(pi, hostRegistry);
      if (state.session !== session) return;
      state.native = settings;
      state.nativeModes = nativeModeState(ctx);
      state.warningsShown = false;
      state.resume = '';
      state.firstPrompt = true;
      state.stopRan = false;
      state.update = null;
      const project = projectOf(cwd);
      const result = lifecycle('start', { session_id: sessionId(null, ctx) }, ctx);
      state.resume = switches.memory
        ? (mods.memory?.contextFromNativeOutput?.('omp', result?.output) || result?.resume?.context || '')
        : '';
      // This target extends an upstream npm package. A same-major automatic update from
      // @ericrisco/rsc can overwrite custom target-only code even if it recognizes 'omp'.
      // Opt-in after compatibility audit; keep normal updates for other targets unchanged.
      if (switches.update && !process.env.RSC_NO_UPDATE_CHECK && process.env.RSC_OMP_ALLOW_UPSTREAM_AUTO_UPDATE === '1' && mods.update?.updateNotice) {
        state.update = Promise.resolve()
          .then(() => mods.update.updateNotice(project))
          .then((notice) => String(notice || '').trim())
          .catch(() => '');
      }
    } catch { /* a session start must never fail the session */ }
  };

  pi.on('session_start', async (_event, ctx) => { await begin(ctx); });
  pi.on('session_switch', async (_event, ctx) => { await begin(ctx); });
  pi.on('session_clear', (_event, ctx) => {
    if (!isMain(ctx)) return;
    // /clear keeps the session ID. Do not rerun an update check or lose the rsc journal.
    state.firstPrompt = true;
    state.stopRan = false;
    state.update = null;
    state.nativeModes = nativeModeState(ctx);
    state.warningsShown = false;
    const restored = lifecycle('start', { session_id: sessionId(null, ctx) }, ctx);
    state.resume = switches.memory
      ? (mods.memory?.contextFromNativeOutput?.('omp', restored?.output) || restored?.resume?.context || '')
      : '';
  });
  pi.on('mode_changed', (event, ctx) => {
    if (isMain(ctx)) state.nativeModes = event?.state || nativeModeState(ctx);
  });
  pi.on('turn_start', (_event, ctx) => {
    if (!isMain(ctx)) return;
    // OMP may rerun before_agent_start with the same prompt. Consume only after turn acceptance.
    state.firstPrompt = false;
    state.resume = '';
  });
  pi.on('before_subagent_spawn', (event, ctx) => {
    if (!isMain(ctx)) return;
    const agentName = typeof event?.agent === 'string' ? event.agent : (event?.agent?.name || '');
    if (switches.native && nativeModeState(ctx, state.nativeModes)?.plan === 'active'
        && (agentName === 'developer' || process.env.RSC_OMP_STRICT_PLAN === '1'))
      return { block: true, reason: 'rsc: an implementation subagent (or any subagent under RSC_OMP_STRICT_PLAN=1) cannot start during Plan mode.' };
  });

  pi.on('before_agent_start', async (event, ctx) => {
    try {
      if (!isMain(ctx) || event?.reason === 'revive') return;
      // Each new prompt is a new turn: the previous turn's stop decision must not silence the copy
      // guard (or the knowledge checkpoint) for the rest of the session. A revive is a continuation
      // of the same turn and never reaches this line.
      state.stopRan = false;
      const cwd = resolve(ctx?.cwd || ROOT);
      const project = projectOf(cwd);
      const chunks = [];

      if (state.firstPrompt && state.update) {
        const session = state.session;
        const notice = await state.update;
        if (state.session !== session) return;
        if (notice) chunks.push(notice);
      }
      if (state.resume) chunks.push(state.resume);

      const sid = sessionId(event, ctx);
      for (const chunk of memoryChunks(lifecycle('request', { session_id: sid }, ctx))) chunks.push(chunk);

      if (switches.knowledge) {
        try {
          const said = mods.knowledge?.onRequest?.(project);
          if (said) chunks.push(`Cuéntale esto al usuario en una línea:\n${said}`);
        } catch { /* knowledge sync is optional and fail-open */ }
      }

      const ask = switches.native ? askReminder(pi, ctx) : '';
      if (ask) chunks.push(ask);
      const nativeHelp = switches.native
        ? nativeGuidance(ctx, pi, state.nativeModes, state.native, { warnings: !state.warningsShown })
        : '';
      if (state.native?.warnings?.length) state.warningsShown = true;
      if (nativeHelp) chunks.push(nativeHelp);

      // The lane gate goes last: it must be the most recent instruction on the turn, exactly as
      // Claude's UserPromptSubmit order makes it. Its modules are absent when the plan has no lane.
      if (switches.lane) {
        try {
          if (mods.gate?.SDD_GATE_TEXT && !existsSync(join(project, '.rsc', '.no-feature-gate'))) {
            let rule = '- Default branch state unknown: ask before a code change where it goes.\n';
            try {
              if (mods.trunk?.branchRuleLine) rule = mods.trunk.branchRuleLine(project);
            } catch { /* safe default above */ }
            chunks.push(mods.gate.SDD_GATE_TEXT + rule);
          }
        } catch { /* a missing gate must not cost the turn */ }
      }

      if (!chunks.length) return;
      return { message: customMessage(chunks) };
    } catch {
      return;
    }
  });

  // Guards run in every session: a subagent running `rm -rf` is still destructive.
  pi.on('tool_call', async (event, ctx) => {
    try {
      const plan = switches.native && nativeModeState(ctx, state.nativeModes)?.plan === 'active';
      const toolName = event?.toolName;
      const planTool = plan ? pi?.getAllTools?.().find(tool => tool.name === toolName) : null;
      const source = planTool?.sourceInfo;
      if (plan && (!PLAN_TOOLS.has(toolName) || planTool?.mcpServerName
          || (source && (source.source !== 'builtin' || (source.path && source.path !== `<builtin:${toolName}>`))))) {
        return { block: true, reason: `rsc: ${event.toolName} cannot mutate the workspace while OMP Plan mode is active. Exit Plan and obtain the accepted rsc approval first.` };
      }
      // Strict execution is opt-in: arbitrary JS eval can spawn shell commands
      // outside bash guards. Never pretend static inspection of eval is secure.
      if (process.env.RSC_OMP_STRICT_EXEC === '1' && event?.toolName === 'eval') {
        return { block: true, reason: 'rsc strict execution: eval is blocked because its subprocesses bypass rsc bash guards. Run a specific audited command through bash or unset RSC_OMP_STRICT_EXEC.' };
      }
      if (!switches.guards) return;
      if (event?.toolName !== 'bash') return;
      const command = event?.input?.command;
      if (typeof command !== 'string' || !command) return;
      const sessionCwd = resolve(ctx?.cwd || ROOT);
      const projectRoot = nearestRoot(sessionCwd, '.rsc.json') ?? ROOT;
      const requestedCwd = event?.input?.cwd;
      const executionCwd = bashWorkingDirectory(sessionCwd, requestedCwd);
      const gitRoot = nearestRoot(executionCwd, '.git');
      const policyRoot = nearestRoot(executionCwd, '.rsc.json') ?? projectRoot;
      const payload = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command },
        session_id: sessionId(null, ctx),
        cwd: executionCwd,
      });
      const guards = guardPolicies(policyRoot, gitRoot);
      const verdicts = await Promise.all(guards.map(guard => runGuard(guard, payload, executionCwd)));
      const ship = guards.find(guard => guard.name === 'ship-guard.mjs');
      if (ship.enabled && ship.present && await needsDeliveryApproval(policyRoot, command)) {
        verdicts.push({ decision: 'ask', reason: 'rsc: confirm publishing or merging this change.' });
      }
      const denial = verdicts.find(verdict => verdict?.decision === 'deny');
      if (denial) return { block: true, reason: denial.reason };
      const approvals = verdicts.filter(verdict => verdict?.decision === 'ask');
      if (!approvals.length) return;
      const reason = approvals.map(verdict => verdict.reason).join('\n');
      if (isMain(ctx) && ctx?.hasUI) {
        if (hostAutoApproves(hostRegistry ?? await loadSettingsRegistry(), pi?.pi?.settings)) {
          return { block: true, reason: `${reason}\n\n${HOST_AUTO_APPROVES}` };
        }
        if (await askPerson(ctx, `${reason}\n\nWorking directory: ${executionCwd}\nCommand: ${command}`)) return;
      }
      return {
        block: true,
        reason: `${reason}\n\nThe main session needs one interactive approval for this exact command.`,
      };
    } catch {
      if (switches.native && nativeModeState(ctx, state.nativeModes)?.plan === 'active') {
        return { block: true, reason: 'rsc: could not verify this tool during OMP Plan mode.' };
      }
      // If an unexpected runtime error occurs, do not silently permit a bash
      // command that may be destructive. Other tools retain their native policy.
      if (switches.guards && event?.toolName === 'bash')
        return { block: true, reason: 'rsc: bash guard evaluation failed; command denied. Inspect rsc doctor and the bridge logs.' };
      return;
    }
  });

  pi.on('tool_result', async (event, ctx) => {
    try {
      if (isMain(ctx) && event?.toolName === 'ask' && event?.details?.timedOut === true) {
        return { additionalContext: 'rsc/OMP: native ask timed out and submitted preselected values. This is NOT explicit approval of a spec, branch, merge, publish, destructive operation or other formal decision. Keep that decision pending until the person confirms it.' };
      }
      if (!isMain(ctx) || event?.isError) return;
      const cwd = resolve(ctx?.cwd || ROOT);
      const project = projectOf(cwd);
      const sid = sessionId(null, ctx);
      const input = event?.input || {};
      const chunks = [];

      if (event?.toolName === 'edit' || event?.toolName === 'write') {
        const file = input.file_path || input.path || input.filePath || null;
        for (const chunk of memoryChunks(lifecycle('edit', {
          session_id: sid,
          tool_input: file ? { file_path: file } : {},
        }, ctx))) chunks.push(chunk);
        try {
          const nudge = mods.ftd?.decide?.(project, {
            session_id: sid,
            tool_input: file ? { file_path: file } : {},
          });
          if (nudge) chunks.push(nudge);
        } catch { /* nudge is best-effort */ }
      } else if (event?.toolName === 'bash') {
        for (const chunk of memoryChunks(lifecycle('boundary', { session_id: sid }, ctx))) chunks.push(chunk);
      }

      if (chunks.length) return { additionalContext: chunks.join('\n\n') };
    } catch {
      return;
    }
  });

  pi.on('session_before_compact', async (_event, ctx) => {
    try {
      if (!isMain(ctx)) return;
      lifecycle('compact', { session_id: sessionId(null, ctx) }, ctx);
    } catch { /* memory is optional */ }
  });

  const turnDuties = async (event, ctx, canBlock) => {
    try {
      if (!isMain(ctx)) return;
      const cwd = resolve(ctx?.cwd || ROOT);
      const project = projectOf(cwd);
      const sid = sessionId(event, ctx);
      const stop = Boolean(event?.stop_hook_active);

      lifecycle('turn', { session_id: sid, stop_hook_active: stop }, ctx);
      if (switches.knowledge) {
        try { mods.knowledge?.onTurn?.(project); } catch { /* fail-open */ }
      }

      if (!canBlock || !mods.copy?.decide) return;
      const transcript = event?.session_file || ctx?.sessionManager?.getSessionFile?.();
      let verdict = null;
      try {
        verdict = mods.copy.decide(project, {
          last_assistant_message: messageText(event?.last_assistant_message),
          transcript_path: transcript,
          stop_hook_active: stop,
        });
      } catch { /* the copy guard fails open */ }
      if (verdict?.decision === 'block' && verdict.reason) {
        return { continue: true, additionalContext: verdict.reason };
      }
    } catch {
      return;
    }
  };

  pi.on('session_stop', async (event, ctx) => {
    if (!isMain(ctx) || state.stopRan) return;
    state.stopRan = true;
    return turnDuties(event, ctx, true);
  });

  // Older OMP builds may not expose session_stop. agent_end is the fallback, and it cannot block;
  // memory and knowledge still travel. `willContinue` settles are not a finished turn.
  pi.on('agent_end', async (event, ctx) => {
    try {
      if (!isMain(ctx) || event?.willContinue || event?.awaitingAsyncWork) return;
      if (state.stopRan) return;
      state.stopRan = true;
      await turnDuties(event, ctx, false);
    } catch { /* fail-open */ }
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    try {
      if (!isMain(ctx) || !state.session) return;
      const { id, cwd } = state.session;
      state.session = null;
      lifecycle('end', { session_id: id }, { cwd });
    } catch { /* process is leaving */ }
  });
}
