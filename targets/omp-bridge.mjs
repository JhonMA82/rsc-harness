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

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const GUARD_TIMEOUT = 5000;

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

function runGuard(script, root, payload, cwd) {
  return new Promise((done) => {
    if (!existsSync(script)) { done(null); return; }
    let child;
    try {
      child = execFile(process.execPath, [script, root], {
        cwd: cwd || root,
        timeout: GUARD_TIMEOUT,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 1 << 20,
        env: { ...process.env, RSC_OMP: '1' },
      }, (error, stdout) => {
        // An empty stdout is "allow", including when the guard timed out. Only a parseable
        // decision can ever block a command; an internal failure must not brick the shell.
        const raw = String(stdout || '').trim();
        if (!raw) { done(null); return; }
        try {
          const decision = JSON.parse(raw)?.hookSpecificOutput;
          if (!decision?.permissionDecision) { done(null); return; }
          done({
            decision: decision.permissionDecision,
            reason: decision.permissionDecisionReason || 'rsc guard refused this command.',
          });
        } catch {
          done(null);
        }
      });
      child.stdin.on('error', () => { /* the child may exit before reading */ });
      child.stdin.end(payload);
    } catch {
      done(null);
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
      return Boolean(answer) && answer !== 'deny';
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
  const state = {
    resume: '',
    update: null,
    firstPrompt: true,
    stopRan: false,
    ended: false,
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
      state.resume = '';
      state.firstPrompt = true;
      state.stopRan = false;
      state.ended = false;
      const cwd = resolve(ctx?.cwd || ROOT);
      const project = projectOf(cwd);
      const result = lifecycle('start', { session_id: sessionId(null, ctx) }, ctx);
      state.resume = mods.memory?.contextFromNativeOutput?.('omp', result?.output)
        || result?.resume?.context || '';
      if (!process.env.RSC_NO_UPDATE_CHECK && mods.update?.updateNotice) {
        state.update = Promise.resolve()
          .then(() => mods.update.updateNotice(project))
          .then((notice) => String(notice || '').trim())
          .catch(() => '');
      }
    } catch { /* a session start must never fail the session */ }
  };

  pi.on('session_start', async (_event, ctx) => { await begin(ctx); });
  pi.on('session_switch', async (_event, ctx) => { await begin(ctx); });

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
        state.firstPrompt = false;
        if (state.update) {
          const notice = await state.update;
          if (notice) chunks.push(notice);
        }
      }
      if (state.resume) {
        chunks.push(state.resume);
        state.resume = '';
      }

      const sid = sessionId(event, ctx);
      for (const chunk of memoryChunks(lifecycle('request', { session_id: sid }, ctx))) chunks.push(chunk);

      try {
        const said = mods.knowledge?.onRequest?.(project);
        if (said) chunks.push(`Cuéntale esto al usuario en una línea:\n${said}`);
      } catch { /* knowledge sync is optional and fail-open */ }

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
        runGuard(join(project, '.rsc', 'danger-guard.mjs'), project, payload, project),
        runGuard(join(project, '.rsc', 'ship-guard.mjs'), cwd, payload, cwd),
        runGuard(join(project, '.rsc', 'branch-guard.mjs'), project, payload, project),
        runGuard(join(project, '.rsc', 'gitmoji-guard.mjs'), project, payload, project),
      ]);
      for (const verdict of [danger, ship, branch, gitmoji]) {
        if (!verdict) continue;
        if (verdict.decision === 'deny') return { block: true, reason: verdict.reason };
        if (verdict.decision === 'ask') {
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
