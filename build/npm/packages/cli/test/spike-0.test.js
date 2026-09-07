import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureSelectedText,
  validatePasteBackDryRun,
  buildCompatibilityReport,
  DEFAULT_SPIKE_THRESHOLDS,
  isPlainTextClipboardInfo,
  runSpike0,
} from '../src/spike-0.js';

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
  contexts = [context(), context(), context()],
  copyError,
  clipboardCheckError,
} = {}) {
  const state = { clipboard, events: [], contexts: [...contexts] };
  return {
    state,
    async readClipboard() {
      state.events.push('readClipboard');
      return state.clipboard;
    },
    async checkClipboardRestorable() {
      state.events.push('checkClipboardRestorable');
      if (clipboardCheckError) throw clipboardCheckError;
    },
    async writeClipboard(value) {
      state.events.push(['writeClipboard', value]);
      state.clipboard = value;
    },
    async copySelection() {
      state.events.push('copySelection');
      if (copyError) throw copyError;
      state.clipboard = selectedText;
    },
    async getFocusIdentity() {
      state.events.push('getFocusIdentity');
      return state.contexts.shift() || context();
    },
    async sleep() {
      state.events.push('sleep');
    },
  };
}

test('captureSelectedText restores the original clipboard after a successful copy', async () => {
  const adapter = fakeAdapter();

  const result = await captureSelectedText(adapter, { settleMs: 0 });

  assert.equal(result.selectedText, 'selected prompt');
  assert.equal(result.selectedTextLength, 15);
  assert.equal(result.clipboardRestored, true);
  assert.equal(result.userTextMutated, false);
  assert.equal(adapter.state.clipboard, 'keep this clipboard');
  assert.deepEqual(adapter.state.events, [
    'readClipboard',
    'checkClipboardRestorable',
    'getFocusIdentity',
    'copySelection',
    'sleep',
    'readClipboard',
    'getFocusIdentity',
    ['writeClipboard', 'keep this clipboard'],
    'readClipboard',
  ]);
});

test('captureSelectedText restores the clipboard when copy fails', async () => {
  const adapter = fakeAdapter({ copyError: new Error('Accessibility denied') });

  const result = await captureSelectedText(adapter, { settleMs: 0 });

  assert.equal(result.selectedText, null);
  assert.equal(result.clipboardRestored, true);
  assert.equal(result.userTextMutated, false);
  assert.match(result.error, /Accessibility denied/);
  assert.equal(adapter.state.clipboard, 'keep this clipboard');
  assert.equal(adapter.state.events.some((event) => Array.isArray(event) && event[0] === 'writeClipboard'), true);
});

test('captureSelectedText refuses an unsupported clipboard without rewriting it', async () => {
  const adapter = fakeAdapter({ clipboardCheckError: new Error('clipboard_not_plain_text') });

  const result = await captureSelectedText(adapter, { settleMs: 0 });

  assert.equal(result.selectedText, null);
  assert.match(result.error, /clipboard_not_plain_text/);
  assert.equal(result.clipboardRestored, false);
  assert.equal(result.clipboardUntouched, true);
  assert.equal(adapter.state.clipboard, 'keep this clipboard');
  assert.equal(adapter.state.events.includes('copySelection'), false);
  assert.equal(adapter.state.events.some((event) => Array.isArray(event) && event[0] === 'writeClipboard'), false);
});

test('isPlainTextClipboardInfo accepts text-only pasteboards and rejects rich types', () => {
  assert.equal(
    isPlainTextClipboardInfo('«class utf8», 0, «class ut16», 2, string, 0, Unicode text, 0'),
    true,
  );
  assert.equal(
    isPlainTextClipboardInfo('«class utf8», 4, «class HTML», 128'),
    false,
  );
});

test('runSpike0 supports a setup delay before each target without changing capture semantics', async () => {
  const adapter = fakeAdapter();
  const announcements = [];

  await runSpike0({
    adapter,
    targets: ['Chrome'],
    iterations: 1,
    setupDelayMs: 25,
    interactive: false,
    announce: (message) => announcements.push(message),
    now: () => new Date('2026-09-07T00:00:00.000Z'),
  });

  assert.deepEqual(announcements, ['Focus Chrome and select text now; capture starts after the setup delay.']);
  assert.equal(adapter.state.events[0], 'sleep');
  assert.equal(adapter.state.events.includes('copySelection'), true);
});

test('validatePasteBackDryRun checks focus stability without issuing paste', async () => {
  const adapter = fakeAdapter();
  const before = context();

  const result = await validatePasteBackDryRun(adapter, {
    capturedContext: before,
    selectedText: 'selected prompt',
    pauseMs: 0,
  });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.executed, false);
  assert.equal(result.wouldPasteBack, true);
  assert.equal(result.userTextMutated, false);
  assert.equal(adapter.state.events.includes('pasteSelection'), false);
});

test('validatePasteBackDryRun rejects focus drift without changing user text', async () => {
  const adapter = fakeAdapter({ contexts: [context({ pid: 456, windowTitle: 'Other app' })] });

  const result = await validatePasteBackDryRun(adapter, {
    capturedContext: context(),
    selectedText: 'selected prompt',
    pauseMs: 0,
  });

  assert.equal(result.wouldPasteBack, false);
  assert.equal(result.reason, 'focus_drift');
  assert.equal(result.executed, false);
  assert.equal(result.userTextMutated, false);
});

test('validatePasteBackDryRun tolerates a transiently unavailable window title', async () => {
  const adapter = fakeAdapter({ contexts: [context({ windowTitle: '' })] });

  const result = await validatePasteBackDryRun(adapter, {
    capturedContext: context(),
    selectedText: 'selected prompt',
    pauseMs: 0,
  });

  assert.equal(result.wouldPasteBack, true);
  assert.equal(result.focusStable, true);
  assert.equal(result.executed, false);
});

test('buildCompatibilityReport applies the Spike-0 cohort thresholds', () => {
  const runs = [];
  for (const target of ['Chrome', 'PyCharm', 'iTerm']) {
    for (let iteration = 1; iteration <= 20; iteration++) {
      runs.push({
        target,
        iteration,
        capture: {
          selectedTextCaptured: true,
          clipboardRestored: true,
          clipboardRestoreVerified: true,
          focusRecorded: true,
        },
        pasteBack: { mode: 'dry-run', wouldPasteBack: true, contextAtValidation: {} },
        safety: { userTextMutated: false, pasteCommandSent: false },
      });
    }
  }

  const report = buildCompatibilityReport({
    runs,
    targets: ['Chrome', 'PyCharm', 'iTerm'],
    thresholds: DEFAULT_SPIKE_THRESHOLDS,
    platformInfo: { os: 'darwin', arch: 'arm64' },
    startedAt: '2026-09-07T00:00:00.000Z',
    finishedAt: '2026-09-07T00:00:01.000Z',
  });

  assert.equal(report.schemaVersion, 'prompt-contract/spike-0.v1');
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.summary.captureSuccessRate, 1);
  assert.equal(report.summary.clipboardRestoreSuccessRate, 1);
  assert.equal(report.decision.pass, true);
  assert.equal(report.decision.watchGate, 'closed');
});

test('buildCompatibilityReport fails below the combined capture threshold', () => {
  const runs = [];
  for (const target of ['Chrome', 'PyCharm', 'iTerm']) {
    for (let iteration = 1; iteration <= 20; iteration++) {
      const failed = target === 'iTerm' && iteration <= 7;
      runs.push({
        target,
        iteration,
        capture: {
          selectedTextCaptured: !failed,
          clipboardRestored: true,
          clipboardRestoreVerified: true,
          focusRecorded: true,
        },
        pasteBack: { mode: 'dry-run', wouldPasteBack: !failed, contextAtValidation: {} },
        safety: { userTextMutated: false, pasteCommandSent: false },
      });
    }
  }

  const report = buildCompatibilityReport({
    runs,
    targets: ['Chrome', 'PyCharm', 'iTerm'],
    thresholds: DEFAULT_SPIKE_THRESHOLDS,
    platformInfo: { os: 'darwin', arch: 'arm64' },
    startedAt: '2026-09-07T00:00:00.000Z',
    finishedAt: '2026-09-07T00:00:01.000Z',
  });

  assert.equal(report.summary.captureSuccessRate, 0.8833);
  assert.equal(report.decision.pass, false);
  assert.match(report.decision.reasons.join(' '), /dry-run paste-back/);
});
