import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  createStdinTriggerSource,
  createWatchService,
  DEFAULT_WATCH_OPTIONS,
  evaluateWatchGate,
  HELPER_SOURCE,
  parseHotkey,
  probeCaptureSafety,
  resolveWatchHotkey,
  runWatch,
} from '../src/watch.js';

function context(overrides = {}) {
  return {
    processName: 'Google Chrome',
    bundleId: 'com.google.Chrome',
    pid: 123,
    windowTitle: 'Prompt test',
    focus: {
      role: 'AXTextField',
      subrole: 'AXStandardWindow',
      identifier: 'prompt-input',
      title: '',
      description: 'Prompt input',
    },
    ...overrides,
  };
}

function fakeAdapter({
  clipboard = 'keep this clipboard',
  selectedText = 'selected prompt',
  contexts,
  pasteError,
  clipboardCheckErrorInPaste,
} = {}) {
  const state = {
    clipboard,
    events: [],
    contexts: contexts ? [...contexts] : [context(), context(), context(), context()],
    pasteSelectionCalls: 0,
  };
  return {
    state,
    async readClipboard() {
      state.events.push('readClipboard');
      return state.clipboard;
    },
    async checkClipboardRestorable() {
      state.events.push('checkClipboardRestorable');
      if (clipboardCheckErrorInPaste && state.events.filter((e) => e === 'checkClipboardRestorable').length >= 2) {
        throw new Error('clipboard_not_plain_text');
      }
    },
    async writeClipboard(value) {
      state.events.push(['writeClipboard', value]);
      state.clipboard = value;
    },
    async copySelection() {
      state.events.push('copySelection');
      state.clipboard = selectedText;
    },
    async pasteSelection() {
      state.events.push('pasteSelection');
      state.pasteSelectionCalls += 1;
      if (pasteError) throw pasteError;
    },
    async getFocusIdentity() {
      state.events.push('getFocusIdentity');
      return state.contexts.shift() ?? context();
    },
    async sleep() {
      state.events.push('sleep');
    },
  };
}

function recordingNotify() {
  const calls = [];
  const fn = async (notification) => { calls.push(notification); };
  fn.calls = calls;
  return fn;
}

function recordingLog() {
  const lines = [];
  const fn = (message) => { lines.push(String(message)); };
  fn.lines = lines;
  return fn;
}

const enhanceOK = async (text) => ({ text: `ENHANCED(${text})`, meta: { model: 'mock-model', ms: 5 } });

test('parseHotkey maps alt+b to Carbon keycode/mask and builds a label', () => {
  const parsed = parseHotkey('alt+b');
  assert.equal(parsed.keyCode, 11);
  assert.equal(parsed.modifiers, 1 << 11);
  assert.equal(parsed.label, '⌥B');
  assert.equal(parseHotkey('option+b').modifiers, parseHotkey('alt+b').modifiers);
});

test('parseHotkey supports combined modifiers and named keys', () => {
  const parsed = parseHotkey('cmd+shift+space');
  assert.equal(parsed.keyCode, 49);
  assert.equal(parsed.modifiers, (1 << 8) | (1 << 9));
  assert.equal(parsed.label, '⌘⇧Space');
});

test('parseHotkey rejects modifier-less hotkeys and unknown tokens with config_error', () => {
  for (const bad of ['b', 'hyper+b', 'alt+€', 'alt+cmd+alt']) {
    assert.throws(() => parseHotkey(bad), (err) => err.code === 'config_error', bad);
  }
});

test('evaluateWatchGate honors the D7 evidence gate: force, missing, passing and failing reports', async () => {
  assert.equal((await evaluateWatchGate({ force: true })).ok, true);

  const missing = await evaluateWatchGate({});
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /Spike-0/);

  const passingReport = JSON.stringify({
    schemaVersion: 'prompt-contract/spike-0.v1',
    kind: 'compatibility-report',
    decision: { pass: true, reasons: [], watchGate: 'closed' },
  });
  const passing = await evaluateWatchGate({ reportPath: '/tmp/r.json', readFile: async () => passingReport });
  assert.equal(passing.ok, true);

  const failingReport = JSON.stringify({
    schemaVersion: 'prompt-contract/spike-0.v1',
    kind: 'compatibility-report',
    decision: { pass: false, reasons: ['capture success 0.5 is below 0.9'] },
  });
  const failing = await evaluateWatchGate({ reportPath: '/tmp/r.json', readFile: async () => failingReport });
  assert.equal(failing.ok, false);
  assert.match(failing.reason, /capture success 0.5/);

  const notJson = await evaluateWatchGate({ reportPath: '/tmp/r.json', readFile: async () => 'nope{' });
  assert.equal(notJson.ok, false);
  assert.match(notJson.reason, /not valid JSON|not a Spike-0/);

  const wrongSchema = await evaluateWatchGate({
    reportPath: '/tmp/r.json',
    readFile: async () => JSON.stringify({ schemaVersion: 'other.v9', kind: 'compatibility-report', decision: { pass: true } }),
  });
  assert.equal(wrongSchema.ok, false);
});

test('probeCaptureSafety passes read-only and reports permission failures precisely', async () => {
  const okAdapter = fakeAdapter();
  const ok = await probeCaptureSafety(okAdapter);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.warnings, []);
  assert.equal(okAdapter.state.pasteSelectionCalls, 0, 'probe never pastes');

  const clipboardFail = await probeCaptureSafety({ readClipboard: async () => { throw new Error('no pbpaste'); } });
  assert.equal(clipboardFail.ok, false);
  assert.match(clipboardFail.error, /clipboard read failed/);

  const warned = await probeCaptureSafety({
    readClipboard: async () => 'text',
    checkClipboardRestorable: async () => { throw new Error('clipboard_not_plain_text'); },
    getFocusIdentity: async () => context(),
  });
  assert.equal(warned.ok, true);
  assert.equal(warned.warnings.length, 1);
  assert.match(warned.warnings[0], /not text-only/);

  const noAccessibility = await probeCaptureSafety({
    readClipboard: async () => 'text',
    checkClipboardRestorable: async () => {},
    getFocusIdentity: async () => { throw new Error('osascript-focus failed'); },
  });
  assert.equal(noAccessibility.ok, false);
  assert.match(noAccessibility.error, /Accessibility/);
});

test('watch cycle: capture → enhance → focus re-check → paste → clipboard restored', async () => {
  const adapter = fakeAdapter();
  const notify = recordingNotify();
  const log = recordingLog();
  const service = createWatchService({ adapter, enhance: enhanceOK, options: { cooldownMs: 0, pasteDelayMs: 0 }, notify, log });

  await service.handleTrigger();

  assert.equal(notify.calls.length, 0, JSON.stringify(notify.calls));
  assert.equal(adapter.state.pasteSelectionCalls, 1);
  assert.equal(adapter.state.clipboard, 'keep this clipboard', 'original clipboard restored');
  assert.equal(adapter.state.events.filter((e) => Array.isArray(e) && e[1] === 'ENHANCED(selected prompt)').length, 1, 'enhanced text placed on clipboard exactly once');
  assert.equal(service.isBusy(), false);
  assert.equal(log.lines.some((line) => line.includes('pasted enhanced text')), true, log.lines.join('\n'));
});

test('watch paste aborts on focus drift and never mutates user text', async () => {
  const drifted = context({ pid: 456, windowTitle: 'Other app' });
  const adapter = fakeAdapter({ contexts: [context(), context(), drifted, drifted] });
  const notify = recordingNotify();
  const service = createWatchService({ adapter, enhance: enhanceOK, options: { cooldownMs: 0, pasteDelayMs: 0 }, notify });

  await service.handleTrigger();

  assert.equal(adapter.state.pasteSelectionCalls, 0);
  assert.equal(adapter.state.clipboard, 'keep this clipboard');
  assert.equal(notify.calls.length, 1);
  assert.match(notify.calls[0].message, /Focus moved/);
  assert.match(notify.calls[0].message, /return to Google Chrome/);
});

test('watch falls back to the clipboard when nothing is selected, and notifies when both are empty', async () => {
  const fallbackAdapter = fakeAdapter({ clipboard: 'clipboard prompt', selectedText: '' });
  const notify = recordingNotify();
  const log = recordingLog();
  const service = createWatchService({ adapter: fallbackAdapter, enhance: enhanceOK, options: { cooldownMs: 0, pasteDelayMs: 0 }, notify, log });

  await service.handleTrigger();
  assert.equal(notify.calls.length, 0);
  assert.equal(fallbackAdapter.state.pasteSelectionCalls, 1);
  assert.equal(log.lines.some((line) => line.includes('from clipboard')), true);

  const emptyAdapter = fakeAdapter({ clipboard: '', selectedText: '' });
  const service2 = createWatchService({ adapter: emptyAdapter, enhance: enhanceOK, options: { cooldownMs: 0 }, notify });
  await service2.handleTrigger();
  assert.equal(emptyAdapter.state.pasteSelectionCalls, 0);
  assert.match(notify.calls.at(-1).message, /No selected text/);
});

test('watch survives provider errors: notified, no paste, loop reusable', async () => {
  const adapter = fakeAdapter();
  const notify = recordingNotify();
  let calls = 0;
  const failingEnhance = async () => {
    calls += 1;
    const err = new Error('upstream down');
    err.code = 'provider_unavailable';
    throw err;
  };
  const service = createWatchService({ adapter, enhance: failingEnhance, options: { cooldownMs: 0, pasteDelayMs: 0 }, notify });

  await service.handleTrigger();
  assert.equal(calls, 1);
  assert.equal(adapter.state.pasteSelectionCalls, 0);
  assert.match(notify.calls[0].message, /provider_unavailable/);

  adapter.state.contexts = [context(), context(), context(), context()];
  adapter.enhance = enhanceOK;
  const service2 = createWatchService({ adapter, enhance: enhanceOK, options: { cooldownMs: 0, pasteDelayMs: 0 }, notify });
  await service2.handleTrigger();
  assert.equal(adapter.state.pasteSelectionCalls, 1);
});

test('watch ignores triggers while a cycle is in flight and during cooldown (D8: no queueing)', async () => {
  const adapter = fakeAdapter();
  const notify = recordingNotify();
  let releaseEnhance;
  const gate = new Promise((resolve) => { releaseEnhance = resolve; });
  let enhanceCalls = 0;
  const slowEnhance = async (text) => {
    enhanceCalls += 1;
    await gate;
    return enhanceOK(text);
  };
  const service = createWatchService({ adapter, enhance: slowEnhance, options: { cooldownMs: 50, pasteDelayMs: 0 }, notify, now: (() => { let t = 0; return () => (t += 25); })() });

  const first = service.handleTrigger();
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the first cycle reach the pending enhance
  await service.handleTrigger(); // busy — ignored
  releaseEnhance();
  await first;
  await service.handleTrigger(); // cooldown window (clock advanced only 25+25) — ignored

  assert.equal(enhanceCalls, 1);
  assert.equal(adapter.state.pasteSelectionCalls, 1);
});

test('watch dry-run enhances but never touches the clipboard for pasting', async () => {
  const adapter = fakeAdapter();
  const log = recordingLog();
  const service = createWatchService({ adapter, enhance: enhanceOK, options: { cooldownMs: 0, dryRun: true }, log });

  await service.handleTrigger();

  assert.equal(adapter.state.pasteSelectionCalls, 0);
  assert.equal(adapter.state.clipboard, 'keep this clipboard');
  assert.equal(log.lines.some((line) => line.includes('dry-run')), true);
  assert.equal(log.lines.some((line) => line.includes('ENHANCED(selected prompt)')), true);
});

test('watch pastes even when the clipboard cannot be preserved, and says so', async () => {
  const adapter = fakeAdapter({ clipboardCheckErrorInPaste: true });
  const log = recordingLog();
  const service = createWatchService({ adapter, enhance: enhanceOK, options: { cooldownMs: 0, pasteDelayMs: 0 }, log });

  await service.handleTrigger();

  assert.equal(adapter.state.pasteSelectionCalls, 1);
  assert.equal(log.lines.some((line) => line.includes('non-text content')), true);
});

test('the embedded Swift helper source is interpolation-free and registers via Carbon', () => {
  assert.match(HELPER_SOURCE, /RegisterEventHotKey/);
  assert.match(HELPER_SOURCE, /kEventHotKeyPressed/);
  assert.match(HELPER_SOURCE, /setActivationPolicy\(\.accessory\)/);
  assert.doesNotMatch(HELPER_SOURCE, /\\\(/, 'Swift interpolation would be eaten by the JS template literal');
});

function fakeSource() {
  const source = {
    label: '⌥B',
    started: false,
    stopped: false,
    triggerCb: null,
    exitCb: null,
    onTrigger(cb) { source.triggerCb = cb; },
    onExit(cb) { source.exitCb = cb; },
    async start() { source.started = true; return source.label; },
    async stop() { source.stopped = true; source.exitCb?.({ code: 0, clean: true }); },
  };
  return source;
}

test('runWatch gates on evidence before starting anything (D7)', async () => {
  const source = fakeSource();
  const log = recordingLog();

  const code = await runWatch({}, { isMacOSPlatform: true, source, log, registerSignals: false });

  assert.equal(code, 2);
  assert.equal(source.started, false);
  assert.equal(log.lines.some((line) => line.includes('evidence gate')), true);

  const forcedRun = runWatch(
    { force: true },
    { isMacOSPlatform: true, source, adapter: fakeAdapter(), enhance: enhanceOK, log, registerSignals: false },
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(source.started, true);
  await source.stop(); // resolves the resident loop
  assert.equal(await forcedRun, 0);
});

test('runWatch refuses non-macOS platforms up front', async () => {
  const source = fakeSource();
  const log = recordingLog();
  const code = await runWatch({}, { isMacOSPlatform: false, source, log });
  assert.equal(code, 2);
  assert.equal(source.started, false);
  assert.match(log.lines[0], /macOS-only/);
});

test('resolveWatchHotkey: --hotkey flag > config.json "hotkey" > default', () => {
  assert.equal(resolveWatchHotkey({}, {}), 'alt+b');
  assert.equal(resolveWatchHotkey({}, { hotkey: 'ctrl+alt+b' }), 'ctrl+alt+b');
  assert.equal(resolveWatchHotkey({ hotkey: 'cmd+shift+s' }, { hotkey: 'ctrl+alt+b' }), 'cmd+shift+s');
});

test('runWatch fails fast on an invalid configured hotkey before going resident', async () => {
  const source = fakeSource();
  const log = recordingLog();
  const code = await runWatch(
    { force: true },
    { isMacOSPlatform: true, source, adapter: fakeAdapter(), enhance: enhanceOK, config: { hotkey: 'hyper+b' }, log, registerSignals: false },
  );
  assert.equal(code, 2);
  assert.equal(source.started, false);
  assert.match(log.lines.join('\n'), /unknown hotkey modifier "hyper"/);
  assert.match(log.lines.join('\n'), /hotkey" field in ~\/\.prompt-contract\/config\.json/);
});

test('runWatch end-to-end with injected fakes: probe → banner → trigger → paste → clean stop', async () => {
  const adapter = fakeAdapter();
  const source = fakeSource();
  const notify = recordingNotify();
  const log = recordingLog();

  const run = runWatch(
    { force: true, dryRun: false },
    { isMacOSPlatform: true, adapter, enhance: enhanceOK, source, notify, log, registerSignals: false },
  );

  // let runWatch reach the resident banner, then fire the hotkey once
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(source.started, true);
  assert.equal(log.lines.some((line) => line.includes('prompt-contract watch resident')), true, log.lines.join('\n'));
  source.triggerCb();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(adapter.state.pasteSelectionCalls, 1);
  assert.equal(log.lines.some((line) => line.includes('pasted enhanced text')), true);

  await source.stop(); // triggers the exit path
  const code = await run;
  assert.equal(code, 0);
  assert.equal(log.lines.some((line) => line.includes('watch: stopped')), true);
});

test('runWatch propagates trigger-source crashes as exit code 1', async () => {
  const adapter = fakeAdapter();
  const source = fakeSource();
  const log = recordingLog();
  const run = runWatch(
    { force: true },
    { isMacOSPlatform: true, adapter, enhance: enhanceOK, source, log, registerSignals: false },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  source.exitCb({ code: 9, clean: false });
  const code = await run;
  assert.equal(code, 1);
});

test('stdin trigger source fires per line and quits on q or EOF', async () => {
  const input = new PassThrough();
  const source = createStdinTriggerSource({ input });
  const triggers = [];
  let exitInfo = null;
  source.onTrigger(() => triggers.push(1));
  source.onExit((info) => { exitInfo = info; });
  await source.start();
  input.write('go\n');
  input.write('\n');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(triggers.length, 2);

  input.write('q\n');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(exitInfo, { code: 0, clean: true });
  await source.stop();
});

test('defaults are frozen and documented values hold', () => {
  assert.equal(DEFAULT_WATCH_OPTIONS.hotkey, 'alt+b');
  assert.equal(DEFAULT_WATCH_OPTIONS.settleMs, 75);
  assert.equal(DEFAULT_WATCH_OPTIONS.pasteDelayMs, 1000);
  assert.equal(DEFAULT_WATCH_OPTIONS.dryRun, false);
});
