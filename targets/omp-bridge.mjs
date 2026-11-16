// rsc-omp-bridge:managed
//
// The runtime half of the Oh My Pi integration. OMP discovers `.omp/hooks/pre/rsc.js`, which is a
// thin committed loader; this file is the machine-local bridge that loader imports. It gives OMP
// the same lifecycle rsc gives Claude Code — session memory, update notice, knowledge sync, the
// per-turn lane gate and the deterministic guards — without pretending OMP reads Claude's settings.
//
// Every sibling import is optional and loaded in a try/catch. A project that disabled memory, or a
// clone that only has part of `.rsc/`, still runs what is there; nothing here may throw inside an
// OMP event. Tool guards run in every session. Only the top-level session owns memory, update,
// knowledge and the copy guard: a subagent's turn is not a person's turn.
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The native layer is optional like every sibling above: a `.rsc/` from before this module, or an
// interrupted copy, must cost the native settings, never the guards, memory or lane gate.
const native = await import('./omp-native.mjs').catch(() => null);
const NO_NATIVE = { available: false, applied: [], preserved: [], warnings: [], effective: {} };
const configureLiveOmpNative = (handle) => (native?.configureLiveOmpNative
  ? native.configureLiveOmpNative(handle) : Promise.resolve(NO_NATIVE));
const modeFromContext = (ctx, fallback = null) => {
  try { return ctx?.sessionModes?.getState?.() ?? fallback; } catch { return fallback; }
};
const nativeModeState = (ctx, fallback = null) => (native?.nativeModeState
  ? native.nativeModeState(ctx, fallback) : modeFromContext(ctx, fallback));
const PLAN_LINE = '- OMP Plan is ACTIVE: read/research/plan only; no edits, exec mutations, native /commit or implementation subagent until Plan is exited and rsc approval exists.';
const nativeGuidance = (ctx, pi, modes = null, applied = null, options = {}) => {
  if (native?.nativeGuidance) return native.nativeGuidance(ctx, pi, modes, applied, options);
  // Without the native module the Plan block still has to hold: it is the one gate that needs no
  // settings, only the mode state OMP exposes on the context.
  return nativeModeState(ctx, modes)?.plan === 'active' ? PLAN_LINE : '';
};
const liveNativeStatus = (handle, ctx, root) => (native?.liveNativeStatus
  ? native.liveNativeStatus(handle, ctx, root) : Promise.resolve({ ...NO_NATIVE, guardFiles: [] }));
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
// A guard is a local Node script; five seconds is generous in normal use. Tests run many of them
// under a loaded two-core box, so the ceiling is configurable for that case only.
const GUARD_TIMEOUT = Number(process.env.RSC_OMP_GUARD_TIMEOUT) || 5000;

// A guard is plain Node, and the host is not always Node: OMP ships as a Bun-compiled `omp` binary,
// so its `process.execPath` starts a nested session instead of running the script — every critical
// guard then times out into a deny. Same rule as knowledge-sync's workerRuntime: only a real Node
// executable may run a guard, and a Bun host always falls back to the `node` on PATH.
export function guardRuntime(execPath = process.execPath, versions = process.versions) {
  return !versions.bun && /^node(?:\.exe)?$/i.test(String(execPath).split(/[\\/]/).pop()) ? execPath : 'node';
}

// Whether the host answers its own approval prompts. OMP resolves the policy before any prompt:
// under `yolo` (its default) read, write and exec are all auto-approved, and an extension's
// `ctx.ui.approve` comes back 'once' with nobody asked — so an `ask` from a critical guard would
// be granted silently. `always-ask`, `always-ask-cached` and `write` still confirm exec tools such
// as bash. No registry (older OMP, a bare install) keeps the old behaviour: `ui.approve` decides.
export function hostAutoApproves(registry, scope) {
  try {
    const bash = String(registry?.lookup?.('tools.approval')?.get?.(scope)?.bash ?? '').toLowerCase();
    if (bash === 'prompt') return false;
    if (bash === 'allow') return true;
    return registry?.lookup?.('tools.approvalMode')?.get?.(scope) === 'yolo';
  } catch { return false; }
}

const HOST_AUTO_APPROVES = 'OMP answers tool approvals itself right now (tools.approvalMode = yolo or tools.approval.bash = allow), so this confirmation never reached you. Run the command yourself, or set tools.approvalMode to always-ask (or tools.approval.bash to prompt) and retry.';

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

function runGuard(script, root, payload, cwd, critical = false) {
  return new Promise((done) => {
    if (!existsSync(script)) { done(null); return; }
    let child;
    try {
      child = execFile(guardRuntime(), [script, root], {
        cwd: cwd || root,
        timeout: GUARD_TIMEOUT,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 1 << 20,
        env: { ...process.env, RSC_OMP: '1' },
      }, (error, stdout) => {
        const verdict = guardVerdict(error, stdout, critical);
        done(verdict ? { ...verdict, critical } : verdict);
      });
      child.stdin.on('error', () => { /* the child may exit before reading */ });
      child.stdin.end(payload);
    } catch (error) {
      done(guardVerdict(error, '', critical));
    }
  });
}

async function askPerson(ctx, reason) {
  try {
    if (ctx?.hasUI && typeof ctx.ui?.approve === 'function') {
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
export async function applyOmpTodoDefault(pi) {
  try {
    if (process.env[TODO_OPT_OUT] === '1') return false;
    if (existsSync(join(ROOT, '.rsc', '.no-omp-todo'))) return false;
    const registry = await loadSettingsRegistry();
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

export default async function rscOmp(pi) {
  // The project loader and the machine-level resolver can reach the same OMP process (a future OMP
  // that walks up for hooks, or an explicit --hook). Registering every event twice would double the
  // context and run every guard twice, so the API object is the identity of one registration.
  if (pi && typeof pi === 'object') {
    if (loadedApis.has(pi)) return;
    loadedApis.add(pi);
  }
  const mods = await loadAll();
  const initialNative = await configureLiveOmpNative(pi);
  // Backward-compatible opt-in only. Unconditional todo.eager=always forces a list even on Answer.
  if (process.env.RSC_OMP_TODO_EAGER === '1') await applyOmpTodoDefault(pi);
  const state = {
    resume: '',
    update: null,
    firstPrompt: true,
    stopRan: false,
    ended: false,
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
        const applied = await configureLiveOmpNative(pi);
        const cwd = resolve(ctx?.cwd || ROOT);
        const status = await liveNativeStatus(pi, ctx, projectOf(cwd));
        const settings = ['task.steps','task.autoParallel','todo.eager','todo.midRunNudges','commit.enabled','session.worktreeScope','memory.backend']
          .map(k => k+'='+String(status[k]))
          .concat('tools.approval.eval='+String(status['tools.approval']?.eval));
        const lines = [
          'rsc/OMP native',
          'Settings: '+ settings.join(', '),
          'Preserved: '+ applied.preserved.join(', '),
          'Warnings: '+ [...applied.warnings,...status.notes].join('; '),
          'Plan mode: '+ String(nativeModeState(ctx)?.plan || 'unknown'),
          'Guards: '+ status.guardFiles.map(g => g.name+':'+(g.present?'present':'missing')).join(', '),
        ];
        ctx?.ui?.notify?.(lines.join('\n'),'info');
      },
    });
  }

  const memoryChunks = (result) => {
    const chunks = [];
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
      state.native = await configureLiveOmpNative(pi);
      if (process.env.RSC_OMP_TODO_EAGER === '1') await applyOmpTodoDefault(pi);
      state.nativeModes = nativeModeState(ctx);
      state.warningsShown = false;
      state.resume = '';
      state.firstPrompt = true;
      state.stopRan = false;
      state.ended = false;
      const cwd = resolve(ctx?.cwd || ROOT);
      const project = projectOf(cwd);
      const result = lifecycle('start', { session_id: sessionId(null, ctx) }, ctx);
      state.resume = mods.memory?.contextFromNativeOutput?.('omp', result?.output)
        || result?.resume?.context || '';
      // This target extends an upstream npm package. A same-major automatic update from
      // @ericrisco/rsc can overwrite custom target-only code even if it recognizes 'omp'.
      // Opt-in after compatibility audit; keep normal updates for other targets unchanged.
      if (!process.env.RSC_NO_UPDATE_CHECK && process.env.RSC_OMP_ALLOW_UPSTREAM_AUTO_UPDATE === '1' && mods.update?.updateNotice) {
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
    state.resume = mods.memory?.contextFromNativeOutput?.('omp', restored?.output)
      || restored?.resume?.context || '';
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
    if (nativeModeState(ctx, state.nativeModes)?.plan === 'active' && agentName === 'developer')
      return { block: true, reason: 'rsc: an implementation worker cannot start in native OMP Plan mode.' };
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

      if (state.firstPrompt) {
        if (state.update) {
          const notice = await state.update;
          if (notice) chunks.push(notice);
        }
      }
      if (state.resume) chunks.push(state.resume);

      const sid = sessionId(event, ctx);
      for (const chunk of memoryChunks(lifecycle('request', { session_id: sid }, ctx))) chunks.push(chunk);

      try {
        const said = mods.knowledge?.onRequest?.(project);
        if (said) chunks.push(`Cuéntale esto al usuario en una línea:\n${said}`);
      } catch { /* knowledge sync is optional and fail-open */ }

      const ask = askReminder(pi, ctx);
      if (ask) chunks.push(ask);
      const nativeHelp = nativeGuidance(ctx, pi, state.nativeModes, state.native, { warnings: !state.warningsShown });
      if (state.native?.warnings?.length) state.warningsShown = true;
      if (nativeHelp) chunks.push(nativeHelp);

      // The lane gate goes last: it must be the most recent instruction on the turn, exactly as
      // Claude's UserPromptSubmit order makes it. Its modules are absent when the plan has no lane.
      try {
        if (mods.gate?.SDD_GATE_TEXT && !existsSync(join(project, '.rsc', '.no-feature-gate'))) {
          let rule = '- Default branch state unknown: ask before a code change where it goes.\n';
          try {
            if (mods.trunk?.branchRuleLine) rule = mods.trunk.branchRuleLine(project);
          } catch { /* safe default above */ }
          chunks.push(mods.gate.SDD_GATE_TEXT + rule);
        }
      } catch { /* a missing gate must not cost the turn */ }

      if (!chunks.length) return;
      return { message: customMessage(chunks) };
    } catch {
      return;
    }
  });

  // Guards run in every session: a subagent running `rm -rf` is still destructive.
  pi.on('tool_call', async (event, ctx) => {
    try {
      if (event?.toolName !== 'bash') return;
      const command = event?.input?.command;
      if (typeof command !== 'string' || !command) return;
      const cwd = resolve(ctx?.cwd || ROOT);
      const project = projectOf(cwd);
      const sid = sessionId(null, ctx);
      const payload = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command },
        session_id: sid,
        cwd,
      });
      // Claude-shaped stdin, one process per guard. They are independent by design; running them
      // together keeps the added latency near one Node start instead of four.
      const [danger, ship, branch, gitmoji] = await Promise.all([
        runGuard(join(project, '.rsc', 'danger-guard.mjs'), project, payload, project, true),
        runGuard(join(project, '.rsc', 'ship-guard.mjs'), cwd, payload, cwd, true),
        runGuard(join(project, '.rsc', 'branch-guard.mjs'), project, payload, project),
        runGuard(join(project, '.rsc', 'gitmoji-guard.mjs'), project, payload, project),
      ]);
      for (const verdict of [danger, ship, branch, gitmoji]) {
        if (!verdict) continue;
        if (verdict.decision === 'deny') return { block: true, reason: verdict.reason };
        if (verdict.decision === 'ask') {
          // The host's answer is only evidence when the host asks. Under yolo (or a bash=allow
          // policy) `ui.approve` resolves without a person, so a critical guard blocks instead.
          if (verdict.critical && hostAutoApproves(await loadSettingsRegistry(), pi?.pi?.settings)) {
            return { block: true, reason: `${verdict.reason}\n\n${HOST_AUTO_APPROVES}` };
          }
          if (await askPerson(ctx, verdict.reason)) continue;
          return {
            block: true,
            reason: `${verdict.reason}\n\nNo interactive approval was available, so the command did not run. `
              + 'Ask the person to confirm it or to run it themselves.',
          };
        }
      }
    } catch {
      // OMP treats a throw here as a block. Fail-open is the contract.
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
      try { mods.knowledge?.onTurn?.(project); } catch { /* fail-open */ }

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
      if (!isMain(ctx) || state.ended) return;
      state.ended = true;
      lifecycle('end', { session_id: sessionId(null, ctx) }, ctx);
    } catch { /* process is leaving */ }
  });
}
