/**
 * prompt-contract watch — resident hotkey mode (PRD §7, Snipaste-style).
 * Hotkey → capture selection (clipboard fallback) → enhance → focus re-validation → paste back.
 *
 * Safety contract (carried over from Spike-0, now with a real paste step):
 *  - The user's clipboard is snapshotted and restored around every capture and paste.
 *  - Paste only fires when the foreground/focus identity still matches capture time;
 *    otherwise the cycle aborts with a notification (fail closed).
 *  - Evidence gate: `prompt-contract watch` requires a passing `prompt-contract spike-0` report (--report) or an
 *    explicit --force, honoring decision D7. Spike-0 itself never unlocks anything.
 *  - --dry-run exercises capture + enhance but never issues ⌘V.
 *
 * macOS only. The global hotkey comes from a small Swift helper (Carbon
 * RegisterEventHotKey — needs no Accessibility permission) compiled on first run
 * from the embedded source below; capture/paste keystrokes still need Accessibility.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { enhance as enhanceCore, PromptContractError } from '../../core/src/index.js';
import { loadProfile, readUserConfig, resolveConfig } from '../../core/src/node.js';
import { createOpenAIProvider } from '../../providers/src/openai.js';
import { createOllamaProvider } from '../../providers/src/ollama.js';
import {
  captureSelectedText,
  createMacOSAdapter,
  isMacOS,
  sameFocusIdentity,
} from './spike-0.js';

export const DEFAULT_WATCH_OPTIONS = Object.freeze({
  hotkey: 'alt+b',
  settleMs: 75,
  // 1000ms between ⌘V and the clipboard restore — measured on a live TextEdit
  // round-trip: 150ms and 500ms both let the restore beat the target app's
  // paste read (the document then receives the RESTORED content); 1000ms and
  // 2500ms passed. The window cuts both ways (a user ⌘C inside it gets
  // clobbered by the restore), so it is deliberately the tested minimum.
  pasteDelayMs: 1000,
  cooldownMs: 800,
  dryRun: false,
});

// Carbon key codes (kVK_*) for the keys we accept in --hotkey.
export const KEY_CODES = Object.freeze({
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11,
  q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, u: 32, i: 34, o: 31, p: 35,
  l: 37, j: 38, k: 40, n: 45, m: 46,
  0: 29, 1: 18, 2: 19, 3: 20, 4: 21, 5: 23, 6: 22, 7: 26, 8: 28, 9: 25,
  space: 49, return: 36, enter: 36, tab: 48, escape: 53, delete: 51, forwarddelete: 117,
  '=': 24, '-': 27, '[': 33, ']': 30, ';': 41, "'": 39, ',': 43, '.': 47, '/': 44, '\\': 42, '`': 50,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101,
  f10: 109, f11: 103, f12: 111,
});

// Carbon modifier masks (cmdKey/shiftKey/optionKey/controlKey).
export const MODIFIER_MASKS = Object.freeze({
  cmd: 1 << 8,
  shift: 1 << 9,
  alt: 1 << 11,
  ctrl: 1 << 12,
});

const MODIFIER_ALIASES = Object.freeze({
  cmd: 'cmd', meta: 'cmd', apple: 'cmd',
  alt: 'alt', option: 'alt',
  ctrl: 'ctrl', control: 'ctrl',
  shift: 'shift',
});

const GLYPHS = Object.freeze({ cmd: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃' });

export function parseHotkey(spec = DEFAULT_WATCH_OPTIONS.hotkey) {
  const parts = String(spec).split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    throw new PromptContractError('config_error', `hotkey "${spec}" must combine a modifier with a key, e.g. alt+b (supported modifiers: cmd, alt/option, ctrl, shift)`);
  }
  let modifiers = 0;
  const labelParts = [];
  for (const part of parts.slice(0, -1)) {
    const name = MODIFIER_ALIASES[part.toLowerCase()];
    if (!name) {
      throw new PromptContractError('config_error', `unknown hotkey modifier "${part}" (supported: cmd(⌘), alt/option(⌥), ctrl(⌃), shift(⇧))`);
    }
    const mask = MODIFIER_MASKS[name];
    if (modifiers & mask) {
      throw new PromptContractError('config_error', `duplicate hotkey modifier "${part}"`);
    }
    modifiers |= mask;
    labelParts.push(GLYPHS[name]);
  }
  const keyToken = parts[parts.length - 1].toLowerCase();
  const keyCode = KEY_CODES[keyToken];
  if (keyCode === undefined) {
    throw new PromptContractError('config_error', `unknown hotkey key "${parts[parts.length - 1]}" (supported: a-z, 0-9, space, return, tab, escape, delete, f1-f12, -=[];',./\\)`);
  }
  const keyLabel = keyToken.length === 1 ? keyToken.toUpperCase() : keyToken.charAt(0).toUpperCase() + keyToken.slice(1);
  return { keyCode, modifiers, label: labelParts.join('') + keyLabel };
}

/**
 * Trigger precedence: --hotkey flag > "hotkey" in ~/.prompt-contract/config.json > default.
 * The hotkey is pressed deliberately, so everyday ⌘C copies never trigger anything;
 * ⌘C is only sent synthetically after the trigger fires.
 */
export function resolveWatchHotkey(flags = {}, config = {}) {
  return String(flags.hotkey ?? config.hotkey ?? DEFAULT_WATCH_OPTIONS.hotkey);
}

/**
 * D7 evidence gate: a passing Spike-0 compatibility report, or an explicit --force.
 */
export async function evaluateWatchGate({ force = false, reportPath, readFile } = {}) {
  if (force) return { ok: true, mode: 'forced' };
  if (!reportPath) {
    return { ok: false, reason: 'no Spike-0 evidence provided' };
  }
  let raw;
  try {
    raw = await readFile(reportPath, 'utf8');
  } catch (err) {
    return { ok: false, reason: `cannot read report ${reportPath}: ${err.code || err.message}` };
  }
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `report ${reportPath} is not valid JSON` };
  }
  if (report?.schemaVersion !== 'prompt-contract/spike-0.v1' || report?.kind !== 'compatibility-report') {
    return { ok: false, reason: `${reportPath} is not a Spike-0 compatibility report (schemaVersion/kind mismatch)` };
  }
  if (report.decision?.pass !== true) {
    const reasons = Array.isArray(report.decision?.reasons) && report.decision.reasons.length
      ? report.decision.reasons.join('; ')
      : 'decision.pass is false';
    return { ok: false, reason: `Spike-0 report did not pass: ${reasons}` };
  }
  return { ok: true, mode: 'report', report };
}

/**
 * Read-only startup probe: proves clipboard access and the Accessibility-backed
 * focus query work before watch goes resident. Never writes the clipboard.
 */
export async function probeCaptureSafety(adapter) {
  const warnings = [];
  try {
    await adapter.readClipboard();
  } catch (err) {
    return { ok: false, error: `clipboard read failed: ${err.message}` };
  }
  try {
    await adapter.checkClipboardRestorable();
  } catch (err) {
    warnings.push(`current clipboard is not text-only (${err.message}); capture refuses to run while rich content is on the pasteboard`);
  }
  try {
    await adapter.getFocusIdentity();
  } catch (err) {
    return { ok: false, error: `focus query failed: ${err.message} — grant Accessibility to your terminal under System Settings → Privacy & Security → Accessibility` };
  }
  return { ok: true, warnings };
}

/**
 * The resident loop. Pure logic: every side effect (capture, enhance, paste,
 * notify) is injected or goes through the adapter, so tests drive it with fakes.
 */
export function createWatchService({
  adapter,
  enhance,
  options = {},
  notify = async () => {},
  log = () => {},
  now = () => Date.now(),
} = {}) {
  const opts = { ...DEFAULT_WATCH_OPTIONS, ...options };
  let busy = false;
  let lastCycleEnd = -Infinity;

  async function pasteBack(enhancedText) {
    // Snapshot whatever is on the clipboard right now (the user may have copied
    // something while the model was thinking); restore it after the paste lands.
    let saved = null;
    let restorable = false;
    try {
      saved = await adapter.readClipboard();
      await adapter.checkClipboardRestorable();
      restorable = true;
    } catch {
      restorable = false;
    }
    await adapter.writeClipboard(enhancedText);
    await adapter.pasteSelection();
    if (opts.pasteDelayMs > 0) await adapter.sleep(opts.pasteDelayMs);
    if (restorable) {
      await adapter.writeClipboard(saved);
      const restored = await adapter.readClipboard();
      if (restored !== saved) log('watch: clipboard restore could not be verified');
    } else {
      log('watch: clipboard held non-text content; it was not preserved across the paste');
    }
  }

  async function handleTrigger() {
    if (busy) {
      log('watch: busy — trigger ignored (D8: no queueing on the hotkey path)');
      return;
    }
    if (now() - lastCycleEnd < opts.cooldownMs) {
      log('watch: cooldown — trigger ignored');
      return;
    }
    busy = true;
    try {
      const capture = await captureSelectedText(adapter, { settleMs: opts.settleMs });
      if (capture.error) {
        await notify({ title: 'PromptContract watch', message: `capture failed: ${capture.error}` });
        return;
      }
      let text = capture.selectedText;
      let source = 'selection';
      if (!text) {
        // PRD §7.3: with nothing selected, fall back to the clipboard content
        // (captureSelectedText has already restored the pre-capture clipboard).
        const clip = await adapter.readClipboard();
        if (typeof clip === 'string' && clip.trim()) {
          text = clip;
          source = 'clipboard';
        }
      }
      if (!text) {
        await notify({ title: 'PromptContract watch', message: 'No selected text and an empty clipboard — select text first.' });
        return;
      }
      log(`watch: captured ${text.length} chars from ${source}`);
      const res = await enhance(text);
      log(`watch: enhanced ${text.length} → ${res.text.length} chars · ${res.meta?.model ?? 'model'} · ${res.meta?.ms ?? '?'}ms`);
      if (opts.dryRun) {
        log('watch: dry-run — nothing pasted, clipboard untouched. Enhanced text:');
        log(res.text);
        return;
      }
      if (!capture.contextBefore) {
        await notify({ title: 'PromptContract watch', message: 'Focus identity unavailable at capture time — paste aborted.' });
        return;
      }
      const focusNow = await adapter.getFocusIdentity();
      if (!sameFocusIdentity(capture.contextBefore, focusNow)) {
        await notify({
          title: 'PromptContract watch',
          message: `Focus moved to ${focusNow?.processName ?? 'another app'}; return to ${capture.contextBefore.processName} and press the hotkey again.`,
        });
        log('watch: focus drift detected — paste aborted (fail closed)');
        return;
      }
      await pasteBack(res.text);
      log('watch: pasted enhanced text');
    } catch (err) {
      await notify({ title: 'PromptContract watch', message: `error: ${err.code || ''} ${err.message}`.trim() });
      log(`watch: cycle failed: ${err.code || ''} ${err.message}`.trim());
    } finally {
      lastCycleEnd = now();
      busy = false;
    }
  }

  return {
    handleTrigger,
    stop: () => { busy = false; },
    isBusy: () => busy,
  };
}

// Swift helper: registers one global hotkey via Carbon and prints a line-based
// protocol on stdout. Kept interpolation-free so it can live in a JS template
// literal. Compiled on demand to the cache dir; source is embedded here so the
// compiled binary is always reproducible from this audited file.
export const HELPER_SOURCE = `import AppKit
import Carbon.HIToolbox
import Foundation

// pb hotkey helper — embedded in packages/cli/src/watch.js; audit changes there.
// argv: <keyCode> <modifierMask>. Prints READY, then one TRIGGER line per press.
let args = CommandLine.arguments
guard args.count >= 3, let keyCode = UInt32(args[1]), let modifiers = UInt32(args[2]) else {
    fputs("usage: pb-hotkey-helper <keyCode> <modifierMask>\\n", stderr)
    exit(2)
}

let signature = OSType(0x5042_484B) // 'PBHK'
var hotKeyID = EventHotKeyID(signature: signature, id: 1)
var hotKeyRef: EventHotKeyRef?
var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))

func hotKeyHandler(_ callRef: EventHandlerCallRef?, _ event: EventRef?, _ data: UnsafeMutableRawPointer?) -> OSStatus {
    var id = EventHotKeyID()
    let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
    if status == noErr && id.signature == signature && id.id == 1 {
        fputs("TRIGGER\\n", stdout)
        fflush(stdout)
    }
    return status
}

let installStatus = InstallEventHandler(GetApplicationEventTarget(), hotKeyHandler, 1, &eventType, nil, nil)
let registerStatus = RegisterEventHotKey(keyCode, modifiers, hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
if installStatus != noErr || registerStatus != noErr {
    fputs("hotkey registration failed\\n", stderr)
    exit(1)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // invisible resident: no Dock icon, no window
fputs("READY\\n", stdout)
fflush(stdout)
app.run()
`;

export function defaultCacheDir() {
  return process.env.CONTRACT_CACHE_DIR || join(homedir(), '.cache', 'prompt-boost');
}

function runProcess(child, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function ensureHelperBinary({ cacheDir, spawnFn = spawn, log = () => {} }) {
  const hash = createHash('sha256').update(HELPER_SOURCE).digest('hex').slice(0, 12);
  const binPath = join(cacheDir, `pb-hotkey-helper-${hash}`);
  if (existsSync(binPath)) return binPath;
  mkdirSync(cacheDir, { recursive: true });
  const srcPath = `${binPath}.swift`;
  // HELPER_SOURCE is written verbatim: its \n sequences are Swift string
  // escapes and must reach the compiler untouched.
  writeFileSync(srcPath, HELPER_SOURCE, 'utf8');
  log('watch: compiling global-hotkey helper (one-time, up to ~30s, needs the Xcode Command Line Tools)…');
  const result = await runProcess(spawnFn('swiftc', ['-O', srcPath, '-o', binPath], { stdio: ['ignore', 'pipe', 'pipe'] }), { timeoutMs: 180000 });
  if (result.error || result.code !== 0) {
    const detail = String(result.stderr || result.error?.message || '').trim().split('\n').slice(0, 5).join('\n');
    const error = new Error(`failed to compile the hotkey helper (swiftc${result.timedOut ? ' timed out' : ` exited ${result.code ?? 'n/a'}`}). Is the Xcode Command Line Tools installed (xcode-select --install)?\n${detail}`);
    error.code = 'hotkey_helper_compile_failed';
    throw error;
  }
  log('watch: helper compiled');
  return binPath;
}

/**
 * Global hotkey via the Swift helper. Registration itself needs no permission;
 * only the later ⌘C/⌘V keystrokes require Accessibility.
 */
export function createSwiftHotkeySource({
  hotkeySpec = DEFAULT_WATCH_OPTIONS.hotkey,
  cacheDir = defaultCacheDir(),
  spawnFn = spawn,
  readyTimeoutMs = 30000,
  log = () => {},
} = {}) {
  let child = null;
  let triggerCb = null;
  let exitCb = null;
  let stopped = false;

  async function start() {
    const { keyCode, modifiers, label } = parseHotkey(hotkeySpec);
    const binPath = await ensureHelperBinary({ cacheDir, spawnFn, log });
    child = spawnFn(binPath, [String(keyCode), String(modifiers)], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`hotkey helper not READY within ${readyTimeoutMs}ms`)), readyTimeoutMs);
      let readySeen = false;
      const onLine = (line) => {
        if (line === 'READY' && !readySeen) {
          readySeen = true;
          clearTimeout(timer);
          resolve(label);
        } else if (line === 'TRIGGER') {
          triggerCb?.();
        } else if (line) {
          log(`watch helper: ${line}`);
        }
      };
      createInterface({ input: child.stdout }).on('line', onLine);
      createInterface({ input: child.stderr }).on('line', (line) => { if (line) log(`watch helper: ${line}`); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (!readySeen) reject(new Error(`hotkey helper exited before READY (code ${code})`));
        else exitCb?.({ code, clean: stopped });
      });
    });
    return ready;
  }

  return {
    start,
    label: parseHotkey(hotkeySpec).label,
    onTrigger: (cb) => { triggerCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    async stop() {
      stopped = true;
      if (!child || child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          resolve();
        }, 2000);
        child.on('close', () => { clearTimeout(timer); resolve(); });
      });
    },
    get running() { return !stopped && child && child.exitCode === null; },
  };
}

/**
 * Portable fallback trigger (any platform): each Enter on stdin fires the
 * cycle; the line "q" quits. Useful without a desktop session or for manual testing.
 */
export function createStdinTriggerSource({ input = process.stdin, log = () => {} } = {}) {
  let triggerCb = null;
  let exitCb = null;
  let rl = null;
  return {
    label: 'Enter',
    onTrigger: (cb) => { triggerCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    async start() {
      rl = createInterface({ input });
      rl.on('line', (line) => {
        const trimmed = line.trim().toLowerCase();
        if (trimmed === 'q') {
          rl.close();
          return;
        }
        triggerCb?.();
      });
      rl.on('close', () => exitCb?.({ code: 0, clean: true }));
      return 'Enter';
    },
    async stop() {
      rl?.close();
    },
    get running() { return Boolean(rl); },
    log,
  };
}

function buildProvider(cfg) {
  return cfg.provider === 'ollama'
    ? createOllamaProvider({ baseUrl: cfg.baseUrl })
    : createOpenAIProvider({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
}

async function defaultNotify({ title, message }) {
  const escaped = String(message).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedTitle = String(title).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  await runProcess(spawn('/usr/bin/osascript', ['-e', `display notification "${escaped}" with title "${escapedTitle}"`], { stdio: ['ignore', 'ignore', 'pipe'] }), { timeoutMs: 5000 });
}

/**
 * `prompt-contract watch` entry point. Deps are injectable for tests; flags come from contract.js parseArgs.
 */
export async function runWatch(flags = {}, deps = {}) {
  const {
    isMacOSPlatform = isMacOS,
    adapter = null,
    enhance = null,
    source = null,
    notify = defaultNotify,
    log = (message) => process.stderr.write(`${message}\n`),
    readFile = readFileAsync,
    config = null,
    registerSignals = true,
    processRef = process,
  } = deps;

  if (!isMacOSPlatform) {
    log('prompt-contract watch is macOS-only: it drives ⌘C/⌘V through System Events and needs the macOS clipboard. See docs/WATCH.md for the platform matrix.');
    return 2;
  }

  const gate = await evaluateWatchGate({
    force: Boolean(flags.force),
    reportPath: flags.report,
    readFile,
  });
  if (!gate.ok) {
    log(`prompt-contract watch refused to start (decision D7 evidence gate): ${gate.reason}
Watch pastes over your selection, so it runs only with measured evidence. Either:
  - run  prompt-contract spike-0 --json --output ~/.cache/prompt-contract/spike-0.json  first, then
        prompt-contract watch --report ~/.cache/prompt-contract/spike-0.json
  - or pass --force to accept the risk without evidence.`);
    return 2;
  }

  // Fail fast on a bad hotkey before touching the clipboard or going resident.
  const hotkeySpec = resolveWatchHotkey(flags, config ?? readUserConfig(flags.configPath));
  try {
    parseHotkey(hotkeySpec);
  } catch (err) {
    log(`prompt-contract watch: ${err.message}
Fix it with --hotkey <spec> or the "hotkey" field in ~/.prompt-contract/config.json (e.g. "hotkey": "ctrl+alt+b").`);
    return 2;
  }

  const macAdapter = adapter ?? createMacOSAdapter();
  const probe = await probeCaptureSafety(macAdapter);
  if (!probe.ok) {
    log(`prompt-contract watch startup probe failed: ${probe.error}`);
    return 2;
  }
  for (const warning of probe.warnings) log(`watch: warning — ${warning}`);

  // D8 low-latency charter: load config/profile and warm the provider once at
  // startup; the hotkey path below is pure async with no further initialization.
  // (Skipped when a test injects enhance directly.)
  let enhanceFn = enhance;
  let cfg = null;
  if (!enhanceFn) {
    const profile = loadProfile(flags.profile || 'coding-agent');
    cfg = resolveConfig(flags);
    const provider = buildProvider(cfg);
    provider.warmup?.({ model: cfg.model });
    enhanceFn = (text) => enhanceCore(text, {
      profile,
      provider,
      model: cfg.model,
      strength: flags.strength,
      context: flags.context,
      maxChars: flags.maxChars ? parseInt(flags.maxChars, 10) : undefined,
      timeoutMs: flags.timeout ? parseInt(flags.timeout, 10) : undefined,
    });
  }

  const triggerSource = source ?? (flags.trigger === 'stdin'
    ? createStdinTriggerSource({ log })
    : createSwiftHotkeySource({ hotkeySpec, log }));

  const service = createWatchService({
    adapter: macAdapter,
    enhance: enhanceFn,
    options: {
      settleMs: flags.settleMs !== undefined ? parseInt(flags.settleMs, 10) : undefined,
      pasteDelayMs: flags.pasteDelayMs !== undefined ? parseInt(flags.pasteDelayMs, 10) : undefined,
      cooldownMs: flags.cooldownMs !== undefined ? parseInt(flags.cooldownMs, 10) : undefined,
      dryRun: Boolean(flags.dryRun),
    },
    notify,
    log,
  });

  let stopReason = null;
  const stopped = new Promise((resolve) => {
    triggerSource.onTrigger(() => { service.handleTrigger(); });
    // Sources classify their own exit: { clean: true } for a shutdown we (or
    // the user via `q`) initiated, { clean: false } for a crash.
    triggerSource.onExit((info) => {
      if (info?.clean === false) stopReason = stopReason ?? `trigger source exited (code ${info?.code ?? '?'})`;
      resolve();
    });
    if (registerSignals) {
      const shutdown = () => { stopReason = stopReason ?? 'interrupted'; resolve(); };
      processRef.once?.('SIGINT', shutdown);
      processRef.once?.('SIGTERM', shutdown);
    }
  });

  const label = await triggerSource.start();
  const profileName = flags.profile || 'coding-agent';
  const providerLabel = cfg ? `${cfg.provider} model=${cfg.model}` : 'injected enhance fn';
  const suffix = flags.dryRun ? ' · DRY-RUN (never pastes)' : '';
  const usingStdin = !source && flags.trigger === 'stdin';
  const triggerDesc = usingStdin ? label : `${label}  [${hotkeySpec}]`;
  log(`prompt-contract watch resident — ${triggerDesc} enhances the selection · profile=${profileName} provider=${providerLabel}${suffix}
Ctrl+C to quit. Paste replaces the selected text; the clipboard is restored afterwards. See docs/WATCH.md.`);

  await stopped;
  await triggerSource.stop();
  log(`watch: stopped${stopReason ? ` — ${stopReason}` : ''}`);
  return stopReason && /exited/.test(stopReason) ? 1 : 0;
}
