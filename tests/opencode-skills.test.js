// OpenCode discovers skills only under .opencode/skills (and .opencode/skill, plus the
// .claude/.agents compatibility roots). rsc used to link them into .opencode/rsc, which OpenCode
// never scanned: the files existed, the commands named them, and the model could not load them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyInstall, removeTargetInstall } from '../scripts/install-apply.js';
import { doctor } from '../scripts/doctor.js';
import { evaluateHarness } from '../targets/clone-bootstrap.mjs';
import { targetPaths } from '../targets/index.js';

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), 'rsc-open-skills-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  return cwd;
}

test('opencode-skills: skills land in the directory OpenCode discovers, state stays outside it', () => {
  const cwd = repo();
  const paths = targetPaths('opencode', undefined, cwd);
  assert.equal(paths.skillDir('fastapi'), join(cwd, '.opencode', 'skills', 'fastapi'));
  assert.equal(paths.stateFile, join(cwd, '.opencode', 'rsc', '.rsc-state.json'));

  return applyInstall({ skillIds: ['suggest', 'fastapi'], target: 'opencode', cwd }).then(() => {
    const skill = join(cwd, '.opencode', 'skills', 'fastapi');
    assert.ok(existsSync(join(skill, 'SKILL.md')), 'the skill is under .opencode/skills');
    if (process.platform === 'win32') assert.equal(lstatSync(skill).isDirectory(), true, 'Windows uses a real copy');
    else assert.equal(lstatSync(skill).isSymbolicLink(), true, 'the platform link is used');
    assert.equal(existsSync(join(cwd, '.opencode', 'rsc', 'fastapi')), false, 'nothing is left in the old rsc/ root');
    const state = JSON.parse(readFileSync(paths.stateFile, 'utf8'));
    assert.deepEqual(state.skills.fastapi.files, [skill]);
  });
});

test('opencode-skills: sync removes the old .opencode/rsc links but leaves a person\'s own directory', async (t) => {
  if (process.platform === 'win32') return t.skip('the old layout used symlinks on POSIX; Windows copies are not migrated');
  const cwd = repo();
  await applyInstall({ skillIds: ['suggest'], target: 'opencode', cwd });
  const oldRoot = join(cwd, '.opencode', 'rsc');
  mkdirSync(oldRoot, { recursive: true });
  symlinkSync('../../.rsc/skills/suggest', join(oldRoot, 'suggest'), 'dir');
  mkdirSync(join(oldRoot, 'mine'), { recursive: true });
  writeFileSync(join(oldRoot, 'mine', 'SKILL.md'), 'my own skill\n');

  await applyInstall({ skillIds: ['suggest', 'fastapi'], target: 'opencode', cwd });
  assert.equal(existsSync(join(oldRoot, 'suggest')), false, 'the rsc-owned old link is gone');
  assert.equal(existsSync(join(oldRoot, 'mine', 'SKILL.md')), true, 'the user\'s directory is untouched');
});

test('opencode-skills: doctor reports an install whose skills OpenCode cannot discover', () => {
  const cwd = repo();
  const paths = targetPaths('opencode', undefined, cwd);
  mkdirSync(join(cwd, '.opencode', 'rsc', 'legacy'), { recursive: true });
  writeFileSync(join(cwd, '.opencode', 'rsc', 'legacy', 'SKILL.md'), '# legacy\n');
  writeFileSync(paths.stateFile, JSON.stringify({
    skills: { legacy: { files: [join(cwd, '.opencode', 'rsc', 'legacy')], base: join(cwd, '.rsc', 'skills', 'legacy') } },
  }));
  const report = doctor({ target: 'opencode', cwd, home: cwd });
  assert.deepEqual(report.opencodeSkillsUnreachable, ['legacy']);
  assert.equal(report.healthy, false);
});

test('opencode-skills: a pre-migration state file can still be removed by removeTargetInstall', async (t) => {
  if (process.platform === 'win32') return t.skip('the legacy layout used symlinks on POSIX');
  const cwd = repo();
  await applyInstall({ skillIds: ['suggest'], target: 'opencode', cwd });
  const paths = targetPaths('opencode', undefined, cwd);
  const old = join(cwd, '.opencode', 'rsc', 'suggest');
  symlinkSync('../../.rsc/skills/suggest', old, 'dir');
  const state = JSON.parse(readFileSync(paths.stateFile, 'utf8'));
  state.skills.suggest.files = [old];
  writeFileSync(paths.stateFile, JSON.stringify(state));
  removeTargetInstall({ target: 'opencode', cwd, home: cwd });
  assert.equal(existsSync(old), false, 'the legacy link is removed with the install');
});

test('opencode-skills: a configured skills source makes an otherwise non-standard directory reachable', () => {
  const cwd = repo();
  const paths = targetPaths('opencode', undefined, cwd);
  mkdirSync(join(cwd, '.team-skills', 'legacy'), { recursive: true });
  writeFileSync(join(cwd, '.team-skills', 'legacy', 'SKILL.md'), '# legacy\n');
  writeFileSync(join(cwd, 'opencode.json'), JSON.stringify({ skills: ['./.team-skills'] }));
  mkdirSync(join(cwd, '.opencode', 'rsc'), { recursive: true });
  writeFileSync(paths.stateFile, JSON.stringify({
    skills: { legacy: { files: [join(cwd, '.team-skills', 'legacy')], base: join(cwd, '.rsc', 'skills', 'legacy') } },
  }));
  const report = doctor({ target: 'opencode', cwd, home: cwd });
  assert.deepEqual(report.opencodeSkillsUnreachable, []);
});

test('opencode-skills: clone bootstrap finds an own skill under .opencode/skills', () => {
  const cwd = repo();
  mkdirSync(join(cwd, '.opencode', 'skills', 'mine'), { recursive: true });
  writeFileSync(join(cwd, '.opencode', 'skills', 'mine', 'SKILL.md'), '# mine\n');
  const result = evaluateHarness(cwd, {
    state: 'declared', skills: [], own: ['mine'], optOuts: [], catalogVersion: null, tier: null,
  });
  assert.deepEqual(result.ownMissing, []);
});
