import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from './helpers/scratch.js';
import { join } from 'node:path';
import {
  AGENT_TARGET_IDS, targetHasAgents, writeDeveloperAgent, developerAgentPath,
  readDeveloperTier, writeDeveloperTier, writeAgents, agentPath,
} from '../targets/agents.js';

test('the 9 agent-capable targets each render a developer agent with the right model contract', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rsc-ag-'));
  assert.deepEqual([...AGENT_TARGET_IDS].sort(),
    ['claude', 'codex', 'copilot', 'cursor', 'gemini', 'junie', 'kiro', 'omp', 'opencode']);
  for (const t of AGENT_TARGET_IDS) {
    writeDeveloperAgent(t, cwd);
    const p = developerAgentPath(t, cwd);
    assert.ok(existsSync(p), `${t} agent written`);
    const c = readFileSync(p, 'utf8');
    // #298: OpenCode and OMP agents inherit the session's model by default, so they carry none;
    // every other target keeps its tier model.
    if (t === 'opencode' || t === 'omp') assert.doesNotMatch(c, /^model:/m, `${t} inherits the session model`);
    else assert.ok(/model/.test(c), `${t} carries a model`);
    // OMP preloads the discipline the agent body points at; no other target has this field.
    if (t === 'omp') assert.match(c, /^autoloadSkills: \[implement\]$/m, 'OMP developer autoloads implement');
    else assert.doesNotMatch(c, /^autoloadSkills:/m, `${t} has no OMP autoload field`);
    if (p.endsWith('.json')) assert.doesNotThrow(() => JSON.parse(c), `${t} json parses`);
  }
});

test('OMP agents autoload the one skill they name; other targets never do', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rsc-ag-omp-'));
  writeAgents('omp', cwd, 'balanced', ['rust-reviewer']);
  const rust = readFileSync(agentPath('omp', cwd, 'rust-reviewer'), 'utf8');
  assert.match(rust, /^autoloadSkills: \[rust\]$/m, 'a stack reviewer preloads its stack skill');

  writeAgents('claude', cwd, 'balanced', ['rust-reviewer']);
  const claude = readFileSync(agentPath('claude', cwd, 'rust-reviewer'), 'utf8');
  assert.doesNotMatch(claude, /^autoloadSkills:/m, 'the Claude agent format has no autoload field');
});

test('developer tier: balanced by default, heavy honored, light coerced to balanced (never light)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rsc-ag-'));
  assert.equal(readDeveloperTier(cwd), 'balanced');
  writeDeveloperTier(cwd, 'heavy');
  assert.equal(readDeveloperTier(cwd), 'heavy');
  writeDeveloperTier(cwd, 'light');
  assert.equal(readDeveloperTier(cwd), 'balanced');
});

test('balanced→Sonnet / heavy→Opus on Claude; the agent is never Haiku', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rsc-ag-'));
  writeDeveloperAgent('claude', cwd, 'balanced');
  let c = readFileSync(developerAgentPath('claude', cwd), 'utf8');
  assert.match(c, /model: sonnet/);
  assert.doesNotMatch(c, /haiku/i);
  writeDeveloperAgent('claude', cwd, 'heavy');
  c = readFileSync(developerAgentPath('claude', cwd), 'utf8');
  assert.match(c, /model: opus/);
});

test('targets without file-based agents get no developer agent', () => {
  assert.equal(targetHasAgents('codex'), true);
  assert.equal(targetHasAgents('aider'), false);
  assert.equal(targetHasAgents('cline'), false);
  assert.equal(developerAgentPath('aider', process.cwd()), null);
});
