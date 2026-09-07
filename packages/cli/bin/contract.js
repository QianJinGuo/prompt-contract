#!/usr/bin/env node
/**
 * contract — PromptContract CLI (PRD §4 P0). Physical file kept as contract.js for path stability.
 * One-shot enhance (arg or stdin), profiles, check (rule assertions), doctor.
 * `contract watch` is intentionally gated by decision D7 (Spike-0 first) — see docs/SPIKE-0.md.
 */
import { enhance, checkRules, PromptContractError, normalizeError } from '../../core/src/index.js';
import { loadProfiles, loadProfile, resolveConfig } from '../../core/src/node.js';
import { createOpenAIProvider } from '../../providers/src/openai.js';
import { createOllamaProvider } from '../../providers/src/ollama.js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  createMacOSAdapter,
  DEFAULT_SPIKE_THRESHOLDS,
  formatSpike0Summary,
  isMacOS,
  resolveSpikeTargets,
  runSpike0,
} from '../src/spike-0.js';

// `contract` was the command name before the prompt-contract rename; warn while the alias ships.
if (basename(process.argv[1] || '') === 'contract') {
  process.stderr.write('[deprecated] this CLI is now `contract` (prompt-contract); the `contract` command will be removed in a future release.\n');
}

const VERSION = '0.2.0';
const USAGE = `contract — one-key prompt enhancement (PromptContract v${VERSION})

Usage:
  contract "build me a website for my dog"     enhance a prompt (prints enhanced text to stdout)
  cat prompt.txt | contract                    enhance from stdin
  contract profiles                            list built-in profiles
  contract check --original "..." --enhanced "..."
                                         run the six hard-constraint rule assertions
  contract doctor                              verify config, provider reachability, profiles
  contract spike-0                             macOS-only capture/restore compatibility diagnostic (dry-run)
  contract watch                               NOT BUILT — gated by decision D7 (Spike-0 first); see docs/SPIKE-0.md

Options:
  -p, --profile <name>     scenario profile (default: coding-agent)
  -s, --strength <mode>    polish | standard (default) | expand
  -m, --model <model>      model override
      --provider <name>    openai (default) | ollama
      --base-url <url>     OpenAI-compatible base URL (or CONTRACT_BASE_URL)
      --api-key <key>      API key (or CONTRACT_API_KEY; local ollama needs none)
      --context <text>     background context to assemble into the prompt
      --max-chars <n>      output clamp (default from profile, 800)
      --timeout <ms>       request timeout (default 30000)
      --app <names>        Spike-0 targets: Chrome,PyCharm,iTerm (default: all three)
      --iterations <n>     Spike-0 attempts per target (default: 20)
      --settle-ms <ms>     Spike-0 wait after ⌘C before reading (default: 75)
      --pause-ms <ms>      Spike-0 pause before dry-run focus validation
      --setup-delay-ms <ms> Spike-0 delay before each target capture
      --no-prompt          Spike-0 do not wait for target/app setup
      --output <path>      write Spike-0 JSON report to a file
      --json               machine-readable output {original, enhanced, meta, rules}
      --no-stream          buffer instead of streaming progress
  -h, --help               show this help`;

function parseArgs(argv) {
  const flags = { _: [] };
  const needsValue = new Set(['--profile', '-p', '--strength', '-s', '--model', '-m', '--provider', '--base-url', '--api-key', '--context', '--max-chars', '--timeout', '--app', '--iterations', '--settle-ms', '--pause-ms', '--setup-delay-ms', '--output', '--original', '--enhanced']);
  const camel = (k) => k.replace(/^--?/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--no-stream') flags.noStream = true;
    else if (a === '--no-prompt') flags.noPrompt = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--version') flags.version = true;
    else if (needsValue.has(a)) flags[camel(a)] = argv[++i];
    else if (a.startsWith('-')) throw new PromptContractError('config_error', `unknown flag ${a}`);
    else flags._.push(a);
  }
  return flags;
}

function buildProvider(cfg) {
  return cfg.provider === 'ollama'
    ? createOllamaProvider({ baseUrl: cfg.baseUrl })
    : createOpenAIProvider({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
}

function makeProvider(cfg, { warm = false } = {}) {
  const provider = buildProvider(cfg);
  if (warm) provider.warmup({ model: cfg.model }); // fire-and-forget connection/model preload (§7.6-1)
  return provider;
}

function readStdin() {
  try {
    if (existsSync('/dev/stdin') && !process.stdin.isTTY) return readFileSync(0, 'utf8');
  } catch { /* fall through */ }
  return '';
}

function printRules(rules) {
  for (const r of rules.results) {
    const mark = r.pass ? 'PASS' : 'FAIL';
    process.stderr.write(`  [${mark}] ${r.title}${r.detail ? ` — ${r.detail}` : ''}\n`);
  }
  return rules.pass;
}

async function cmdEnhance(flags) {
  let text = flags._.join(' ');
  if (!text.trim() && !process.stdin.isTTY) text = readStdin();
  const profile = loadProfile(flags.profile || 'coding-agent');
  const cfg = resolveConfig(flags);
  const provider = makeProvider(cfg, { warm: true });

  const onDelta = flags.json || flags.noStream
    ? undefined
    : (d) => { process.stderr.write(d); };

  const res = await enhance(text, {
    profile,
    provider,
    model: cfg.model,
    strength: flags.strength,
    context: flags.context,
    maxChars: flags.maxChars ? parseInt(flags.maxChars, 10) : undefined,
    timeoutMs: flags.timeout ? parseInt(flags.timeout, 10) : undefined,
    onDelta
  });

  const rules = checkRules(res.original, res.text, { maxChars: profile.maxChars });
  if (flags.json) {
    process.stdout.write(JSON.stringify({ original: res.original, enhanced: res.text, meta: res.meta, rules }, null, 2) + '\n');
  } else {
    process.stdout.write(res.text + '\n');
    if (!flags.noStream) {
      process.stderr.write(`\n— ${res.meta.profile} · ${res.meta.model} · ${res.meta.ms}ms · ${res.meta.chars} chars\n`);
      if (!rules.pass) {
        process.stderr.write('rule assertions (advisory — run `contract check` for gate mode):\n');
        for (const r of rules.results.filter((r) => !r.pass)) {
          process.stderr.write(`  [FAIL] ${r.title}${r.detail ? ` — ${r.detail}` : ''}\n`);
        }
      }
    }
  }
  return 0;
}

function cmdProfiles(flags) {
  const profiles = loadProfiles();
  if (flags.json) {
    process.stdout.write(JSON.stringify(profiles.map((p) => ({ name: p.name, domain: p.domain, maxChars: p.maxChars })), null, 2) + '\n');
  } else {
    for (const p of profiles) process.stdout.write(`${p.name.padEnd(14)} ${p.domain} (≤${p.maxChars} chars)\n`);
  }
  return 0;
}

function cmdCheck(flags) {
  let original = flags.original;
  let enhanced = flags.enhanced;
  if (!original && !enhanced && !process.stdin.isTTY) {
    // accept "original\tenhanced" or JSON line on stdin
    const line = readStdin().trim();
    try {
      const j = JSON.parse(line);
      original = j.original; enhanced = j.enhanced;
    } catch {
      const [o, e] = line.split('\t');
      original = o; enhanced = e;
    }
  }
  if (original === undefined || enhanced === undefined) {
    process.stderr.write('contract check requires --original and --enhanced (or a JSON {original, enhanced} line on stdin)\n');
    return 2;
  }
  const rules = checkRules(original, enhanced, { maxChars: flags.maxChars ? parseInt(flags.maxChars, 10) : 800 });
  process.stderr.write(`checking ${rules.results.length} rule assertions:\n`);
  const pass = printRules(rules);
  if (flags.json) process.stdout.write(JSON.stringify(rules, null, 2) + '\n');
  return pass ? 0 : 1;
}

async function cmdDoctor(flags) {
  let ok = true;
  const cfg = (() => { try { return { ...resolveConfig(flags) }; } catch (err) { process.stderr.write(`[FAIL] config: ${err.message}\n`); return null; } })();
  if (!cfg) return 1;
  process.stderr.write(`[PASS] provider=${cfg.provider} base=${cfg.baseUrl} model=${cfg.model} key=${cfg.provider === 'ollama' ? 'not-needed' : 'set'}\n`);
  try {
    loadProfiles();
    const names = loadProfiles().map((p) => p.name).join(', ');
    process.stderr.write(`[PASS] profiles: ${names}\n`);
  } catch (err) {
    ok = false;
    process.stderr.write(`[FAIL] profiles: ${err.message}\n`);
  }
  const provider = buildProvider(cfg);
  const probe = await Promise.race([
    provider.complete({ system: 'ping', user: 'ping', model: cfg.model, maxTokens: 1, timeoutMs: 5000 }).then(() => 'ok').catch((e) => `error: ${e.code || e.message}`),
    new Promise((r) => setTimeout(() => r('timeout'), 6000))
  ]);
  if (probe === 'ok') process.stderr.write('[PASS] provider reachable and responding\n');
  else { ok = false; process.stderr.write(`[FAIL] provider probe: ${probe}\n`); }
  process.stderr.write(ok ? 'doctor: OK\n' : 'doctor: PROBLEMS FOUND\n');
  return ok ? 0 : 1;
}

async function cmdSpike0(flags) {
  if (!isMacOS) {
    process.stderr.write('contract spike-0 is macOS-only: requires pbpaste, pbcopy, and Accessibility-backed System Events.\n');
    return 2;
  }

  const targets = resolveSpikeTargets(flags.app || DEFAULT_SPIKE_THRESHOLDS.requiredTargets.join(','));
  const iterations = flags.iterations === undefined
    ? DEFAULT_SPIKE_THRESHOLDS.iterationsPerTarget
    : Number.parseInt(flags.iterations, 10);
  const settleMs = flags.settleMs === undefined ? 75 : Number.parseInt(flags.settleMs, 10);
  const pauseMs = flags.pauseMs === undefined ? 0 : Number.parseInt(flags.pauseMs, 10);
  const setupDelayMs = flags.setupDelayMs === undefined ? 0 : Number.parseInt(flags.setupDelayMs, 10);
  if (!Number.isInteger(iterations) || iterations < 1 || !Number.isInteger(settleMs) || settleMs < 0 || !Number.isInteger(pauseMs) || pauseMs < 0 || !Number.isInteger(setupDelayMs) || setupDelayMs < 0) {
    process.stderr.write('contract spike-0 requires non-negative integer --settle-ms/--pause-ms/--setup-delay-ms and positive integer --iterations\n');
    return 2;
  }

  const report = await runSpike0({
    adapter: createMacOSAdapter(),
    targets,
    iterations,
    settleMs,
    pauseMs,
    setupDelayMs,
    interactive: !flags.noPrompt && Boolean(process.stdin.isTTY),
    announce: (message) => process.stderr.write(`${message}\n`),
  });
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (flags.output) writeFileSync(flags.output, serialized, 'utf8');
  if (flags.json) process.stdout.write(serialized);
  else process.stdout.write(formatSpike0Summary(report) + '\n');
  return report.decision.pass ? 0 : 1;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) { process.stdout.write(USAGE + '\n'); return 0; }
  if (flags.version) { process.stdout.write(VERSION + '\n'); return 0; }
  const cmd = flags._.shift();
  switch (cmd) {
    case undefined:
    case 'boost': return await cmdEnhance(flags);
    case 'profiles': return cmdProfiles(flags);
    case 'check': return cmdCheck(flags);
    case 'doctor': return await cmdDoctor(flags);
    case 'spike-0': return await cmdSpike0(flags);
    case 'watch':
      process.stderr.write('contract watch is gated by decision D7: run `contract spike-0` and review its evidence before implementing watch.\nThe watch implementation remains intentionally unavailable in this Spike-0-only change.\n');
      return 2;
    default:
      // treat unknown first word as prompt text
      flags._.unshift(cmd);
      return await cmdEnhance(flags);
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  const e = normalizeError(err);
  process.stderr.write(`contract: ${e.code}: ${e.message}\n`);
  process.exit(1);
});
