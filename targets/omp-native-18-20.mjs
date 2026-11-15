/**
 * Target-local OMP 18.20.x interoperability. No changes to shared rsc skills or scripts.
 * Do not replace OMP's task/todo/ask runtimes: configure and use their native APIs.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const NATIVE_SETTINGS = [
  ['task.steps', true],
  ['task.autoParallel', 'suggest'],
  ['commit.enabled', process.env.RSC_OMP_NATIVE_COMMIT === '1'],
  ['session.worktreeScope', 'directory'],
];
const configured = (handle, scope) => typeof handle?.isConfigured === 'function' && handle.isConfigured(scope);
const get = (handle, scope) => { try { return handle?.get?.(scope); } catch { return undefined; } };
// A later call must not report the bridge's own defaults as the operator's explicit choices.
// Keyed by settings scope: the same key can be ours in one session and the operator's in another.
const appliedByBridge = new WeakMap();
const wasAppliedByBridge = (scope, key) => appliedByBridge.get(scope)?.has(key) === true;
const markAppliedByBridge = (scope, key) => {
  const keys = appliedByBridge.get(scope) || new Set();
  keys.add(key);
  appliedByBridge.set(scope, keys);
};

/** For testability accepts lookup; runtime imports the typed registry only once. */
export function configureOmpNative(pi, lookup) {
  const scope = pi?.pi?.settings;
  if (!scope || typeof lookup !== 'function') return { available: false, applied: [], preserved: [], warnings: [], effective: {} };
  const result = { available: true, applied: [], preserved: [], warnings: [], effective: {} };
  for (const [key, value] of NATIVE_SETTINGS) {
    try {
      const handle = lookup(key);
      if (!handle || typeof handle.override !== 'function' || typeof handle.isConfigured !== 'function') continue;
      if (configured(handle, scope)) {
        if (!wasAppliedByBridge(scope, key)) result.preserved.push(key);
        if (key === 'commit.enabled' && get(handle, scope) === true)
          result.warnings.push('commit.enabled=true: native /commit and eval commit bypass rsc bash guards; follow ship policy and test your approval boundary.');
        continue;
      }
      handle.override(scope, value);
      markAppliedByBridge(scope, key);
      result.applied.push(key);
    } catch (error) { result.warnings.push(`${key}: ${error?.message || String(error)}`); }
  }

  // OMP tools.approval is ONE map-valued setting. Merge without removing any existing rules.
  // A specific eval policy (allow, deny or prompt) is the operator's decision and wins.
  try {
    const handle = lookup('tools.approval');
    if (handle && typeof handle.override === 'function' && typeof handle.get === 'function') {
      const current = get(handle, scope);
      if (current && typeof current === 'object' && !Array.isArray(current)) {
        if (Object.hasOwn(current, 'eval')) {
          if (!wasAppliedByBridge(scope, 'tools.approval.eval')) result.preserved.push('tools.approval.eval');
          if (String(current.eval).toLowerCase() === 'allow')
            result.warnings.push('tools.approval.eval=allow: eval may execute shell/git outside bash guards.');
        } else {
          handle.override(scope, { ...current, eval: 'prompt' });
          markAppliedByBridge(scope, 'tools.approval.eval');
          result.applied.push('tools.approval.eval');
        }
      }
    }
  } catch (error) { result.warnings.push(`tools.approval.eval: ${error?.message || String(error)}`); }

  // OMP v18.20.2: off | capped | backoff. 'capped' sends at most two reminders.
  // Reassert only as an unset default, never overwrite user configuration.
  try {
    const handle = lookup('todo.midRunNudges');
    if (handle && typeof handle.override === 'function' && typeof handle.isConfigured === 'function' && !configured(handle, scope)) {
      try { handle.override(scope, 'capped'); markAppliedByBridge(scope, 'todo.midRunNudges'); result.applied.push('todo.midRunNudges'); }
      catch { result.warnings.push('todo.midRunNudges: value capped unavailable, using native default.'); }
    } else if (handle && configured(handle, scope) && !wasAppliedByBridge(scope, 'todo.midRunNudges')) result.preserved.push('todo.midRunNudges');
  } catch { /* unavailable on older OMP; no session failure */ }

  // What the session actually runs with, for guidance and /rsc-native-status. Read, never guess.
  for (const key of ['task.steps', 'task.autoParallel', 'todo.eager', 'todo.midRunNudges', 'commit.enabled', 'session.worktreeScope', 'memory.backend', 'tools.approval'])
    result.effective[key] = (() => { try { return lookup(key)?.get?.(scope); } catch { return undefined; } })();

  // Deliberately DO NOT force todo.eager='always': it conflicts with the read-only Answer lane.
  return result;
}

let registryPromise;
export async function configureLiveOmpNative(pi) {
  try {
    registryPromise ??= import('@oh-my-pi/pi-coding-agent/config/registry').catch(() => null);
    const registry = await registryPromise;
    const result = configureOmpNative(pi, registry?.lookup);
    const dualMemory = memoryCoexistenceWarning(registry?.lookup, pi);
    if (dualMemory) result.warnings.push(dualMemory);
    return result;
  } catch { return { available: false, applied: [], preserved: [], warnings: [], effective: {} }; }
}

export function approvalGranted(answer) {
  // `ctx.ui.approve` may return 'once' or a wider 'session' choice. Never infer consent
  // from truthiness, objects, an absent UI or a cached/unknown grant.
  return answer === 'once';
}

export function guardVerdict(error, stdout, critical = false) {
  if (error) return critical ? { decision: 'deny', reason: 'rsc critical guard crashed/timed out; command denied. Repair harness or explicitly disable this guard.' } : null;
  const raw = String(stdout ?? '').trim();
  if (!raw) return null; // A successful guard with no output means no objection.
  try {
    const parsed = JSON.parse(raw)?.hookSpecificOutput;
    if (parsed?.permissionDecision === 'allow') return null;
    if (parsed?.permissionDecision === 'ask' || parsed?.permissionDecision === 'deny')
      return { decision: parsed.permissionDecision, reason: parsed.permissionDecisionReason || 'rsc guard denied this command.' };
  } catch { /* invalid output */ }
  return critical ? { decision: 'deny', reason: 'rsc critical guard returned an invalid decision; command denied.' } : null;
}

/** OMP mode state: plan/goal are 'active' | 'paused' | 'inactive'. */
export function nativeModeState(ctx, fallback = null) {
  try { return ctx?.sessionModes?.getState?.() ?? fallback; }
  catch { return fallback; }
}

export function nativeGuidance(ctx, pi, fallbackModes = null, native = null, { warnings = true } = {}) {
  if (ctx?.agent?.kind === 'sub') return '';
  const modes = nativeModeState(ctx, fallbackModes);
  const tools = pi?.getActiveTools?.() || [];
  const effective = native?.effective || {};
  const lines = [];
  if (modes?.plan === 'active')
    lines.push('OMP Plan is ACTIVE: read/research/plan only; no edits, exec mutations, native /commit or implementation subagent until Plan is exited and rsc approval exists.');
  // Native tools already understand their schemas. Tell the model WHEN to use them, not how to fake them.
  // The effective values win: guidance must never contradict an explicit operator setting.
  if (Array.isArray(tools) && tools.includes('task')) {
    if (effective['task.steps'] !== false)
      lines.push('rsc/OMP task: when a single APPROVED ASDD checklist item has ordered dependent phases, use native task.steps (max 4 prompts) with the existing implementation agent; keep rsc task IDs and persist proof in rsc progress. Do not send task.file/taskFile (removed in OMP 18.19). Never split coupled files across agents.');
    else
      lines.push('rsc/OMP task: task.steps is off in this runtime. Run one prompt per approved checklist item; do not ask for stepped workers.');
    const auto = effective['task.autoParallel'];
    if (auto === 'on')
      lines.push('rsc/OMP parallel: task.autoParallel=on lets OMP create workers when independent work appears. rsc still owns the accepted plan and task contracts; obtain approval and never split coupled files across agents.');
    else if (auto === 'off')
      lines.push('rsc/OMP parallel: task.autoParallel=off in this runtime. Do not split work across agents; run the slices sequentially with the native task tool.');
    else
      lines.push('rsc/OMP parallel: task.autoParallel=suggest reports candidate independent work only. rsc makes the decision; obtain the accepted plan and use explicit task batch/parallel only where its contracts allow.');
  }
  if (Array.isArray(tools) && tools.includes('todo'))
    lines.push('rsc/OMP todo: use native panel on FTD/ASDD only, not Answer. Blockers stay in the durable rsc decision queue and show as pending (OMP removed todo blocked status). For multiple completed items use native multi-done.');
  if (Array.isArray(tools) && tools.includes('ask'))
    lines.push('rsc/OMP ask: structured decisions in clarify/specify/orient use native ask({html}) only with interactive UI; timeouts, preselected choices or a form answer are NOT formal consent to approve a spec, branch, merge, publish or destructive change. Get explicit operator confirmation at the point of action.');
  if (effective['commit.enabled'] === true)
    lines.push('rsc/OMP commit: native /commit and eval commit are ENABLED in this runtime and are not intercepted by rsc bash ship/branch/gitmoji guards. Use them only under the accepted ship policy; never no_verify to bypass checks.');
  else
    lines.push('rsc/OMP commit: native /commit and eval commit are not intercepted by rsc bash ship/branch/gitmoji guards. Keep disabled unless operator explicitly enabled and validated their security policy; never use no_verify to bypass checks.');
  if (warnings && native?.warnings?.length) lines.push('rsc OMP integration notices: ' + native.warnings.join(' | '));
  return lines.map(s => `- ${s}`).join('\n');
}

export function memoryCoexistenceWarning(lookup, pi) {
  try {
    const handle = lookup?.('memory.backend');
    const backend = get(handle, pi?.pi?.settings);
    if (!backend || backend === 'off') return '';
    return `OMP memory.backend=${backend} and rsc project memory both active. Keep rsc approved specs/decision wiki authoritative; avoid duplicate fact injection, inspect /memory view and rsc doctor.`;
  } catch { return ''; }
}

export function nativeStatus(pi, lookup, ctx, root) {
  const scope = pi?.pi?.settings;
  const value = (key) => { try { return lookup?.(key)?.get?.(scope); } catch { return undefined; } };
  const keys = ['task.steps','task.autoParallel','todo.eager','todo.midRunNudges','commit.enabled','session.worktreeScope','memory.backend','tools.approval'];
  const values = Object.fromEntries(keys.map(k=>[k,value(k)]));
  const modes = nativeModeState(ctx);
  const notes = [];
  if (values['memory.backend'] && values['memory.backend'] !== 'off') notes.push('Dual memory; rsc wiki remains authoritative');
  if (values['commit.enabled'] === true) notes.push('Native commit may bypass rsc shell guards');
  if (values['tools.approval']?.eval === 'allow') notes.push('Eval allowed; shell guards do not cover eval execution');
  return {
    ...values,
    modes,
    notes,
    guardFiles: ['danger-guard.mjs','ship-guard.mjs'].map(name=>({ name, present: existsSync(join(root,'.rsc',name)) })),
  };
}

/** Current native runtime status for OMP's /rsc-native-status command. */
export async function liveNativeStatus(pi, ctx, root) {
  try {
    registryPromise ??= import('@oh-my-pi/pi-coding-agent/config/registry').catch(() => null);
    const registry = await registryPromise;
    return nativeStatus(pi, registry?.lookup, ctx, root);
  } catch { return nativeStatus(pi, null, ctx, root); }
}
