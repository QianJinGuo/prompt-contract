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
import { PromptBoostError, CODES } from './errors.js';

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
  if (!dir) throw new PromptBoostError(CODES.CONFIG, 'profiles directory not found (looked from cwd and package upward)');
  const profiles = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.md')) continue;
    profiles.push(parseProfile(readFileSync(join(dir, f), 'utf8'), { path: join(dir, f) }));
  }
  if (profiles.length === 0) throw new PromptBoostError(CODES.CONFIG, `no .md profiles found in ${dir}`);
  return profiles;
}

export function loadProfile(name, explicitDir) {
  const profiles = loadProfiles(explicitDir);
  const found = profiles.find((p) => p.name === name);
  if (!found) {
    throw new PromptBoostError(CODES.PROFILE_NOT_FOUND, `unknown profile "${name}" (available: ${profiles.map((p) => p.name).join(', ')})`);
  }
  return found;
}

/**
 * Config resolution order: explicit flags > env (PB_*) > config file (PB_CONFIG or ~/.prompt-boost/config.json).
 * Defaults follow PRD §3.2: local Ollama if nothing else is configured (privacy-first).
 * `flags.configPath` / `PB_CONFIG` exist so tests and embedded shells can isolate the file source.
 */
export function resolveConfig(flags = {}) {
  const cfgPath = flags.configPath ?? process.env.PB_CONFIG ?? join(homedir(), '.prompt-boost', 'config.json');
  let file = {};
  try {
    if (existsSync(cfgPath)) file = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    throw new PromptBoostError(CODES.CONFIG, `invalid config at ${cfgPath}: ${err.message}`);
  }
  const pick = (...sources) => { for (const s of sources) if (s !== undefined && s !== null && s !== '') return s; return undefined; };

  const provider = pick(flags.provider, process.env.PB_PROVIDER, file.provider, guessProvider(flags.baseUrl ?? process.env.PB_BASE_URL ?? file.baseUrl), 'openai');
  const baseUrl = String(pick(flags.baseUrl, process.env.PB_BASE_URL, file.baseUrl, provider === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
  const apiKey = pick(flags.apiKey, process.env.PB_API_KEY, file.apiKey, provider === 'ollama' ? 'ollama' : undefined);
  const model = pick(flags.model, process.env.PB_MODEL, file.model, provider === 'ollama' ? 'qwen3:4b' : 'gpt-4o-mini');
  if (!apiKey) throw new PromptBoostError(CODES.CONFIG, `no API key: set PB_API_KEY, --api-key, or ~/.prompt-boost/config.json (or use --provider ollama)`);
  return { provider, baseUrl, apiKey, model };
}

function guessProvider(baseUrl) {
  if (baseUrl && /:11434/.test(baseUrl)) return 'ollama';
  return undefined;
}
