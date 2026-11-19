import { accessSync, constants, statSync, realpathSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'node:path';

import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../rsc.js', import.meta.url));
const FORK = 'github:JhonMA82/rsc-harness';

function packageOrigin(entry) {
  try {
    const actual = realpathSync(entry);
    const root = dirname(dirname(actual));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (pkg.name !== '@ericrisco/rsc' || typeof pkg.bin?.rsc !== 'string'
        || realpathSync(resolve(root, pkg.bin.rsc)) !== actual) return null;
    const distribution = pkg.rscDistribution === FORK
      && pkg.repository?.url === 'git+https://github.com/JhonMA82/rsc-harness.git'
      ? FORK : pkg.repository?.url === 'git+https://github.com/ericrisco/rsc-harness.git'
        ? 'npm:@ericrisco/rsc' : 'unknown';
    return { entry: actual, distribution, version: pkg.version, repository: pkg.repository?.url };
  } catch { return null; }
}

export const activeCli = () => packageOrigin(ENTRY);
export const forkProject = manifest => Boolean(manifest?.rscDistribution === FORK || manifest?.targets?.includes('omp'));

export function forkCliCommand() {
  // Render an explicit entry so an alias, shim or changing PATH cannot select another package.
  if (process.platform === 'win32') return `node '${ENTRY.replaceAll("'", "''")}'`;
  return `node '${ENTRY.replaceAll("'", "'\\''")}'`;
}

// Inspect PATH, never execute a candidate just to discover it. Ignore relative PATH
// entries: a checked-out executable is not evidence of an installed CLI.
export function pathCli({ env = process.env, platform = process.platform } = {}) {
  const windows = platform === 'win32';
  const names = windows ? ['rsc.exe', 'rsc.cmd', 'rsc.bat', 'rsc'] : ['rsc'];
  for (const dir of (env.PATH || env.Path || '').split(windows ? ';' : ':')) {
    if (!dir || !isAbsolute(dir)) continue;
    // npm/npx inject these only for this process. They will not make `rsc`
    // available in the assistant's next shell after installation finishes.
    if (/(?:^|[\\/])_npx(?:[\\/]|$)|[\\/]node_modules[\\/]\.bin[\\/]?$/i.test(dir)) continue;
    for (const name of names) {
      try {
        const file = join(dir, name);
        if (!statSync(file).isFile()) continue;
        accessSync(file, windows ? constants.F_OK : constants.X_OK);
        const origin = packageOrigin(file);
        return { path: file, ...(origin ?? { distribution: 'unknown' }) };
      } catch { /* absent, unreadable or not executable */ }
    }
  }
  return null;
}

export function installedCli(options) {
  const candidate = pathCli(options);
  const active = activeCli();
  return Boolean(candidate && active && candidate.distribution === active.distribution && candidate.version === active.version);
}

export function cliInstructions(text, local = forkCliCommand()) {
  if (typeof local === 'string') {
    // These are generated recovery instructions, where a public version pin would select upstream.
    text = text.replace(/\bnpx[ \t]+(?:-y[ \t]+)?@ericrisco\/rsc@[^ \t`\n]+(?=[ \t]+(?:sync|doctor|repair|onboard|upgrade)\b)/g, () => local);
  }
  return local ? text.replace(/\bnpx[ \t]+(?:-y[ \t]+)?@ericrisco\/rsc(?=[ \t`\n]|$)/g, () => typeof local === 'string' ? local : 'rsc') : text;
}

export function materializeCliInstructions(dir, local) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) materializeCliInstructions(file, local);
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      const before = readFileSync(file, 'utf8');
      let after = cliInstructions(before, local);
      if (typeof local === 'string' && entry.name === 'SKILL.md' && /\nname: suggest\n/.test(before)) {
        after += '\n**RSC fork.** Use the installed fork entry shown in these instructions for sync, doctor and recovery. A version on the public npm package does not identify the fork. See the fork README for worktree setup.\n';
      }
      if (after !== before) writeFileSync(file, after);
    }
  }
}
