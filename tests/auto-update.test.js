import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// The update notice asked, and asking depended on an agent relaying it: people kept running bugs
// that were already fixed. Now a release in the same major installs itself in the background, and a
// new major still asks. `.rsc/.no-auto-update` brings the question back for every release.
//
// `npx` is replaced by a fake that records how it was called and does what a successful sync does to
// the one file the hook reads: it writes the new version into `.rsc/.version`.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_START = join(ROOT, 'targets', 'session-start.mjs');

function project(installed, { optOut = false, targets = ['claude', 'codex'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rsc-auto-'));
  mkdirSync(join(root, '.rsc'), { recursive: true });
  writeFileSync(join(root, '.rsc', '.version'), `${installed}\n`);
  writeFileSync(join(root, '.rsc.json'), JSON.stringify({ version: 1, targets, skills: [] }));
  if (optOut) writeFileSync(join(root, '.rsc', '.no-auto-update'), '');
  const fake = join(root, 'fake-npx.mjs');
  writeFileSync(fake, `
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--dry-run')) {
  if (!process.env.FAKE_REJECT_DRY) process.exit(0);
  if (process.env.FAKE_REJECT_DRY === 'unknown-target') process.stderr.write('rsc error: unknown target omp\\n');
  process.exit(1);
}
writeFileSync(${JSON.stringify(join(root, 'called.json'))}, JSON.stringify({ args, to: process.env.RSC_AUTO_UPDATE_TO }));
if (!process.env.FAKE_FAIL) writeFileSync(${JSON.stringify(join(root, '.rsc', '.version'))}, process.env.RSC_AUTO_UPDATE_TO + '\\n');
`);
  return { root, fake };
}

function sessionStart({ root, fake }, latest, extra = {}) {
  const suggest = join(root, 'suggest-SKILL.md');
  writeFileSync(suggest, '# suggest\n');
  return spawnSync('node', [SESSION_START, suggest, root], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RSC_NO_UPDATE_CHECK: '',
      RSC_LATEST_JSON: '',
      RSC_LATEST: latest,
      RSC_AUTO_UPDATE_CMD: JSON.stringify([process.execPath, fake]),
      ...extra,
    },
  }).stdout;
}

// The background process is detached: wait for its footprint, never for the hook.
function waitFor(path, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(path)) return true;
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},50)']);
  }
  return false;
}
function waitForText(path, re, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (re.test(readFileSync(path, 'utf8'))) return true; } catch { /* not there yet */ }
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},50)']);
  }
  return false;
}
const state = (root) => JSON.parse(readFileSync(join(root, '.rsc', 'auto-update.json'), 'utf8'));
const writeState = (root, s) => writeFileSync(join(root, '.rsc', 'auto-update.json'), JSON.stringify(s));
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

test('a minor in the same major installs itself, at that exact version, for every declared target', () => {
  const p = project('2.1.0');
  const out = sessionStart(p, '2.2.0');
  assert.match(out, /rsc updating/);
  assert.match(out, /next session/);
  assert.doesNotMatch(out, /update available/, 'nothing to ask');
  assert.ok(waitFor(join(p.root, 'called.json')), 'the background update ran');
  const called = JSON.parse(readFileSync(join(p.root, 'called.json'), 'utf8'));
  assert.deepEqual(called.args, ['sync', '--target', 'claude,codex']);
  assert.equal(called.to, '2.2.0', 'the version seen by the hook, never @latest');
  assert.deepEqual({ from: state(p.root).from, to: state(p.root).to }, { from: '2.1.0', to: '2.2.0' });
});

test('a patch installs itself too', () => {
  const p = project('2.1.0');
  assert.match(sessionStart(p, '2.1.1'), /rsc updating/);
  assert.ok(waitFor(join(p.root, 'called.json')));
});

test('the next session says once that it was updated, then stays quiet', () => {
  const p = project('2.1.0');
  sessionStart(p, '2.1.1');
  assert.ok(waitFor(join(p.root, 'called.json')));
  waitFor(join(p.root, 'never'), 300); // let the fake finish writing .version
  assert.equal(readFileSync(join(p.root, '.rsc', '.version'), 'utf8').trim(), '2.1.1');
  const second = sessionStart(p, '2.1.1');
  assert.match(second, /rsc updated itself in the background, from 2\.1\.0 to 2\.1\.1/);
  assert.doesNotMatch(sessionStart(p, '2.1.1'), /rsc updat/, 'said once');
});

test('a new major asks, and launches nothing', () => {
  const p = project('2.1.0');
  const out = sessionStart(p, '3.0.0');
  assert.match(out, /update available/);
  assert.match(out, /new major version/);
  assert.match(out, /if they say yes/);
  assert.equal(existsSync(join(p.root, '.rsc', 'auto-update.json')), false);
  assert.equal(waitFor(join(p.root, 'called.json'), 500), false);
});

test('with .no-auto-update every release asks, as before', () => {
  const p = project('2.1.0', { optOut: true });
  const out = sessionStart(p, '2.1.1');
  assert.match(out, /update available/);
  assert.doesNotMatch(out, /major/);
  assert.equal(waitFor(join(p.root, 'called.json'), 500), false);
});

test('an update still running is not launched again', () => {
  const p = project('2.1.0');
  writeState(p.root, { from: '2.1.0', to: '2.2.0', startedAt: hoursAgo(0.01) });
  const out = sessionStart(p, '2.2.0');
  assert.match(out, /still installing/);
  assert.equal(waitFor(join(p.root, 'called.json'), 500), false);
});

test('a failed update falls back to asking and is not retried the same day', () => {
  const p = project('2.1.0');
  writeState(p.root, { from: '2.1.0', to: '2.2.0', startedAt: hoursAgo(2) });
  const out = sessionStart(p, '2.2.0');
  assert.match(out, /update available/);
  assert.match(out, /did not finish/);
  assert.match(out, /auto-update\.log/);
  assert.equal(waitFor(join(p.root, 'called.json'), 500), false);
});

test('a failed update is retried after a day', () => {
  const p = project('2.1.0');
  writeState(p.root, { from: '2.1.0', to: '2.2.0', startedAt: hoursAgo(25) });
  assert.match(sessionStart(p, '2.2.0'), /rsc updating/);
  assert.ok(waitFor(join(p.root, 'called.json')));
});

test('a newer release than the failed one is tried at once', () => {
  const p = project('2.1.0');
  writeState(p.root, { from: '2.1.0', to: '2.2.0', startedAt: hoursAgo(2) });
  assert.match(sessionStart(p, '2.2.1'), /rsc updating/);
  assert.ok(waitFor(join(p.root, 'called.json')));
});

test('a release that cannot sync the declared targets is blocked, keeping the harness', () => {
  const p = project('2.1.0');
  sessionStart(p, '2.2.0', { FAKE_REJECT_DRY: 'unknown-target' });
  assert.ok(waitForText(join(p.root, '.rsc', 'auto-update.log'), /unknown target omp/), 'the candidate error is in the log');
  assert.ok(waitForText(join(p.root, '.rsc', 'auto-update.log'), /update blocked/), 'the skip is in the log');
  assert.ok(waitForText(join(p.root, '.rsc', 'auto-update.json'), /"blocked": true/), 'the block is recorded');
  assert.equal(existsSync(join(p.root, 'called.json')), false, 'the real sync never ran');
  assert.equal(readFileSync(join(p.root, '.rsc', '.version'), 'utf8').trim(), '2.1.0', 'the working version is untouched');
});

test('a blocked release is explained once and not retried', () => {
  const p = project('2.1.0');
  sessionStart(p, '2.2.0', { FAKE_REJECT_DRY: 'unknown-target' });
  assert.ok(waitForText(join(p.root, '.rsc', 'auto-update.json'), /"blocked": true/), 'the background preflight recorded the block');
  const started = state(p.root).startedAt;
  const first = sessionStart(p, '2.2.0', { FAKE_REJECT_DRY: 'unknown-target' });
  assert.match(first, /rsc update blocked/);
  assert.match(first, /cannot sync this project's declared targets \(claude, codex\)/);
  assert.match(first, /keeping 2\.1\.0/);
  assert.equal(state(p.root).startedAt, started, 'the notice did not launch another attempt');
  const second = sessionStart(p, '2.2.0', { FAKE_REJECT_DRY: 'unknown-target' });
  assert.doesNotMatch(second, /rsc update blocked|rsc updating|update available/);
  assert.equal(state(p.root).startedAt, started);
  assert.equal(existsSync(join(p.root, 'called.json')), false);
});

test('a blocked release is tried again when the declared targets change', () => {
  const p = project('2.1.0');
  sessionStart(p, '2.2.0', { FAKE_REJECT_DRY: 'unknown-target' });
  assert.ok(waitForText(join(p.root, '.rsc', 'auto-update.json'), /"blocked": true/));
  writeFileSync(join(p.root, '.rsc.json'), JSON.stringify({ version: 1, targets: ['claude'], skills: [] }));
  assert.match(sessionStart(p, '2.2.0'), /rsc updating/);
  assert.ok(waitFor(join(p.root, 'called.json')));
  const called = JSON.parse(readFileSync(join(p.root, 'called.json'), 'utf8'));
  assert.deepEqual(called.args, ['sync', '--target', 'claude']);
});

test('a newer release than the blocked one is tried at once', () => {
  const p = project('2.1.0');
  writeState(p.root, {
    from: '2.1.0', to: '2.2.0', startedAt: hoursAgo(2),
    blocked: true, blockedAt: hoursAgo(2), blockedTargets: ['claude', 'codex'], blockedReported: true,
  });
  assert.match(sessionStart(p, '2.2.1'), /rsc updating/);
  assert.ok(waitFor(join(p.root, 'called.json')));
});

test('a preflight failure that is not about targets keeps the daily retry', () => {
  const p = project('2.1.0');
  sessionStart(p, '2.2.0', { FAKE_REJECT_DRY: 'network' });
  assert.ok(waitForText(join(p.root, '.rsc', 'auto-update.log'), /failed its sync preflight/));
  assert.equal(state(p.root).blocked, undefined, 'a transient failure is not a block');
  assert.equal(readFileSync(join(p.root, '.rsc', '.version'), 'utf8').trim(), '2.1.0');
});

test('a version from the registry that is not a plain version launches nothing', () => {
  const p = project('2.1.0');
  const out = sessionStart(p, '2.2.0 && rm -rf ~');
  assert.doesNotMatch(out, /rsc updat/);
  assert.equal(waitFor(join(p.root, 'called.json'), 500), false);
});

test('a current install hears nothing', () => {
  const p = project('2.1.0');
  assert.doesNotMatch(sessionStart(p, '2.1.0'), /rsc updat|update available/);
});

// --- the same rule, for every assistant ---------------------------------------------------------

const MODULE = join(ROOT, 'targets', 'auto-update.mjs');
const runModule = ({ root, fake }, args, latest) => spawnSync('node', [MODULE, ...args], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, RSC_NO_UPDATE_CHECK: '', RSC_LATEST_JSON: '', RSC_LATEST: latest, RSC_AUTO_UPDATE_CMD: JSON.stringify([process.execPath, fake]) },
}).stdout;

test('run by an agent with no hook, the module updates and says so in plain text', () => {
  const p = project('2.1.0');
  const out = runModule(p, [], '2.2.0');
  assert.match(out, /rsc updating/);
  assert.ok(waitFor(join(p.root, 'called.json')));
  assert.match(runModule(project('2.1.0'), [], '2.1.0'), /up to date/);
});

test('as a session-start hook it answers in each assistant’s own shape', () => {
  const codex = JSON.parse(runModule(project('2.1.0', { optOut: true }), ['hook', 'codex'], '2.1.1'));
  assert.equal(codex.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(codex.hookSpecificOutput.additionalContext, /update available/);
  const cursor = JSON.parse(runModule(project('2.1.0', { optOut: true }), ['hook', 'cursor'], '2.1.1'));
  assert.match(cursor.additional_context, /update available/);
  assert.deepEqual(JSON.parse(runModule(project('2.1.0'), ['hook', 'gemini'], '2.1.0')), {}, 'nothing to say → empty object');
});

test('wiring: Codex, Gemini and Cursor get a session-start hook beside whatever is there', async () => {
  const { wireUpdate, unwireUpdate } = await import('../targets/update-wiring.js');
  for (const [target, file, event] of [['codex', '.codex/hooks.json', 'SessionStart'], ['gemini', '.gemini/settings.json', 'SessionStart'], ['cursor', '.cursor/hooks.json', 'sessionStart']]) {
    const cwd = mkdtempSync(join(tmpdir(), `rsc-wire-${target}-`));
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: 'command', command: 'node mine.mjs' }] }] } }));
    wireUpdate(target, cwd);
    wireUpdate(target, cwd); // idempotent
    const wired = JSON.parse(readFileSync(join(cwd, file), 'utf8')).hooks[event];
    assert.equal(wired.length, 2, `${target}: the user's hook plus one of ours`);
    assert.match(JSON.stringify(wired), new RegExp(`auto-update\\.mjs.*hook ${target}`));
    assert.ok(existsSync(join(cwd, '.rsc', 'auto-update.mjs')), `${target}: module copied`);
    unwireUpdate(target, cwd);
    const left = JSON.parse(readFileSync(join(cwd, file), 'utf8')).hooks[event];
    assert.deepEqual(left, [{ hooks: [{ type: 'command', command: 'node mine.mjs' }] }], `${target}: unwire leaves the user's hook`);
  }
});

test('wiring: an assistant with no hook still gets the module the agent is told to run', async () => {
  const { wireUpdate } = await import('../targets/update-wiring.js');
  const cwd = mkdtempSync(join(tmpdir(), 'rsc-wire-aider-'));
  assert.equal(wireUpdate('aider', cwd).mode, 'agent');
  assert.ok(existsSync(join(cwd, '.rsc', 'auto-update.mjs')));
  assert.equal(wireUpdate('claude', cwd).mode, 'hook');
});

// OpenCode's first call is its title generator: a notice handed over only once never reached the
// agent (seen with OpenCode 1.18.34). So every call carries it, and says to mention it once.
test('OpenCode: the plugin hands the notice to every call, checked once, said once', async () => {
  const { wireUpdate } = await import('../targets/update-wiring.js');
  const p = project('2.1.0', { optOut: true });
  wireUpdate('opencode', p.root);
  const saved = { ...process.env };
  Object.assign(process.env, { RSC_NO_UPDATE_CHECK: '', RSC_LATEST_JSON: '', RSC_LATEST: '2.1.1' });
  try {
    const { RscUpdatePlugin } = await import(join(p.root, '.opencode', 'plugins', 'rsc-update.js'));
    const hooks = await RscUpdatePlugin({ directory: p.root });
    const first = { system: ['base'] };
    await hooks['experimental.chat.system.transform']({}, first);
    assert.match(first.system[1], /update available/);
    assert.match(first.system[1], /only in your first reply/);
    const second = { system: ['base'] };
    await hooks['experimental.chat.system.transform']({}, second);
    assert.equal(second.system[1], first.system[1], 'the agent call after the title call still gets it');
  } finally {
    process.env = saved;
  }
});

test('the rules file of an assistant without hooks tells the agent to run the module', async () => {
  const { applyInstall } = await import('../scripts/install-apply.js');
  for (const [target, file] of [['aider', 'CONVENTIONS.md'], ['windsurf', '.windsurf/rules/rsc-suggest.md']]) {
    const cwd = mkdtempSync(join(tmpdir(), `rsc-rules-${target}-`));
    await applyInstall({ skillIds: ['suggest'], target, cwd });
    assert.ok(existsSync(join(cwd, '.rsc', 'auto-update.mjs')), `${target}: the module is there to run`);
    const rules = readFileSync(join(cwd, ...file.split('/')), 'utf8');
    assert.match(rules, /node \.rsc\/auto-update\.mjs/, `${target}: the agent is told to run it`);
  }
  // Claude Code checks from its hook: its always-on body does not carry the instruction.
  assert.doesNotMatch(readFileSync(join(ROOT, 'skills', 'suggest', 'SKILL.md'), 'utf8'), /auto-update\.mjs/);
});
