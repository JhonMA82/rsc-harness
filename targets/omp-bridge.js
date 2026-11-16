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
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const OMP_LOADER = '.omp/hooks/pre/rsc.js';
const LOADER_MARKER = 'rsc-omp:managed';
export const OMP_TODO_MARKER = 'rsc-omp-todo:managed';
export const OMP_USER_LOADER_MARKER = 'rsc-omp-user:managed';
export const OMP_PLUGIN_NAME = 'rsc-harness';
const BRIDGE = 'omp-bridge.mjs';
const COPY = ['copy-guard.mjs', 'copy-rules.mjs'];
const DANGER = ['danger-guard.mjs', 'shell-unwrap.mjs'];
const CODE = [
  'shell-unwrap.mjs', 'risk-policy.mjs',
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

// OMP discovers project hooks at `<cwd>/.omp/hooks/pre`, not at the repository root. Skills and
// context do walk up to the nearest `.omp/`, so opening OMP in a subdirectory shows the rsc skills
// while the adapter never loads — the exact half-installed look this resolver removes. Claude Code
// resolves its project settings from the repository root, which is why it does not have this gap.
//
// One machine-level hook, inert unless the project opted in with its own committed loader. At the
// project root OMP already discovers that loader, so this one stays out of the way and no event is
// registered twice.
const USER_LOADER_SOURCE = `// ${OMP_USER_LOADER_MARKER}
// OMP only discovers project hooks from the current directory. This machine-level resolver finds the
// nearest project with an rsc harness and loads its bridge when OMP was started in a subdirectory.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function projectRoot(start) {
  let current = resolve(start || process.cwd());
  const top = parse(current).root;
  for (;;) {
    if (existsSync(join(current, '.rsc.json'))) return current;
    if (current === top) return null;
    current = dirname(current);
  }
}

export default async function rscOmpUser(pi) {
  try {
    const cwd = resolve(process.cwd());
    const root = projectRoot(cwd);
    if (!root) return;
    // The project opts in by committing its own loader. No loader, no bridge: this resolver never
    // runs a project's code just because a .rsc.json travelled in a clone.
    const loader = join(root, '.omp', 'hooks', 'pre', 'rsc.js');
    if (!existsSync(loader) || !readFileSync(loader, 'utf8').includes('${LOADER_MARKER}')) return;
    // At the project root OMP discovers that loader itself; loading both would register every
    // handler twice.
    if (cwd === root) return;
    const bridge = await import(pathToFileURL(join(root, '.rsc', 'omp-bridge.mjs')).href);
    return await bridge.default(pi);
  } catch {
    // No harness, no bridge, or an unreadable project: stay silent, like the project loader.
  }
}
`;

/** OMP derives its config root from os.homedir(). Git Bash exports a POSIX HOME on Windows, which
 *  path.join would turn into a drive-relative path; USERPROFILE is the native equivalent there. */
function homeOf(env) {
  if (process.platform === 'win32') return env.USERPROFILE || env.HOME || homedir();
  return env.HOME || homedir();
}

/** OMP's machine-level agent directory, the same one it uses for user hooks and profiles. */
export function ompAgentDir(env = process.env) {
  const home = homeOf(env);
  const configDir = env.PI_CONFIG_DIR || '.omp';
  // Named profiles take priority over an inherited PI_CODING_AGENT_DIR, as OMP does.
  const profile = String(env.OMP_PROFILE ?? env.PI_PROFILE ?? '').trim();
  if (/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) && profile !== 'default'
      && profile !== '.' && profile !== '..' && !profile.endsWith('.')) {
    return join(home, configDir, 'profiles', profile, 'agent');
  }
  const value = String(env.PI_CODING_AGENT_DIR || '').trim();
  return value ? value : join(home, configDir, 'agent');
}

export function ompUserLoaderPath(env = process.env) {
  return join(ompAgentDir(env), 'hooks', 'pre', 'rsc.js');
}

/**
 * Install the machine-level resolver. It is rewritten while it is ours (so an upgrade reaches it),
 * and a file the person wrote there is never replaced. Like DeepSeek's bridge it is not removed on
 * uninstall: other projects on the same machine may rely on it, and without a project loader it
 * does nothing at all.
 */
export function wireOmpUserLoader(env = process.env) {
  const path = ompUserLoaderPath(env);
  try {
    if (existsSync(path) && !readFileSync(path, 'utf8').includes(OMP_USER_LOADER_MARKER)) {
      return { mode: 'manual', reason: 'loader-collision', path };
    }
  } catch { /* unreadable is treated as ours to write */ }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, USER_LOADER_SOURCE);
  return { mode: 'wired', path };
}

export function unwireOmpUserLoader(env = process.env) {
  const path = ompUserLoaderPath(env);
  try {
    if (!readFileSync(path, 'utf8').includes(OMP_USER_LOADER_MARKER)) return [];
  } catch { return []; }
  rmSync(path, { force: true });
  return [path];
}

/** Doctor: the resolver is present and ours. Absent is not unhealthy — the project loader still
 *  covers OMP started at the root; it only means subdirectory sessions lose the bridge. */
export function inspectOmpUserLoader(env = process.env) {
  const path = ompUserLoaderPath(env);
  let body = '';
  try { body = readFileSync(path, 'utf8'); } catch { /* absent */ }
  if (body.includes(OMP_USER_LOADER_MARKER)) return { mode: 'wired', path, action: null };
  if (body.trim()) return { mode: 'manual', path, action: 'A hook file you wrote is at the resolver path; rsc left it alone. Remove it or move it aside to let rsc install its own.' };
  return { mode: 'absent', path, action: 'Run `npx @ericrisco/rsc sync` to install it; without it, OMP started in a subdirectory does not load the project bridge.' };
}

/** The stable package OMP lists as a plugin. Its extension is the same resolver as the user hook. */
export function ompPluginDir(env = process.env) {
  return join(ompAgentDir(env), 'rsc-plugin');
}

/** Mirror OMP's XDG-aware *data* root (not its session/state root). */
export function ompPluginsRoot(env = process.env) {
  const home = homeOf(env);
  const configName = env.PI_CONFIG_DIR || '.omp';
  const profile = String(env.OMP_PROFILE ?? env.PI_PROFILE ?? '').trim();
  const named = /^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) && profile !== 'default'
    && profile !== '.' && profile !== '..' && !profile.endsWith('.');
  const suffix = named ? ['profiles', profile] : [];
  const normal = join(home, configName, ...suffix);
  // An explicitly overridden agent dir only affects the default profile's
  // agent hooks, not the plugin registry. XDG data is opt-in on migration.
  const xdg = env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, 'omp', ...suffix) : null;
  return join(xdg && existsSync(xdg) ? xdg : normal, 'plugins');
}

function cliVersion() {
  try { return JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
}

// One boolean per switch the bridge honours (readPluginSwitches). OMP's Settings → Plugins page
// renders these as on/off rows and stores them in its plugin registry; the descriptions are what
// the person reads under each row.
const PLUGIN_SETTINGS = {
  guards: { type: 'boolean', default: true, description: 'Run the bash guards (danger, ship, branch, gitmoji) on every command.' },
  native: { type: 'boolean', default: true, description: 'Apply and announce the OMP native settings (task steps, todo nudges, Plan gate).' },
  memory: { type: 'boolean', default: true, description: 'Journal the session and inject the continuation context.' },
  knowledge: { type: 'boolean', default: true, description: 'Run the knowledge sync on each turn.' },
  lane: { type: 'boolean', default: true, description: 'Inject the per-turn lane gate.' },
  update: { type: 'boolean', default: true, description: 'Show the rsc update notice once per session.' },
};

const pluginPackage = (version) => `${JSON.stringify({
  name: OMP_PLUGIN_NAME,
  version,
  type: 'module',
  omp: { extensions: ['./index.js'], settings: PLUGIN_SETTINGS },
}, null, 2)}\n`;

/** OMP keeps installed plugins in one machine-level registry, with a lock entry and a symlink. */
function pluginRegistration(env) {
  const root = ompPluginsRoot(env);
  try {
    const lock = JSON.parse(readFileSync(join(root, 'omp-plugins.lock.json'), 'utf8'));
    const entry = lock?.plugins?.[OMP_PLUGIN_NAME];
    return { registered: Boolean(entry) && existsSync(join(root, 'node_modules', OMP_PLUGIN_NAME)), version: entry?.version || null, root };
  } catch { return { registered: false, version: null, root }; }
}

/**
 * Make rsc visible in `omp plugin list`: a small package whose extension is the same resolver as
 * the machine-level hook. OMP's own installer registers it (idempotent). Best-effort: if the `omp`
 * binary is not on PATH the package is still written, and the hook covers the same sessions.
 */
export function wireOmpPlugin(env = process.env, version = cliVersion()) {
  const dir = ompPluginDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), pluginPackage(version));
  writeFileSync(join(dir, 'index.js'), USER_LOADER_SOURCE);
  const current = pluginRegistration(env);
  // `linked` means OMP already has a package entry pointing at this directory; it will load it
  // even when this run cannot or must not re-register. The installer uses it to avoid wiring the
  // legacy hook alongside a plugin OMP still loads.
  const linked = current.registered;
  if (linked && current.version === version) return { mode: 'wired', path: dir, registered: true, linked };
  if (String(env.RSC_NO_OMP_PLUGIN || '') === '1') return { mode: 'package', path: dir, registered: false, linked, reason: 'registration-disabled' };
  const bin = process.platform === 'win32' ? 'omp.exe' : 'omp';
  const result = spawnSync(bin, ['plugin', 'install', dir], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, ...env },
  });
  if (result.error || result.status !== 0) {
    return {
      mode: 'package', path: dir, registered: false, linked, reason: 'plugin-install-failed',
      message: String(result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 300),
    };
  }
  return { mode: 'wired', path: dir, registered: true, linked: true };
}

export function inspectOmpPlugin(env = process.env) {
  const dir = ompPluginDir(env);
  const present = existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'index.js'));
  const { registered } = pluginRegistration(env);
  if (registered) return { mode: 'wired', path: dir, registered: true, action: null };
  if (present) return { mode: 'package', path: dir, registered: false, action: 'Run `npx @ericrisco/rsc sync` with the `omp` binary on PATH to finish registering it; the hook already covers the same sessions.' };
  return { mode: 'absent', path: dir, registered: false, action: 'Run `npx @ericrisco/rsc sync` to install the OMP plugin package.' };
}

const unique = (items) => [...new Set(items)];

/** The modules this bridge runs with the given accepted plan. */
export function ompBridgeModuleNames(policy = {}) {
  const laneGate = policy.laneGate ?? policy.codeHooks !== false;
  return unique([
    BRIDGE,
    'omp-native.mjs',
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
  for (const name of [BRIDGE, 'omp-native.mjs']) {
    const file = join(cwd, '.rsc', name);
    if (existsSync(file)) { rmSync(file, { force: true }); touched.push(file); }
  }
  return touched;
}

/** Artifacts a dry-run purge should report without touching anything. */
export function ompBridgeArtifactsPresent(cwd = process.cwd()) {
  const out = [];
  const loader = join(cwd, ...OMP_LOADER.split('/'));
  if (ours(loader)) out.push(loader);
  for (const name of [BRIDGE, 'omp-native.mjs']) {
    const file = join(cwd, '.rsc', name);
    if (existsSync(file)) out.push(file);
  }
  return out;
}

/**
 * Doctor: the installed bridge contains the todo default. A bridge from a release before the
 * integration is still a working guard bridge, but it does not feed OMP's live task panel; the
 * action is the same one command, not a scary "broken".
 */
export function inspectOmpTodo(cwd = process.cwd()) {
  const path = join(cwd, '.rsc', BRIDGE);
  let body = '';
  try { body = readFileSync(path, 'utf8'); } catch { /* reported below */ }
  if (!body) {
    return { mode: 'missing', path, action: 'Run `npx @ericrisco/rsc sync` to restore the OMP bridge.' };
  }
  if (body.includes(OMP_TODO_MARKER)) return { mode: 'wired', path, action: null };
  return {
    mode: 'stale',
    path,
    action: 'Run `npx @ericrisco/rsc sync` to add the native OMP todo default to this bridge.',
  };
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
