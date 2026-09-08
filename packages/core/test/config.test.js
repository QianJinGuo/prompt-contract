import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_PRESETS, readUserConfig, resolveConfig } from '../src/node.js';

const ENV_KEYS = ['CONTRACT_PROVIDER', 'CONTRACT_BASE_URL', 'CONTRACT_API_KEY', 'CONTRACT_MODEL', 'CONTRACT_CONFIG'];

/** resolveConfig consults process.env — isolate each assertion from the developer's shell env. */
async function withCleanEnv(fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('vendor presets resolve the known base URL and a suggested default model', async () => {
  await withCleanEnv(async () => {
    const cfg = resolveConfig({ provider: 'deepseek', apiKey: 'sk-test' });
    assert.equal(cfg.provider, 'deepseek');
    assert.equal(cfg.baseUrl, PROVIDER_PRESETS.deepseek.baseUrl);
    assert.equal(cfg.model, PROVIDER_PRESETS.deepseek.model);
    assert.equal(cfg.baseUrl, 'https://api.deepseek.com/v1');
    assert.equal(cfg.model, 'deepseek-chat');
  });
});

test('explicit flags beat preset values', async () => {
  await withCleanEnv(async () => {
    const cfg = resolveConfig({ provider: 'deepseek', apiKey: 'k', baseUrl: 'http://127.0.0.1:9/v1', model: 'custom-model' });
    assert.equal(cfg.baseUrl, 'http://127.0.0.1:9/v1');
    assert.equal(cfg.model, 'custom-model');
  });
});

test('keyless local presets (lmstudio) do not demand an API key', async () => {
  await withCleanEnv(async () => {
    const cfg = resolveConfig({ provider: 'lmstudio' });
    assert.equal(cfg.baseUrl, 'http://127.0.0.1:1234/v1');
    assert.equal(cfg.apiKey, 'not-needed');
  });
});

test('anthropic preset supplies its native base URL and small/fast default model', async () => {
  await withCleanEnv(async () => {
    const cfg = resolveConfig({ provider: 'anthropic', apiKey: 'sk-ant-test' });
    assert.equal(cfg.provider, 'anthropic');
    assert.equal(cfg.baseUrl, 'https://api.anthropic.com');
    assert.equal(cfg.model, 'claude-haiku-4-5');
  });
});

test('unknown provider names stay bring-your-own-compatible-endpoint (no preset, no error)', async () => {
  await withCleanEnv(async () => {
    const cfg = resolveConfig({ provider: 'my-gateway', apiKey: 'k', baseUrl: 'https://gw.internal/v1' });
    assert.equal(cfg.provider, 'my-gateway');
    assert.equal(cfg.baseUrl, 'https://gw.internal/v1');
    assert.equal(cfg.model, 'gpt-4o-mini'); // openai-compat fallback default
  });
});

test('env config beats preset too (config resolution order is unchanged)', async () => {
  await withCleanEnv(async () => {
    process.env.CONTRACT_PROVIDER = 'deepseek';
    process.env.CONTRACT_MODEL = 'env-picked-model';
    const cfg = resolveConfig({ apiKey: 'k' });
    assert.equal(cfg.provider, 'deepseek');
    assert.equal(cfg.model, 'env-picked-model');
    assert.equal(cfg.baseUrl, PROVIDER_PRESETS.deepseek.baseUrl);
  });
});

test('readUserConfig returns {} when no config file exists and throws config_error on invalid JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-config-test-'));
  const missing = join(dir, 'nope.json');
  assert.deepEqual(readUserConfig(missing), {});
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json', 'utf8');
  assert.throws(() => readUserConfig(bad), (err) => err.code === 'config_error' && /invalid config/.test(err.message));
});
