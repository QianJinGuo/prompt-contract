import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PromptContractError } from '../../core/src/errors.js';
import { createMockServer, EN_RESULT } from '../../../mock/server.js';
import {
  DEFAULT_DRAFT_HOTKEY,
  flattenSingleLine,
  nextDraftAction,
  parseDraftHotkey,
  runDraft,
  runDraftRepl,
} from '../src/draft.js';

test('parseDraftHotkey accepts ctrl/alt combos and normalizes aliases and case', () => {
  assert.deepEqual(parseDraftHotkey('alt+e'), { ctrl: false, alt: true, shift: false, name: 'e', label: 'Alt+E' });
  assert.deepEqual(parseDraftHotkey('Ctrl+K'), { ctrl: true, alt: false, shift: false, name: 'k', label: 'Ctrl+K' });
  assert.deepEqual(parseDraftHotkey('option+7'), { ctrl: false, alt: true, shift: false, name: '7', label: 'Alt+7' });
  assert.deepEqual(parseDraftHotkey('control+alt+p'), { ctrl: true, alt: true, shift: false, name: 'p', label: 'Ctrl+Alt+P' });
  assert.deepEqual(parseDraftHotkey('ctrl+shift+j'), { ctrl: true, alt: false, shift: true, name: 'j', label: 'Ctrl+Shift+J' });
});

test('parseDraftHotkey rejects specs that would hijack typing or cannot reach the terminal', () => {
  cmdRejects('e'); // bare key
  cmdRejects('shift+e'); // shift alone = capital letters
  cmdRejects('cmd+k'); // ⌘ never reaches terminal stdin
  cmdRejects('meta+k'); // meta aliases to cmd here
  cmdRejects('apple+k');
  cmdRejects('hyper+k'); // unknown modifier
  cmdRejects('ctrl'); // modifier with no key
  cmdRejects('ctrl+f1'); // draft keys are a-z / 0-9
  cmdRejects('ctrl+space');
  cmdRejects('');
  function cmdRejects(spec) {
    assert.throws(() => parseDraftHotkey(spec), PromptContractError);
  }
});

test('parseDraftHotkey rejects the reserved exit keys ctrl+c and ctrl+d', () => {
  assert.throws(() => parseDraftHotkey('ctrl+c'), /reserved/);
  assert.throws(() => parseDraftHotkey('ctrl+d'), /reserved/);
  assert.ok(parseDraftHotkey('alt+c')); // alt+c is not an exit key
});

test('parseDraftHotkey rejects duplicate modifiers', () => {
  assert.throws(() => parseDraftHotkey('ctrl+control+k'), /duplicate/);
});

test('nextDraftAction: the configured hotkey enhances from idle and only from idle', () => {
  const ctrlK = { ctrl: true, alt: false, shift: false, name: 'k' };
  assert.deepEqual(nextDraftAction('idle', { name: 'k', ctrl: true }, ctrlK), { kind: 'enhance' });
  assert.deepEqual(nextDraftAction('enhancing', { name: 'k', ctrl: true }, ctrlK), { kind: 'noop' });
  // near-miss modifiers do not trigger
  assert.deepEqual(nextDraftAction('idle', { name: 'k', ctrl: true, shift: true }, ctrlK), { kind: 'noop' });
  assert.deepEqual(nextDraftAction('idle', { name: 'k' }, ctrlK), { kind: 'noop' });
});

test('nextDraftAction: exit keys are reserved in both phases, everything else is noop', () => {
  assert.deepEqual(nextDraftAction('idle', { name: 'c', ctrl: true }, DEFAULT_DRAFT_HOTKEY), { kind: 'exit' });
  assert.deepEqual(nextDraftAction('enhancing', { name: 'd', ctrl: true }, DEFAULT_DRAFT_HOTKEY), { kind: 'exit' });
  assert.deepEqual(nextDraftAction('idle', { name: 'x' }, DEFAULT_DRAFT_HOTKEY), { kind: 'noop' });
  assert.deepEqual(nextDraftAction('idle', { name: 'escape' }, DEFAULT_DRAFT_HOTKEY), { kind: 'noop' });
  assert.deepEqual(nextDraftAction('idle', {}, DEFAULT_DRAFT_HOTKEY), { kind: 'noop' });
});

test('DEFAULT_DRAFT_HOTKEY is Alt+E', () => {
  assert.deepEqual(DEFAULT_DRAFT_HOTKEY, { ctrl: false, alt: true, shift: false, name: 'e', label: 'Alt+E' });
});

test('flattenSingleLine folds multi-line enhancements onto one readline line', () => {
  assert.equal(flattenSingleLine('a\nb\r\nc'), 'a b c');
  assert.equal(flattenSingleLine('a\n\n\nb'), 'a b');
  assert.equal(flattenSingleLine('  x  \n  y  '), 'x y');
  assert.equal(flattenSingleLine('one line'), 'one line');
});

/** Drive the REPL in-process: write keystrokes, poll the collected output. */
async function driveRepl(overrides = {}, script) {
  const { runDraftRepl: repl } = await import('../src/draft.js');
  const input = new PassThrough();
  let out = '';
  const output = new PassThrough();
  output.on('data', (d) => (out += String(d)));
  const deps = {
    input,
    output,
    enhance: async (draft) => `enhanced<${draft.trim()}>`,
    copy: async () => false,
    hotkey: parseDraftHotkey('ctrl+k'),
    ...overrides,
  };
  const done = repl(deps);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const write = (chunk) => new Promise((r) => input.write(chunk, r));
  await script({ write, sleep, until: async (needle, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !out.includes(needle)) await sleep(25);
    if (!out.includes(needle)) throw new Error(`repl output never contained ${JSON.stringify(needle)}; got:\n${out}`);
  } });
  input.end();
  return { code: await done, out };
}

test('runDraftRepl: full loop — draft, hotkey enhance in place, Enter accepts', async () => {
  const { code, out } = await driveRepl({}, async ({ write, until }) => {
    await write('hello world');
    await until('hello world'); // echoed
    await write('\x0b'); // Ctrl+K
    await until('enhanced<hello world>');
    await write('\r');
    await until('clipboard unavailable');
  });
  assert.equal(code, 0);
  assert.match(out, /contract draft/);
  assert.match(out, /Ctrl\+K enhance/);
});

test('runDraftRepl: Ctrl+C exits 0; empty draft ignores the hotkey', async () => {
  const { code, out } = await driveRepl({}, async ({ write, sleep }) => {
    await write('\x0b'); // hotkey on an empty line: silent no-op
    await sleep(150);
    await write('\x03'); // Ctrl+C
  });
  assert.equal(code, 0);
  assert.ok(!out.includes('enhanced<'));
});

test('runDraftRepl: an Alt+E hotkey config is honored', async () => {
  const { code, out } = await driveRepl({ hotkey: parseDraftHotkey('alt+e') }, async ({ write, until }) => {
    await write('draft text');
    await until('draft text');
    await write('\x1be'); // ESC+e arrives combined through the pipe
    await until('enhanced<draft text>');
    await write('\x03');
  });
  assert.equal(code, 0);
  assert.match(out, /Alt\+E enhance/);
});

test('runDraft: invalid --hotkey exits 2 with a fix hint, before any provider setup', async () => {
  let out = '';
  const code = await runDraft({ hotkey: 'ctrl+c' }, {
    output: { write: (d) => (out += String(d)) },
    log: (m) => (out += `${m}\n`),
  });
  assert.equal(code, 2);
  assert.match(out, /reserved/);
});

test('runDraft: config errors (no API key) exit 2 without crashing', async () => {
  let out = '';
  const code = await runDraft({}, {
    output: { write: () => {} },
    log: (m) => (out += `${m}\n`),
    resolveConfigFn: () => { throw new PromptContractError('config_error', 'no API key: set CONTRACT_API_KEY'); },
  });
  assert.equal(code, 2);
  assert.match(out, /no API key/);
});

test('runDraft: injected enhance drives the full loop and returns 0', async () => {
  let out = '';
  const output = new PassThrough();
  output.on('data', (d) => (out += String(d)));
  const input = new PassThrough();
  const done = runDraft({ hotkey: 'ctrl+k' }, {
    input,
    output,
    enhance: async (draft) => `enhanced<${draft.trim()}>`,
    copy: async () => true,
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  input.write('hi');
  for (let i = 0; i < 50 && !out.includes('hi'); i++) await sleep(20);
  input.write('\x0b');
  for (let i = 0; i < 100 && !out.includes('enhanced<hi>'); i++) await sleep(20);
  input.write('\r');
  for (let i = 0; i < 100 && !out.includes('copied to clipboard'); i++) await sleep(20);
  assert.match(out, /copied to clipboard/);
  input.end();
  assert.equal(await done, 0);
});

// ---------------------------------------------------------------------------
// Black-box: the real bin against the mock provider over piped stdin.

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'contract.js');
let mock, base;
before(async () => {
  mock = createMockServer({});
  const port = await mock.listen();
  base = `http://127.0.0.1:${port}`;
});
after(async () => { await mock.close(); });

test('contract draft black-box: hotkey enhances via the provider, Enter accepts, exit 0', async () => {
  const res = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      BIN, 'draft', '--hotkey', 'ctrl+k',
      '--base-url', `${base}/v1`, '--api-key', 'test-key-123', '--model', 'mock-model',
    ], { env: { ...process.env, CONTRACT_NO_CLIPBOARD: '1' } });
    child.stdin.on('error', () => {});
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    const fail = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`draft black-box timed out; stdout so far:\n${stdout}`));
    }, 30_000);
    const step = (chunk, expect) => {
      if (!stdout.includes(expect)) child.stdin.write(chunk);
      return stdout.includes(expect);
    };
    const tick = () => {
      if (child.killed || child.exitCode !== null) return; // never loop on a dead child
      step('hello world', 'hello world');
      step('\x0b', EN_RESULT.slice(0, 40)); // Ctrl+K -> provider-enhanced text lands in the line
      step('\r', 'clipboard unavailable');
      if (stdout.includes('clipboard unavailable')) {
        clearTimeout(fail);
        child.stdin.end();
        return;
      }
      setTimeout(tick, 50);
    };
    child.on('close', (code) => {
      clearTimeout(fail);
      resolve({ code: code ?? -1, stdout });
    });
    tick();
  }).catch((err) => ({ error: err.message }));

  assert.ok(!res.error, res.error);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /contract draft/);
  assert.match(res.stdout, /Ctrl\+K enhance/);
  assert.ok(res.stdout.includes(EN_RESULT.slice(0, 40)));
});

test('contract draft black-box: invalid --hotkey exits 2 with usage help', async () => {
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'draft', '--hotkey', 'ctrl+c'], {
      env: { ...process.env, CONTRACT_NO_CLIPBOARD: '1' },
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /reserved/);
});
