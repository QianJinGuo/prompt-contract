#!/usr/bin/env node
/**
 * Reproducible README asset capture — no GUI, no foreground fight.
 * Ensures the static server + a mock upstream are running, then renders the playground's
 * ?demo=1 mode in headless Chrome (virtual time lets the streaming demo complete) and
 * saves the hero PNG. Deterministic: same input, same mock, same pixels.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createMockServer } from '../mock/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT_STATIC = 8123;
const PORT_MOCK = 8794;
const OUT = resolve(root, 'docs/assets/hero-playground.png');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
];
const chrome = CHROME_CANDIDATES.find((c) => existsSync(c));
if (!chrome) { console.error('no Chrome/Chromium/Edge found'); process.exit(1); }

async function waitReachable(url, ms) {
  for (let end = Date.now() + ms; Date.now() < end;) {
    try { await fetch(url); return true; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  return false;
}

const staticServed = await waitReachable(`http://127.0.0.1:${PORT_STATIC}/`, 400);
let staticProc = null;
if (!staticServed) {
  staticProc = spawn(process.execPath, [resolve(root, 'packages/playground/serve.js')], { stdio: 'ignore' });
  if (!(await waitReachable(`http://127.0.0.1:${PORT_STATIC}/`, 4000))) {
    console.error('could not start static server'); process.exit(1);
  }
}

const mock = createMockServer({ port: PORT_MOCK });
const mockPort = await mock.listen();
console.log(`mock on :${mockPort}`);

try {
  const url = `http://127.0.0.1:${PORT_STATIC}/packages/playground/index.html?demo=1&port=${mockPort}`;
  console.log('capturing', url);
  const profileDir = mkdtempSync(join(tmpdir(), 'pb-chrome-')); // fresh dir each run — a stale SingletonLock makes Chrome hang forever
  if (existsSync(OUT)) rmSync(OUT); // never mistake a stale screenshot for a fresh capture
  // spawn detached with stdio ignored: Chrome helper processes inherit pipes and never close
  // them, which would make a synchronous wait hang forever even after the timeout fires.
  const startedAt = Date.now();
  const child = spawn(chrome, [
    '--headless=old', // 'new' headless crashes on this macOS (CVDisplayLink); legacy mode is reliable
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1420,780',
    '--virtual-time-budget=12000',
    '--no-first-run',
    `--user-data-dir=${profileDir}`,
    `--screenshot=${OUT}`,
    url
  ], { stdio: 'ignore', detached: true });

  const deadline = startedAt + 45000;
  for (;;) {
    if (existsSync(OUT) && statSync(OUT).mtimeMs > startedAt) {
      const size = statSync(OUT).size;
      await new Promise((r) => setTimeout(r, 1200)); // let Chrome finish writing
      if (statSync(OUT).size === size && size > 1024) break;
    }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error('capture timed out — no fresh screenshot was produced'); }
    await new Promise((r) => setTimeout(r, 400));
  }
  child.kill('SIGKILL');
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* helpers may still be writing; harmless */ }
  console.log(`saved ${OUT}`);
  process.exit(0); // undici keep-alive sockets would otherwise hold the event loop open
} finally {
  await mock.close();
  if (staticProc) staticProc.kill();
}
