import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from './helpers/scratch.js';
import { applyInstall } from '../scripts/install-apply.js';

const text = (root, p) => readFileSync(join(root, p), 'utf8');
test('operational instructions use the verified fork entry despite a conflicting PATH', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rsc-local-cli-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const exe = join(bin, process.platform === 'win32' ? 'rsc.cmd' : 'rsc');
  writeFileSync(exe, '#!/bin/sh\nexit 99\n'); chmodSync(exe, 0o755);
  const old = process.env.PATH;
  t.after(() => { process.env.PATH = old; rmSync(root, { recursive: true, force: true }); });
  process.env.PATH = bin;
  writeFileSync(join(root, '.rsc.json'), JSON.stringify({ version: 1, targets: ['claude'], skills: [], gitPermissions: false }));
  mkdirSync(join(root, '.claude'));
  const permissions = { allow: ['Bash(git status)'], ask: ['Bash(rsc purge)'] };
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ permissions }));
  const options = { cwd: root, target: 'claude', skillIds: ['suggest', 'implement'], policy: { baseAgents: false, memory: false, codeHooks: false } };
  await applyInstall(options);
  assert.match(text(root, '.rsc/skills/implement/SKILL.md'), /node .*scripts[/\\]rsc\.js.* risk/);
  assert.doesNotMatch(text(root, '.rsc/skills/implement/SKILL.md'), /npx @ericrisco\/rsc risk/);
  assert.match(text(root, '.rsc/skills/suggest/SKILL.md'), /RSC fork/);
  assert.deepEqual(JSON.parse(text(root, '.claude/settings.json')).permissions, permissions);
  // Sync keeps the fork entry when the conflicting command disappears.
  rmSync(exe);
  await applyInstall(options);
  assert.match(text(root, '.rsc/skills/implement/SKILL.md'), /node .*scripts[/\\]rsc\.js.* risk/);
  assert.deepEqual(JSON.parse(text(root, '.claude/settings.json')).permissions, permissions);
});

import { installedCli, cliInstructions } from '../scripts/lib/cli-invocation.js';
import { reconcileCommands, resolveCommands } from '../targets/commands.js';

test('discovery ignores relative PATH entries and non-executable files; never runs the candidate', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rsc-cli-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'rsc');
  writeFileSync(file, 'This is deliberately not an executable program.');
  assert.equal(installedCli({ env: { PATH: '.:relative' }, platform: 'linux' }), false);
  assert.equal(installedCli({ env: { PATH: root }, platform: 'linux' }), false);
  chmodSync(file, 0o755);
  assert.equal(installedCli({ env: { PATH: root }, platform: 'linux' }), false);
  writeFileSync(join(root, 'rsc.cmd'), 'not executed');
  assert.equal(installedCli({ env: { PATH: root }, platform: 'win32' }), false);
});

test('rewriting leaves version pins, other packages and fallback instructions exact', () => {
  const source = '`npx @ericrisco/rsc risk`\nnpx -y @ericrisco/rsc doctor\nnpx @ericrisco/rsc@4.1.1 sync\nnpx @ericrisco/rsc@latest upgrade\nnpx @other/rsc risk';
  assert.equal(cliInstructions(source, false), source);
  assert.equal(cliInstructions(source, true), '`rsc risk`\nrsc doctor\nnpx @ericrisco/rsc@4.1.1 sync\nnpx @ericrisco/rsc@latest upgrade\nnpx @other/rsc risk');
});

test('slash commands use the installed CLI and keep user command collisions', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rsc-command-local-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const file = join(bin, process.platform === 'win32' ? 'rsc.cmd' : 'rsc');
  writeFileSync(file, 'not executed'); chmodSync(file, 0o755);
  const old = process.env.PATH; process.env.PATH = bin;
  t.after(() => { process.env.PATH = old; rmSync(root, { recursive: true, force: true }); });
  const commands = resolveCommands({ target: 'claude', skills: [], agents: [], memoryMode: 'full' });
  const result = reconcileCommands('claude', root, [], commands);
  assert.ok(result.written.length);
  const bodies = result.written.map((p) => readFileSync(p, 'utf8')).join('\n');
  assert.doesNotMatch(bodies, /npx @ericrisco\/rsc memory/);
  assert.match(bodies, /node .*scripts[/\\]rsc\.js.* memory/);
  const custom = result.written[0]; writeFileSync(custom, 'My command');
  reconcileCommands('claude', root, [], commands);
  assert.equal(readFileSync(custom, 'utf8'), 'My command');
});

test('npx and npm-injected package bins are not persistent PATH installations', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rsc-ephemeral-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const suffix of ['_npx/cache/node_modules/.bin', 'project/node_modules/.bin']) {
    const bin = join(root, suffix); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'rsc'), 'not executed'); chmodSync(join(bin, 'rsc'), 0o755);
    assert.equal(installedCli({ env: { PATH: bin }, platform: 'linux' }), false);
  }
});

test('same-version public CLI on PATH is identified and fork upgrade needs an explicit choice', { skip: process.platform === 'win32' }, async t => {
  const { spawnSync } = await import('node:child_process');
  const { symlinkSync } = await import('node:fs');
  const { activeCli, pathCli } = await import('../scripts/lib/cli-invocation.js');
  const cwd = mkdtempSync(join(tmpdir(), 'rsc-cli-origin-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const bin = join(cwd, 'bin');
  const upstream = join(cwd, 'upstream');
  mkdirSync(bin);
  mkdirSync(join(upstream, 'scripts'), { recursive: true });
  const { entry, version } = activeCli();
  writeFileSync(join(upstream, 'package.json'), JSON.stringify({
    name: '@ericrisco/rsc', version, bin: { rsc: 'scripts/rsc.js' },
    repository: { url: 'git+https://github.com/ericrisco/rsc-harness.git' },
  }));
  const upstreamEntry = join(upstream, 'scripts', 'rsc.js');
  writeFileSync(upstreamEntry, 'throw new Error("must not execute")', { mode: 0o755 });
  symlinkSync(upstreamEntry, join(bin, 'rsc'));
  const env = { ...process.env, PATH: bin };
  assert.equal(pathCli({ env }).distribution, 'npm:@ericrisco/rsc');
  assert.equal(installedCli({ env }), false);
  const origin = spawnSync(process.execPath, [entry, 'provenance'], { cwd, env, encoding: 'utf8' });
  assert.equal(origin.status, 0, origin.stderr);
  assert.equal(JSON.parse(origin.stdout).active.distribution, 'github:JhonMA82/rsc-harness');
  const upgrade = spawnSync(process.execPath, [entry, 'upgrade', '--global'], { cwd, env, encoding: 'utf8' });
  assert.notEqual(upgrade.status, 0);
  assert.match(upgrade.stderr, /reviewed fork checkout or tarball/);
});
