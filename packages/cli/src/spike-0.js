import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { arch, platform, version as nodeVersion } from 'node:process';

const MACOS = 'darwin';
const FIELD_SEPARATOR = String.fromCharCode(30);
const CLIPBOARD_INFO_SCRIPT = 'clipboard info';
const PLAIN_TEXT_CLIPBOARD_TYPES = new Set(['string', 'unicode text', '«class utf8»', '«class ut16»', '«class utxt»']);

export const DEFAULT_SPIKE_THRESHOLDS = Object.freeze({
  iterationsPerTarget: 20,
  requiredTargets: ['Chrome', 'PyCharm', 'iTerm'],
  combinedCaptureSuccessRateMin: 0.9,
  combinedDryRunPasteBackRateMin: 0.9,
  clipboardRestoreSuccessRateMin: 1,
  focusRecordRateMin: 1,
  maxSafetyFailures: 0,
});

export const APP_TARGETS = Object.freeze({
  Chrome: Object.freeze({
    kind: 'browser',
    aliases: ['chrome', 'google chrome'],
    bundleIds: ['com.google.chrome'],
  }),
  PyCharm: Object.freeze({
    kind: 'editor',
    aliases: ['pycharm', 'pycharm ce', 'pycharm community', 'pycharm professional'],
    bundleIds: ['com.jetbrains.pycharm'],
  }),
  iTerm: Object.freeze({
    kind: 'terminal',
    aliases: ['iterm', 'iterm2'],
    bundleIds: ['com.googlecode.iterm2'],
  }),
});

const COPY_SCRIPT = 'tell application "System Events" to keystroke "c" using {command down}';
// Used only by prompt-contract watch. The Spike-0 diagnostic itself never issues ⌘V; its
// safety contract is enforced in captureSelectedText/validatePasteBackDryRun.
const PASTE_SCRIPT = 'tell application "System Events" to keystroke "v" using {command down}';

// The report deliberately excludes AXValue: it can contain the user's prompt or
// other sensitive text. These attributes are enough to conservatively detect a
// focus change while keeping the report useful for a compatibility matrix.
const CONTEXT_SCRIPT = String.raw`
on replaceText(findText, replaceWith, subjectText)
  set oldDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to findText
  set textParts to text items of subjectText
  set AppleScript's text item delimiters to replaceWith
  set resultText to textParts as text
  set AppleScript's text item delimiters to oldDelimiters
  return resultText
end replaceText

on safeText(valueToConvert)
  try
    set textValue to valueToConvert as text
  on error
    set textValue to ""
  end try
  set textValue to my replaceText((ASCII character 30), " ", textValue)
  set textValue to my replaceText(return, " ", textValue)
  set textValue to my replaceText(linefeed, " ", textValue)
  return textValue
end safeText

on axAttribute(elementReference, attributeName)
  try
    tell application "System Events"
      return value of attribute attributeName of elementReference
    end tell
  on error
    return ""
  end try
end axAttribute

tell application "System Events"
  set frontProcess to first application process whose frontmost is true
  set processName to my safeText(name of frontProcess)
  try
    set processId to my safeText(unix id of frontProcess)
  on error
    set processId to ""
  end try
  try
    set bundleId to my safeText(bundle identifier of frontProcess)
  on error
    set bundleId to ""
  end try
  try
    set windowTitle to my safeText(name of front window of frontProcess)
  on error
    set windowTitle to ""
  end try

  set focusedElement to my axAttribute(frontProcess, "AXFocusedUIElement")
  set focusRole to my safeText(my axAttribute(focusedElement, "AXRole"))
  set focusSubrole to my safeText(my axAttribute(focusedElement, "AXSubrole"))
  set focusIdentifier to my safeText(my axAttribute(focusedElement, "AXIdentifier"))
  set focusTitle to my safeText(my axAttribute(focusedElement, "AXTitle"))
  set focusDescription to my safeText(my axAttribute(focusedElement, "AXDescription"))
  set focusRoleDescription to my safeText(my axAttribute(focusedElement, "AXRoleDescription"))

  set outputFields to {processName, bundleId, processId, windowTitle, focusRole, focusSubrole, focusIdentifier, focusTitle, focusDescription, focusRoleDescription}
  set AppleScript's text item delimiters to (ASCII character 30)
  set outputText to outputFields as text
  set AppleScript's text item delimiters to ""
  return outputText
end tell
`;

function errorText(error) {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

function commandError(command, result) {
  const detail = String(result?.stderr || '').trim();
  const error = new Error(`${command} failed${detail ? `: ${detail}` : ''}`);
  error.code = `${command}_failed`;
  return error;
}

function runCommand(command, args = [], { input, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input, 'utf8');
  });
}

function stripFinalNewline(value) {
  return value.endsWith('\n') ? value.slice(0, -1).replace(/\r$/, '') : value;
}

export function isPlainTextClipboardInfo(output) {
  const parts = String(output || '').split(',').map((part) => part.trim());
  if (!parts.length || (parts.length === 1 && !parts[0])) return true;
  if (parts.length % 2 !== 0) return false;
  const typeNames = parts.filter((_, index) => index % 2 === 0).map((typeName) => typeName.toLowerCase());
  return typeNames.every((typeName) => PLAIN_TEXT_CLIPBOARD_TYPES.has(typeName));
}

function parseContext(output) {
  const fields = stripFinalNewline(output).split(FIELD_SEPARATOR);
  if (fields.length < 10 || !fields[0]) {
    const error = new Error('Accessibility query returned an incomplete foreground/focus identity');
    error.code = 'focus_identity_incomplete';
    throw error;
  }
  const [processName, bundleId, pidText, windowTitle, role, subrole, identifier, title, description, roleDescription] = fields;
  const focus = { role, subrole, identifier, title, description, roleDescription };
  return {
    processName,
    bundleId,
    pid: pidText ? Number(pidText) : null,
    windowTitle,
    focus,
    focusFingerprint: fingerprintForContext({ processName, bundleId, pid: pidText, windowTitle, focus }),
  };
}

export function createMacOSAdapter({ run = runCommand } = {}) {
  return {
    async readClipboard() {
      const result = await run('/usr/bin/pbpaste', ['-Prefer', 'public.utf8-plain-text']);
      if (result.error) throw result.error;
      if (result.code !== 0) throw commandError('pbpaste', result);
      return result.stdout;
    },

    async writeClipboard(value) {
      const result = await run('/usr/bin/pbcopy', [], { input: value });
      if (result.error) throw result.error;
      if (result.code !== 0) throw commandError('pbcopy', result);
    },

    async checkClipboardRestorable() {
      const result = await run('/usr/bin/osascript', ['-e', CLIPBOARD_INFO_SCRIPT]);
      if (result.error) throw result.error;
      if (result.code !== 0) throw commandError('osascript-clipboard-info', result);
      const clipboardInfo = stripFinalNewline(result.stdout);
      if (!isPlainTextClipboardInfo(clipboardInfo)) {
        const error = new Error('clipboard_not_plain_text: only text pasteboards are restorable by this Spike-0');
        error.code = 'clipboard_not_plain_text';
        throw error;
      }
    },

    async copySelection() {
      const result = await run('/usr/bin/osascript', ['-e', COPY_SCRIPT]);
      if (result.error) throw result.error;
      if (result.code !== 0) throw commandError('osascript-copy', result);
    },

    async pasteSelection() {
      const result = await run('/usr/bin/osascript', ['-e', PASTE_SCRIPT]);
      if (result.error) throw result.error;
      if (result.code !== 0) throw commandError('osascript-paste', result);
    },

    async getFocusIdentity() {
      const result = await run('/usr/bin/osascript', ['-e', CONTEXT_SCRIPT], { timeoutMs: 5000 });
      if (result.error) throw result.error;
      if (result.code !== 0) throw commandError('osascript-focus', result);
      return parseContext(result.stdout);
    },

    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}

function normalizeTargetLabel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  for (const [label, spec] of Object.entries(APP_TARGETS)) {
    if (label.toLowerCase() === normalized || spec.aliases.includes(normalized)) return label;
  }
  return null;
}

export function resolveSpikeTargets(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  const labels = values.map(normalizeTargetLabel).filter(Boolean);
  const invalid = values.filter((item) => String(item || '').trim() && !normalizeTargetLabel(item));
  if (invalid.length) {
    const error = new Error(`unknown Spike-0 target(s): ${invalid.join(', ')}; choose Chrome, PyCharm, or iTerm`);
    error.code = 'invalid_spike_target';
    throw error;
  }
  return [...new Set(labels)];
}

function normalized(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function targetMatchesContext(target, context) {
  const label = normalizeTargetLabel(target);
  if (!label || !context) return false;
  const spec = APP_TARGETS[label];
  const bundleId = normalized(context.bundleId);
  const processName = normalized(context.processName);
  return spec.bundleIds.some((id) => bundleId === id || bundleId.startsWith(`${id}.`))
    || spec.aliases.some((alias) => processName === alias || processName.includes(alias));
}

function fingerprintForContext(context) {
  const focus = context?.focus || {};
  const fields = [
    context?.processName,
    context?.bundleId,
    context?.pid,
    focus.role,
    focus.subrole,
    focus.identifier,
    focus.title,
    focus.description,
    focus.roleDescription,
  ].map((value) => String(value ?? ''));
  return createHash('sha256').update(fields.join('\u001f')).digest('hex').slice(0, 16);
}

export function sameFocusIdentity(left, right) {
  if (!left || !right) return false;
  const appStable = normalized(left.processName) === normalized(right.processName)
    && normalized(left.bundleId) === normalized(right.bundleId)
    && String(left.pid ?? '') === String(right.pid ?? '');
  const bothWindowTitlesKnown = Boolean(left.windowTitle) && Boolean(right.windowTitle);
  const windowStable = !bothWindowTitlesKnown || left.windowTitle === right.windowTitle;
  return appStable && windowStable && fingerprintForContext(left) === fingerprintForContext(right);
}

export async function captureSelectedText(adapter, { settleMs = 75 } = {}) {
  let originalClipboard;
  let snapshotTaken = false;
  let contextBefore = null;
  let contextAfterCapture = null;
  let selectedText = null;
  let error = null;
  let restoreError = null;
  let clipboardRestored = false;
  let clipboardRestoreVerified = false;
  let clipboardUntouched = true;
  let clipboardMayHaveChanged = false;

  try {
    originalClipboard = await adapter.readClipboard();
    snapshotTaken = true;
    if (typeof adapter.checkClipboardRestorable === 'function') {
      await adapter.checkClipboardRestorable();
    }
    contextBefore = await adapter.getFocusIdentity();
    clipboardMayHaveChanged = true;
    clipboardUntouched = false;
    await adapter.copySelection();
    await adapter.sleep(settleMs);
    let copiedText = await adapter.readClipboard();
    // ⌘C is delivered asynchronously: a read that still shows the pre-copy
    // clipboard means the copy has not landed — poll briefly instead of
    // mistaking the stale clipboard for the selection. A read identical to the
    // pre-copy clipboard after polling reports an empty selection (the
    // clipboard fallback then covers the intentional selection==clipboard case).
    for (let polls = 0; copiedText === originalClipboard && polls < 6; polls++) {
      await adapter.sleep(60);
      copiedText = await adapter.readClipboard();
    }
    selectedText = typeof copiedText === 'string' && copiedText.trim() && copiedText !== originalClipboard ? copiedText : null;
    contextAfterCapture = await adapter.getFocusIdentity();
  } catch (captureError) {
    error = captureError;
  } finally {
    if (snapshotTaken && clipboardMayHaveChanged) {
      try {
        await adapter.writeClipboard(originalClipboard);
        clipboardRestored = true;
        clipboardRestoreVerified = (await adapter.readClipboard()) === originalClipboard;
      } catch (restoreFailure) {
        restoreError = restoreFailure;
      }
    }
  }

  return {
    selectedText,
    selectedTextLength: selectedText ? selectedText.length : 0,
    selectedTextCaptured: Boolean(selectedText),
    clipboardRestored,
    clipboardRestoreVerified,
    clipboardUntouched,
    focusRecorded: Boolean(contextBefore),
    contextBefore,
    contextAfterCapture,
    error: errorText(error),
    restoreError: errorText(restoreError),
    userTextMutated: false,
    pasteCommandSent: false,
  };
}

export async function validatePasteBackDryRun(adapter, {
  capturedContext,
  selectedText,
  pauseMs = 0,
} = {}) {
  if (pauseMs > 0) await adapter.sleep(pauseMs);

  let contextAtValidation = null;
  let error = null;
  try {
    contextAtValidation = await adapter.getFocusIdentity();
  } catch (validationError) {
    error = validationError;
  }

  const focusStable = sameFocusIdentity(capturedContext, contextAtValidation);
  const selectedTextCaptured = typeof selectedText === 'string' && Boolean(selectedText.trim());
  let reason = 'ready';
  if (!selectedTextCaptured) reason = 'empty_selection';
  else if (!focusStable) reason = 'focus_drift';
  if (error) reason = 'focus_identity_unavailable';

  return {
    mode: 'dry-run',
    executed: false,
    pasteCommandSent: false,
    userTextMutated: false,
    focusStable,
    wouldPasteBack: selectedTextCaptured && focusStable && !error,
    reason,
    contextAtValidation,
    error: errorText(error),
  };
}

function rate(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : 0;
}

function summarizeRuns(runs) {
  const attempts = runs.length;
  const captureSuccesses = runs.filter((run) => run.capture?.selectedTextCaptured).length;
  const clipboardRestoreSuccesses = runs.filter((run) => run.capture?.clipboardRestored && run.capture?.clipboardRestoreVerified).length;
  const focusRecords = runs.filter((run) => run.capture?.focusRecorded && run.pasteBack?.contextAtValidation).length;
  const dryRunPasteBackSuccesses = runs.filter((run) => run.pasteBack?.wouldPasteBack).length;
  const safetyFailures = runs.filter((run) => run.safety?.userTextMutated || run.safety?.pasteCommandSent).length;
  return {
    attempts,
    captureSuccesses,
    captureSuccessRate: rate(captureSuccesses, attempts),
    clipboardRestoreSuccesses,
    clipboardRestoreSuccessRate: rate(clipboardRestoreSuccesses, attempts),
    focusRecords,
    focusRecordRate: rate(focusRecords, attempts),
    dryRunPasteBackSuccesses,
    dryRunPasteBackRate: rate(dryRunPasteBackSuccesses, attempts),
    safetyFailures,
  };
}

export function buildCompatibilityReport({
  runs,
  targets,
  thresholds = DEFAULT_SPIKE_THRESHOLDS,
  platformInfo = { os: platform, arch, node: nodeVersion },
  startedAt,
  finishedAt,
} = {}) {
  const allRuns = Array.isArray(runs) ? runs : [];
  const selectedTargets = [...new Set((targets || []).map(normalizeTargetLabel).filter(Boolean))];
  const summary = summarizeRuns(allRuns);
  const byTarget = Object.fromEntries(selectedTargets.map((target) => [
    target,
    summarizeRuns(allRuns.filter((run) => run.target === target)),
  ]));
  const reasons = [];

  for (const required of thresholds.requiredTargets) {
    const targetSummary = byTarget[required];
    if (!targetSummary || targetSummary.attempts < thresholds.iterationsPerTarget) {
      reasons.push(`${required} requires ${thresholds.iterationsPerTarget} attempts`);
    }
  }
  if (summary.captureSuccessRate < thresholds.combinedCaptureSuccessRateMin) {
    reasons.push(`capture success ${summary.captureSuccessRate} is below ${thresholds.combinedCaptureSuccessRateMin}`);
  }
  if (summary.dryRunPasteBackRate < thresholds.combinedDryRunPasteBackRateMin) {
    reasons.push(`dry-run paste-back eligibility ${summary.dryRunPasteBackRate} is below ${thresholds.combinedDryRunPasteBackRateMin}`);
  }
  if (summary.clipboardRestoreSuccessRate < thresholds.clipboardRestoreSuccessRateMin) {
    reasons.push(`clipboard restoration ${summary.clipboardRestoreSuccessRate} is below ${thresholds.clipboardRestoreSuccessRateMin}`);
  }
  if (summary.focusRecordRate < thresholds.focusRecordRateMin) {
    reasons.push(`focus identity coverage ${summary.focusRecordRate} is below ${thresholds.focusRecordRateMin}`);
  }
  if (summary.safetyFailures > thresholds.maxSafetyFailures) {
    reasons.push(`safety failures ${summary.safetyFailures} exceed ${thresholds.maxSafetyFailures}`);
  }

  return {
    schemaVersion: 'prompt-contract/spike-0.v1',
    kind: 'compatibility-report',
    mode: 'dry-run',
    platform: platformInfo,
    startedAt: startedAt || new Date().toISOString(),
    finishedAt: finishedAt || new Date().toISOString(),
    targets: selectedTargets,
    thresholds,
    runs: allRuns,
    summary: { ...summary, byTarget },
    decision: {
      pass: reasons.length === 0,
      reasons,
      watchGate: 'closed',
      note: 'A dry-run cannot prove actual paste landing; this report is evidence for prompt-contract watch, never an authorization by itself.',
    },
  };
}

function makeRunRecord(target, iteration, capture, pasteBack, startedAt, durationMs) {
  const expectedAppMatch = targetMatchesContext(target, capture.contextBefore);
  const capturePass = capture.selectedTextCaptured
    && capture.clipboardRestored
    && capture.clipboardRestoreVerified
    && capture.focusRecorded;
  const pastePass = pasteBack.wouldPasteBack && expectedAppMatch;
  return {
    target,
    iteration,
    startedAt,
    durationMs,
    capture: {
      selectedTextCaptured: capture.selectedTextCaptured,
      selectedTextLength: capture.selectedTextLength,
      clipboardFormat: 'public.utf8-plain-text',
      clipboardRestored: capture.clipboardRestored,
      clipboardRestoreVerified: capture.clipboardRestoreVerified,
      clipboardUntouched: capture.clipboardUntouched,
      focusRecorded: capture.focusRecorded,
      error: capture.error,
      restoreError: capture.restoreError,
    },
    foreground: {
      before: capture.contextBefore,
      afterCapture: capture.contextAfterCapture,
      expectedAppMatch,
    },
    pasteBack: {
      mode: pasteBack.mode,
      executed: pasteBack.executed,
      pasteCommandSent: pasteBack.pasteCommandSent,
      userTextMutated: pasteBack.userTextMutated,
      focusStable: pasteBack.focusStable,
      wouldPasteBack: pastePass,
      reason: expectedAppMatch ? pasteBack.reason : 'unexpected_foreground_app',
      contextAtValidation: pasteBack.contextAtValidation,
      error: pasteBack.error,
    },
    safety: {
      userTextMutated: capture.userTextMutated || pasteBack.userTextMutated,
      pasteCommandSent: capture.pasteCommandSent || pasteBack.pasteCommandSent,
    },
    pass: capturePass && pastePass,
  };
}

async function defaultPrompt(message) {
  if (!process.stdin.isTTY) return;
  const { createInterface } = await import('node:readline/promises');
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    await readline.question(message);
  } finally {
    readline.close();
  }
}

export async function runSpike0({
  adapter = createMacOSAdapter(),
  targets = DEFAULT_SPIKE_THRESHOLDS.requiredTargets,
  iterations = DEFAULT_SPIKE_THRESHOLDS.iterationsPerTarget,
  settleMs = 75,
  pauseMs = 0,
  setupDelayMs = 0,
  interactive = process.stdin.isTTY,
  prompt = defaultPrompt,
  announce = () => {},
  platformInfo = { os: platform, arch, node: nodeVersion },
  now = () => new Date(),
} = {}) {
  const selectedTargets = resolveSpikeTargets(targets);
  const startedAt = now().toISOString();
  const runs = [];

  for (const target of selectedTargets) {
    if (interactive) {
      await prompt(`Focus ${target}, select non-sensitive text, then press Enter (dry-run; never pastes): `);
    }
    if (setupDelayMs > 0) {
      announce('Focus ' + target + ' and select text now; capture starts after the setup delay.');
      await adapter.sleep(setupDelayMs);
    }
    for (let iteration = 1; iteration <= iterations; iteration++) {
      const started = now();
      const capture = await captureSelectedText(adapter, { settleMs });
      const pasteBack = await validatePasteBackDryRun(adapter, {
        capturedContext: capture.contextBefore,
        selectedText: capture.selectedText,
        pauseMs,
      });
      runs.push(makeRunRecord(target, iteration, capture, pasteBack, started.toISOString(), now() - started));
    }
  }

  return buildCompatibilityReport({
    runs,
    targets: selectedTargets,
    thresholds: { ...DEFAULT_SPIKE_THRESHOLDS, iterationsPerTarget: iterations },
    platformInfo,
    startedAt,
    finishedAt: now().toISOString(),
  });
}

export function formatSpike0Summary(report) {
  const status = report.decision.pass ? 'PASS' : 'FAIL';
  const summary = report.summary;
  return [
    `Spike-0 ${status} (dry-run; no paste issued)`,
    `capture ${summary.captureSuccesses}/${summary.attempts} (${summary.captureSuccessRate})`,
    `clipboard restore ${summary.clipboardRestoreSuccesses}/${summary.attempts} (${summary.clipboardRestoreSuccessRate})`,
    `dry-run paste-back eligibility ${summary.dryRunPasteBackSuccesses}/${summary.attempts} (${summary.dryRunPasteBackRate})`,
    report.decision.reasons.length ? `reasons: ${report.decision.reasons.join('; ')}` : 'thresholds met; evidence usable by prompt-contract watch',
  ].join('\n');
}

export const isMacOS = platform === MACOS;
