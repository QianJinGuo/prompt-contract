/**
 * contract draft — an interactive drafting surface (PRD §7 companion mode).
 * Unlike `watch` (select text elsewhere → global hotkey → paste back), draft
 * is a line in the terminal: type a rough prompt, press the enhance hotkey to
 * rewrite it in place, keep editing or re-enhance, Enter accepts.
 *
 * Cross-platform (macOS + Linux): plain readline, no Accessibility, no
 * global hotkeys. The clipboard step on Enter degrades gracefully and never
 * fails the session. Ported from the pb-agent watch REPL design
 * (2026-09-10); see docs/DRAFT.md.
 */
import { createInterface } from 'node:readline';
import { enhance as enhanceCore, PromptContractError } from '../../core/src/index.js';
import { loadProfile, resolveConfig } from '../../core/src/node.js';
import { createAnthropicProvider } from '../../providers/src/anthropic.js';
import { createOllamaProvider } from '../../providers/src/ollama.js';
import { createOpenAIProvider } from '../../providers/src/openai.js';
import { makeSystemCopyFn } from './clipboard.js';

export const DEFAULT_DRAFT_HOTKEY = Object.freeze({ ctrl: false, alt: true, shift: false, name: 'e', label: 'Alt+E' });

const MODIFIERS = Object.freeze({
  ctrl: { key: 'ctrl' },
  control: { key: 'ctrl' },
  alt: { key: 'alt' },
  option: { key: 'alt' },
  shift: { key: 'shift' },
});

export function parseDraftHotkey(spec) {
  const parts = String(spec).split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    throw new PromptContractError('config_error', `hotkey "${spec}" must combine a modifier with a key, e.g. alt+e or ctrl+k`);
  }
  let ctrl = false;
  let alt = false;
  let shift = false;
  for (const part of parts.slice(0, -1)) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (!mod) {
      if (['cmd', 'meta', 'apple'].includes(part.toLowerCase())) {
        throw new PromptContractError('config_error', `hotkey "${spec}": cmd/⌘ never reaches terminal stdin — use ctrl or alt instead`);
      }
      throw new PromptContractError('config_error', `unknown hotkey modifier "${part}" (supported: ctrl, alt/option, shift)`);
    }
    if (mod.key === 'ctrl' && ctrl) throw new PromptContractError('config_error', `duplicate hotkey modifier "${part}"`);
    if (mod.key === 'alt' && alt) throw new PromptContractError('config_error', `duplicate hotkey modifier "${part}"`);
    if (mod.key === 'shift' && shift) throw new PromptContractError('config_error', `duplicate hotkey modifier "${part}"`);
    ctrl = ctrl || mod.key === 'ctrl';
    alt = alt || mod.key === 'alt';
    shift = shift || mod.key === 'shift';
  }
  const name = parts[parts.length - 1].toLowerCase();
  if (!/^[a-z0-9]$/.test(name)) {
    throw new PromptContractError('config_error', `unknown hotkey key "${parts[parts.length - 1]}" (draft keys are a-z and 0-9; named keys like f1 or space would collide with typing)`);
  }
  if (!ctrl && !alt) {
    throw new PromptContractError('config_error', `hotkey "${spec}" needs ctrl or alt — a bare key or shift-only combo would fire on normal typing`);
  }
  // Ctrl+C / Ctrl+D are the draft exit keys.
  if (ctrl && !alt && !shift && (name === 'c' || name === 'd')) {
    throw new PromptContractError('config_error', `hotkey "${spec}" is reserved: ctrl+c and ctrl+d exit the draft line`);
  }
  const labelParts = [];
  if (ctrl) labelParts.push('Ctrl');
  if (alt) labelParts.push('Alt');
  if (shift) labelParts.push('Shift');
  return { ctrl, alt, shift, name, label: `${labelParts.join('+')}+${name.toUpperCase()}` };
}

export function nextDraftAction(phase, key, hotkey) {
  if (key.ctrl && (key.name === 'c' || key.name === 'd')) return { kind: 'exit' };
  if (phase === 'enhancing') return { kind: 'noop' };
  const matched =
    key.name === hotkey.name &&
    (key.ctrl === true) === hotkey.ctrl &&
    (key.meta === true) === hotkey.alt &&
    (key.shift === true) === hotkey.shift;
  return matched ? { kind: 'enhance' } : { kind: 'noop' };
}

/** A readline line is single-line; fold any enhancement onto one line. */
export function flattenSingleLine(text) {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(' ')
    .trim();
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * The draft REPL loop. Key decisions go through nextDraftAction (unit-tested);
 * the stream glue stays thin. The input stream is never paused, so Ctrl+C
 * keeps working while an enhance call is in flight. terminal:true even for
 * piped input so keypress parsing stays active in tests.
 */
export function runDraftRepl({ input, output, enhance, copy, hotkey, log = () => {} }) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input,
      // deps promise only string writes; real collaborators satisfy the
      // full Writable interface.
      output: output,
      terminal: true,
      prompt: '▍ ',
    });

    let phase = 'idle';
    let closed = false;
    let spinner = null;
    let frame = 0;

    const finish = (code) => {
      if (closed) return;
      closed = true;
      stopSpinner();
      rl.close();
      resolve(code);
    };

    const stopSpinner = () => {
      if (spinner) {
        clearInterval(spinner);
        spinner = null;
      }
      output.write('\r\x1b[2K');
    };

    const startSpinner = () => {
      frame = 0;
      output.write(`\r\x1b[2K${DIM}  enhancing… (hotkey ignored, Ctrl+C exits)${RESET}`);
      spinner = setInterval(() => {
        output.write(`\r\x1b[2K${DIM}  ${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} enhancing…${RESET}`);
        frame += 1;
      }, 120);
    };

    const runEnhance = () => {
      const draft = rl.line.trim();
      if (draft.length === 0) return; // empty draft: silent no-op
      phase = 'enhancing';
      startSpinner();
      enhance(draft)
        .then((enhancedText) => {
          if (closed) return;
          stopSpinner();
          rl.prompt(true);
          rl.write('\x15'); // Ctrl+U: clear the draft in place
          rl.write(flattenSingleLine(enhancedText));
          phase = 'idle';
        })
        .catch((err) => {
          if (closed) return;
          stopSpinner();
          phase = 'idle';
          const message = err?.code ? `${err.code}: ${err.message}` : (err instanceof Error ? err.message : String(err));
          output.write(`\r\x1b[2K${RED}  enhance failed: ${message} (draft preserved, press the hotkey to retry)${RESET}\n`);
          rl.prompt(true);
        });
    };

    const keyEmitter = input;
    keyEmitter.on?.('keypress', (_str, key) => {
      if (!key) return;
      const action = nextDraftAction(phase, key, hotkey);
      if (action.kind === 'exit') finish(0);
      else if (action.kind === 'enhance') runEnhance();
    });

    rl.on('line', (line) => {
      const text = line.trim();
      if (phase !== 'idle') {
        // Enter during flight: give the draft back instead of accepting it.
        rl.write('\x15');
        rl.write(line);
        return;
      }
      if (text.length === 0) return;
      copy(text)
        .then((ok) => {
          output.write(
            ok
              ? `${GREEN}  ✓ copied to clipboard${RESET}\n`
              : `${YELLOW}  (clipboard unavailable — prompt echoed above)${RESET}\n`,
          );
          rl.prompt(true);
        })
        .catch(() => {
          output.write(`${YELLOW}  (clipboard unavailable — prompt echoed above)${RESET}\n`);
          rl.prompt(true);
        });
    });

    rl.on('SIGINT', () => finish(0));
    rl.on('close', () => finish(0));

    const banner = `contract draft — type a prompt, ${hotkey.label} enhance, Enter accept, Ctrl+C exit`;
    output.write(`${DIM}${banner}${RESET}\n`);
    rl.prompt();
  });
}

function buildProvider(cfg) {
  if (cfg.provider === 'ollama') return createOllamaProvider({ baseUrl: cfg.baseUrl });
  if (cfg.provider === 'anthropic') return createAnthropicProvider({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
  return createOpenAIProvider({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
}

/**
 * `prompt-contract draft` entry point. Deps are injectable for tests; flags
 * come from contract.js parseArgs. Shares the enhance pipeline with one-shot
 * mode (profile/strength/context/maxChars/timeout) — only the interaction
 * differs.
 */
export async function runDraft(flags = {}, deps = {}) {
  const {
    input = process.stdin,
    output = process.stdout,
    enhance = null, // injected (draft: string) => Promise<string>
    copy = null, // injected (text: string) => Promise<boolean>
    resolveConfigFn = resolveConfig,
    log = (message) => process.stderr.write(`${message}\n`),
  } = deps;

  const spec = flags.hotkey ?? 'alt+e';
  let hotkey;
  try {
    hotkey = parseDraftHotkey(spec);
  } catch (err) {
    log(`prompt-contract draft: ${err.message}
Fix it with --hotkey <spec> (e.g. "ctrl+k" or "alt+e").`);
    return 2;
  }

  // D8-style warm path: resolve config, load profile, and warm the provider
  // once up front so the first hotkey press pays no initialization cost.
  let enhanceFn = enhance;
  if (!enhanceFn) {
    try {
      const profile = loadProfile(flags.profile || 'coding-agent');
      const cfg = resolveConfigFn(flags);
      const provider = buildProvider(cfg);
      provider.warmup?.({ model: cfg.model });
      enhanceFn = async (text) => (await enhanceCore(text, {
        profile,
        provider,
        model: cfg.model,
        strength: flags.strength,
        context: flags.context,
        maxChars: flags.maxChars ? parseInt(flags.maxChars, 10) : undefined,
        timeoutMs: flags.timeout ? parseInt(flags.timeout, 10) : undefined,
      })).text;
    } catch (err) {
      log(`prompt-contract draft: ${err.message}`);
      return 2;
    }
  }

  const noClipboard = process.env.CONTRACT_NO_CLIPBOARD === '1';
  const copyFn = copy ?? (noClipboard ? async () => false : makeSystemCopyFn());

  return runDraftRepl({ input, output, enhance: enhanceFn, copy: copyFn, hotkey });
}
