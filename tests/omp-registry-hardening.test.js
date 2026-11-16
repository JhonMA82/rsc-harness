import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ompPluginsRoot, ompUserLoaderPath, wireOmpUserLoader, unwireOmpUserLoader } from '../targets/omp-bridge.js';
import { pluginConfigPath, readPluginSwitches } from '../targets/omp-bridge.mjs';

const sandbox = () => mkdtempSync(join(tmpdir(), 'rsc-omp-hardening-'));

test('installer and bridge use the same plugin registry (including PI_CONFIG_DIR)', () => {
  const home = sandbox();
  try {
    for (const extra of [{}, { PI_CONFIG_DIR: '.custom-omp' }]) {
      const env = { HOME: home, ...extra };
      const expected = join(home, extra.PI_CONFIG_DIR || '.omp', 'plugins');
      assert.equal(ompPluginsRoot(env), expected);
      assert.equal(pluginConfigPath(env), join(expected, 'omp-plugins.lock.json'));
      mkdirSync(expected, { recursive: true });
      writeFileSync(join(expected, 'omp-plugins.lock.json'), JSON.stringify({ settings: { 'rsc-harness': { guards: false } } }));
      assert.equal(readPluginSwitches(env).guards, false);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('named OMP profiles share their plugin config with the adapter', () => {
  const home = sandbox();
  try {
    const env = { HOME: home, OMP_PROFILE: 'work' };
    const expected = join(home, '.omp', 'profiles', 'work', 'plugins');
    assert.equal(ompPluginsRoot(env), expected);
    assert.equal(pluginConfigPath(env), join(expected, 'omp-plugins.lock.json'));
    // Canonical OMP_PROFILE overrides legacy PI_PROFILE, including explicit default.
    assert.equal(ompPluginsRoot({ ...env, OMP_PROFILE: '', PI_PROFILE: 'other' }), join(home, '.omp', 'plugins'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('XDG data migration uses the XDG plugin registry on every platform', () => {
  const home = sandbox();
  try {
    const xdg = join(home, 'xdg');
    const env = { HOME: home, XDG_DATA_HOME: xdg };
    const expected = join(xdg, 'omp');
    mkdirSync(expected, { recursive: true });
    assert.equal(ompPluginsRoot(env), join(expected, 'plugins'));
    assert.equal(pluginConfigPath(env), join(expected, 'plugins', 'omp-plugins.lock.json'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('removing superseded managed user hook preserves a hand-written hook', () => {
  const home = sandbox();
  const env = { HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent') };
  try {
    const path = ompUserLoaderPath(env);
    wireOmpUserLoader(env);
    assert.ok(existsSync(path));
    assert.deepEqual(unwireOmpUserLoader(env), [path]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '// local user extension\n');
    assert.deepEqual(unwireOmpUserLoader(env), []);
    assert.equal(readFileSync(path, 'utf8'), '// local user extension\n');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('OMP profile takes precedence over inherited agent dir, and PI_CONFIG_DIR is honored', async () => {
  const { ompAgentDir } = await import('../targets/omp-bridge.js');
  const home = sandbox();
  try {
    const env = {
      HOME: home, OMP_PROFILE: 'engineering', PI_PROFILE: 'legacy',
      PI_CONFIG_DIR: '.my-omp', PI_CODING_AGENT_DIR: join(home, 'legacy-agent'),
    };
    assert.equal(ompAgentDir(env), join(home, '.my-omp', 'profiles', 'engineering', 'agent'));
    assert.equal(ompAgentDir({ ...env, OMP_PROFILE: '' }), join(home, 'legacy-agent'));
    assert.equal(ompAgentDir({ HOME: home, PI_CONFIG_DIR: '.my-omp' }), join(home, '.my-omp', 'agent'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
