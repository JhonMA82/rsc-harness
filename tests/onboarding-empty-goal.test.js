// Regression: an empty answer to the only required free-text question (the goal) used to be accepted
// by the prompt and rejected only after the assistant picker. The person answered every remaining
// question, chose a target, pressed Enter, and read "Cancelled — nothing was touched" — which looks
// exactly like the target had been refused (reported as choosing Oh My Pi cancelling onboarding).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askRequired } from '../scripts/lib/ui.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'rsc.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('askRequired re-asks an empty answer instead of accepting it', async () => {
  const answers = ['', '   ', 'Build a demo'];
  const questions = [];
  const value = await askRequired('Goal? > ', undefined, async (question) => {
    questions.push(question);
    return answers.shift();
  });
  assert.equal(value, 'Build a demo');
  assert.equal(questions.length, 3, 'empty and whitespace-only answers are asked again');
});

// A pty is the only way to exercise the interactive path as the person sees it. `script` is part of
// util-linux, which the CI image has; other platforms skip rather than pretend to cover it.
const hasPty = process.platform === 'linux' && spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0;

test('onboard re-asks an empty goal before the assistant picker, and does not cancel at the end', { skip: !hasPty, timeout: 60000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rsc-empty-goal-'));
  const command = [
    JSON.stringify(process.execPath), JSON.stringify(CLI), 'onboard',
    '--technical-level', 'technical', '--project-kind', 'software',
    '--software-scope', 'small', '--workflow', 'main',
  ].join(' ');
  const p = spawn('script', ['-qefc', command, '/dev/null'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color', RSC_NO_UPDATE_CHECK: '1' },
  });
  let out = '';
  p.stdout.on('data', (chunk) => { out += chunk; });
  p.stderr.on('data', (chunk) => { out += chunk; });
  const waitFor = async (text) => {
    const start = Date.now();
    while (!out.includes(text)) {
      if (Date.now() - start > 30000) throw new Error(`timed out waiting for ${JSON.stringify(text)}\n${out.slice(-1500)}`);
      await sleep(50);
    }
  };
  try {
    await waitFor('What do you want this project to achieve? >');
    p.stdin.write('\r');                                   // empty goal
    await waitFor('A goal is required');
    p.stdin.write('Build a demo\r');
    await waitFor('Which assistants do you want to install for?');
    p.stdin.write(' \r');                                  // toggle the detected assistant and confirm
    await waitFor('Accept this exact harness plan?');
    assert.doesNotMatch(out, /Cancelled — nothing was touched/);
  } finally {
    p.kill();
  }
});
