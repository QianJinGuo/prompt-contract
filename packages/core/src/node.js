/**
 * Node-only helpers: profile directory loading and provider/config resolution.
 * Keeps src/index.js browser-safe for the playground (PRD §5.4: BYOK, key never leaves the machine).
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { parseProfile } from './profile.js';
import { PromptContractError, CODES } from './errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Locate the built-in profiles/ directory (repo root) from wherever the caller lives. */
export function resolveProfilesDir(explicit) {
  const candidates = [];
  if (explicit) candidates.push(resolve(explicit));
  for (const start of [process.cwd(), __dirname]) {
    let dir = start;
    for (let i = 0; i < 6; i++) {
      candidates.push(join(dir, 'profiles'));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const c of candidates) {
    try {
      if (statSync(c).isDirectory()) return c;
    } catch { /* keep probing */ }
  }
  return null;
}

export function loadProfiles(explicitDir) {
  const dir = resolveProfilesDir(explicitDir);
  if (!dir) throw new PromptContractError(CODES.CONFIG, 'profiles directory not found (looked from cwd and package upward)');
  const profiles = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.md')) continue;
    profiles.push(parseProfile(readFileSync(join(dir, f), 'utf8'), { path: join(dir, f) }));
  }
  if (profiles.length === 0) throw new PromptContractError(CODES.CONFIG, `no .md profiles found in ${dir}`);
  return profiles;
}

export function loadProfile(name, explicitDir) {
  const profiles = loadProfiles(explicitDir);
  const found = profiles.find((p) => p.name === name);
  if (!found) {
    throw new PromptContractError(CODES.PROFILE_NOT_FOUND, `unknown profile "${name}" (available: ${profiles.map((p) => p.name).join(', ')})`);
  }
  return found;
}

/**
 * Vendor presets — convenience sugar over the OpenAI-compatible protocol (openai.js already
 * speaks it): `"provider": "deepseek"` resolves the known base URL and a suggested default
 * small/fast model. Explicit flags/env/config always win over preset values. Model ids are
 * best-effort defaults maintained per vendor naming and can always be overridden with
 * CONTRACT_MODEL/--model; presets deliberately stay a data table, not an SDK dependency.
 */
export const PROVIDER_PRESETS = Object.freeze({
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  glm: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2-turbo-preview' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', keyless: true },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5' },
});

/**
 * Config resolution order: explicit flags > env (CONTRACT_*) > config file (CONTRACT_CONFIG or ~/.prompt-contract/config.json).
 * Defaults follow PRD §3.2: local Ollama if nothing else is configured (privacy-first).
 * `flags.configPath` / `CONTRACT_CONFIG` exist so tests and embedded shells can isolate the file source.
 */
export function readUserConfig(configPath) {
  const cfgPath = configPath ?? process.env.CONTRACT_CONFIG ?? join(homedir(), '.prompt-contract', 'config.json');
  let file = {};
  try {
    if (existsSync(cfgPath)) file = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    throw new PromptContractError(CODES.CONFIG, `invalid config at ${cfgPath}: ${err.message}`);
  }
  return file;
}

export function resolveConfig(flags = {}) {
  const file = readUserConfig(flags.configPath);
  const pick = (...sources) => { for (const s of sources) if (s !== undefined && s !== null && s !== '') return s; return undefined; };

  const provider = pick(flags.provider, process.env.CONTRACT_PROVIDER, file.provider, guessProvider(flags.baseUrl ?? process.env.CONTRACT_BASE_URL ?? file.baseUrl), 'openai');
  const preset = PROVIDER_PRESETS[provider];
  const baseUrl = String(pick(flags.baseUrl, process.env.CONTRACT_BASE_URL, file.baseUrl, preset?.baseUrl, provider === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
  const apiKey = pick(flags.apiKey, process.env.CONTRACT_API_KEY, file.apiKey, preset?.keyless ? 'not-needed' : undefined, provider === 'ollama' ? 'ollama' : undefined);
  const model = pick(flags.model, process.env.CONTRACT_MODEL, file.model, preset?.model, provider === 'ollama' ? 'qwen3:4b' : 'gpt-4o-mini');
  if (!apiKey) throw new PromptContractError(CODES.CONFIG, `no API key: set CONTRACT_API_KEY, --api-key, or ~/.prompt-contract/config.json (or use --provider ollama)`);
  return { provider, baseUrl, apiKey, model };
}

function guessProvider(baseUrl) {
  if (baseUrl && /:11434/.test(baseUrl)) return 'ollama';
  return undefined;
}
