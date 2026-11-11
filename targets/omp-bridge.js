// Oh My Pi (omp) runs project hooks discovered under `.omp/hooks/pre/*.js`. Unlike Claude Code
// there is no settings file to point at a script, so the wiring is one thin, committed loader and
// the real bridge under `.rsc/` — machine-local, like every other hook script rsc materializes.
//
// The loader is the only file OMP reads. It imports the bridge if it exists and stays silent when
// it does not, which is exactly what a fresh clone looks like: the hook travelled, the harness did
// not. No stack trace, no half-configured session.
//
// Everything under `.rsc/` is shared with the other targets. This module copies only what the
// bridge itself runs; memory, update and knowledge copy their own modules in their own wiring.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const OMP_LOADER = '.omp/hooks/pre/rsc.js';
const LOADER_MARKER = 'rsc-omp:managed';
const BRIDGE = 'omp-bridge.mjs';
const COPY = ['copy-guard.mjs', 'copy-rules.mjs'];
const DANGER = ['danger-guard.mjs', 'shell-unwrap.mjs'];
const CODE = [
  'shell-unwrap.mjs',
  'ship-guard.mjs', 'branch-guard.mjs', 'gitmoji-guard.mjs',
  'sello.mjs', 'asdd-gate.mjs', 'spec-completeness.mjs', 'trunk-policy.mjs',
];
const LANE = ['ftd-nudge.mjs', 'hook-once.mjs', 'trunk-policy.mjs'];

const LOADER_SOURCE = `// ${LOADER_MARKER}
// OMP loads every .omp/hooks/pre/*.js as an extension factory. The harness itself lives under
// .rsc/ (machine-local): a clone that has not run rsc yet has nothing to load, and this loader
// must stay silent instead of printing a module-not-found stack trace on every session.
export default async function rscOmp(pi) {
  try {
    const bridge = await import('../../../.rsc/omp-bridge.mjs');
    return await bridge.default(pi);
  } catch {
    // No harness here, or it was purged: nothing to enforce and nothing to say.
  }
}
`;

const unique = (items) => [...new Set(items)];

/** The modules this bridge runs with the given accepted plan. */
export function ompBridgeModuleNames(policy = {}) {
  const laneGate = policy.laneGate ?? policy.codeHooks !== false;
  return unique([
    BRIDGE,
    ...COPY,
    ...(policy.dangerGuard === false ? [] : DANGER),
    ...(policy.codeHooks === false ? [] : CODE),
    ...(laneGate ? LANE : []),
  ]);
}

export function ompBridgeManagedPaths({ cwd = process.cwd(), policy = {} } = {}) {
  return [
    join(cwd, ...OMP_LOADER.split('/')),
    ...ompBridgeModuleNames(policy).map((name) => join(cwd, '.rsc', name)),
  ];
}

function ours(path) {
  try { return readFileSync(path, 'utf8').includes(LOADER_MARKER); } catch { return false; }
}

function copyIfPresent(name, cwd) {
  copyFileSync(join(HERE, name), join(cwd, '.rsc', name));
}

/**
 * Materialize the bridge and its loader. Idempotent: every file is rewritten from the CLI's own
 * copy, and files a narrower plan turned off are removed so a re-onboard does not leave an armed
 * guard behind. Shared modules are never removed: another target in the same project may use them.
 */
export function wireOmpBridge(cwd = process.cwd(), policy = {}) {
  const wanted = new Set(ompBridgeModuleNames(policy));
  const rsc = join(cwd, '.rsc');
  mkdirSync(rsc, { recursive: true });
  for (const name of wanted) copyIfPresent(name, cwd);

  const removed = [];
  const disabled = [
    ...(policy.dangerGuard === false ? DANGER : []),
    ...(policy.codeHooks === false ? CODE : []),
  ];
  const laneGate = policy.laneGate ?? policy.codeHooks !== false;
  if (!laneGate) disabled.push(...LANE);
  // trunk-policy is shared with knowledge sync: never remove it here. hook-once is shared with
  // Claude's session-start; same reason.
  for (const name of new Set(disabled.filter((name) => name !== 'trunk-policy.mjs' && name !== 'hook-once.mjs'))) {
    if (wanted.has(name)) continue;
    const file = join(rsc, name);
    if (existsSync(file)) { rmSync(file, { force: true }); removed.push(file); }
  }

  const loader = join(cwd, ...OMP_LOADER.split('/'));
  if (!existsSync(loader) || !ours(loader)) {
    mkdirSync(dirname(loader), { recursive: true });
    writeFileSync(loader, LOADER_SOURCE);
  }
  return { mode: 'wired', paths: ompBridgeManagedPaths({ cwd, policy }), removed };
}

/** The inverse: the loader and the bridge entry. Guard siblings stay for the other targets. */
export function unwireOmpBridge(cwd = process.cwd()) {
  const touched = [];
  const loader = join(cwd, ...OMP_LOADER.split('/'));
  if (ours(loader)) { rmSync(loader, { force: true }); touched.push(loader); }
  const bridge = join(cwd, '.rsc', BRIDGE);
  if (existsSync(bridge)) { rmSync(bridge, { force: true }); touched.push(bridge); }
  return touched;
}

/** Artifacts a dry-run purge should report without touching anything. */
export function ompBridgeArtifactsPresent(cwd = process.cwd()) {
  const out = [];
  const loader = join(cwd, ...OMP_LOADER.split('/'));
  if (ours(loader)) out.push(loader);
  const bridge = join(cwd, '.rsc', BRIDGE);
  if (existsSync(bridge)) out.push(bridge);
  return out;
}

/** Doctor: the loader is ours, it names the bridge, and the bridge is on disk. */
export function inspectOmpBridge(cwd = process.cwd(), policy = {}) {
  const loader = join(cwd, ...OMP_LOADER.split('/'));
  const bridge = join(cwd, '.rsc', BRIDGE);
  const missing = [];
  let loaderBody = '';
  try { loaderBody = readFileSync(loader, 'utf8'); } catch { /* reported below */ }
  if (!loaderBody.includes(LOADER_MARKER)) missing.push(loader);
  if (loaderBody && !loaderBody.includes('.rsc/omp-bridge.mjs')) missing.push(loader);
  const expected = ompBridgeModuleNames(policy).filter((name) => name !== BRIDGE);
  for (const name of expected) {
    const file = join(cwd, '.rsc', name);
    if (!existsSync(file)) missing.push(file);
  }
  if (!existsSync(bridge)) missing.push(bridge);
  return {
    mode: missing.length ? 'degraded' : 'wired',
    status: missing.length ? 'degraded' : 'ready',
    missing,
    action: missing.length ? 'Run `npx @ericrisco/rsc sync` to restore the OMP hook bridge.' : null,
  };
}
