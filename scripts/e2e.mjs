#!/usr/bin/env node
/**
 * End-to-end smoke for the interactive surfaces under a REAL pseudo-TTY,
 * driven by the system `expect` (Tcl). Unlike the piped-stdin unit tests,
 * expect allocates a pty, so readline sees isTTY=true, enables raw mode, and
 * parses keystrokes exactly as in a user terminal.
 *
 * Covered here:
 *   1. `contract draft` full loop (default Alt+E and --hotkey ctrl+k) against
 *      the local mock provider, offline.
 *   2. `contract watch --trigger stdin` startup + clean exit. The capture/
 *      paste cycle itself stays unit-level (fakes): driving it E2E would
 *      synthesize ⌘C/⌘V into whatever app is focused. This scenario asserts
 *      the fail-closed startup path instead: either the resident banner plus
 *      a clean "q" exit, or the documented Accessibility/clipboard refusal.
 *
 * Usage: npm run test:e2e   (skips gracefully when expect is unavailable)
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockServer, EN_RESULT } from '../mock/server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(repoRoot, 'packages', 'cli', 'bin', 'contract.js');
const expectBin = process.platform === 'darwin' ? '/usr/bin/expect' : 'expect';

const tclEscape = (s) =>
  s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\[/g, '\\[').replace(/\$/g, '\\$');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runExpect(scriptText, env = {}) {
  const scriptPath = path.join(os.tmpdir(), `prompt-contract-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.tcl`);
  fs.writeFileSync(scriptPath, scriptText);
  return new Promise((resolve) => {
    const child = spawn(expectBin, ['-f', scriptPath], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
    });
    child.stdin.on('error', () => {});
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    const kill = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', (err) => {
      clearTimeout(kill);
      resolve({ code: err.code === 'ENOENT' ? 'SKIP' : -1, stdout: String(err.message) });
    });
    child.on('close', (code) => {
      clearTimeout(kill);
      resolve({ code: code ?? -1, stdout });
    });
  }).then((res) => {
    fs.unlinkSync(scriptPath);
    return res;
  });
}

const WARM_ENV = {
  CONTRACT_NO_CLIPBOARD: '1',
  CONTRACT_PROVIDER: 'openai',
  CONTRACT_API_KEY: 'test-key-123',
  CONTRACT_MODEL: 'mock-model',
};

async function draftScenario({ name, args, banner, enhanceKeysTcl, mockBase }) {
  const script = `
set timeout 30
log_user 1
spawn /usr/bin/env node ${tclEscape(BIN)} draft ${args.map(tclEscape).join(' ')}
expect "${tclEscape(banner)}" {} timeout { puts stderr "\\n\\[e2e\\] banner timeout"; exit 3 }
send "hello world"
expect "hello world" {} timeout { puts stderr "\\n\\[e2e\\] echo timeout"; exit 3 }
send "${enhanceKeysTcl}"
expect "${tclEscape(EN_RESULT.slice(0, 40))}" {} timeout { puts stderr "\\n\\[e2e\\] enhance timeout"; exit 3 }
send "\\r"
expect "clipboard unavailable" {} timeout { puts stderr "\\n\\[e2e\\] accept timeout"; exit 3 }
send "\\x03"
expect eof
catch wait result
exit [lindex $result 3]
`;
  const { code, stdout } = await runExpect(script, {
    ...WARM_ENV,
    CONTRACT_BASE_URL: `${mockBase}/v1`,
  });
  return [
    [`${name}: banner shows the configured hotkey`, stdout.includes(banner)],
    [`${name}: hotkey enhanced the draft via the provider`, stdout.includes(EN_RESULT.slice(0, 40))],
    [`${name}: Enter accepted (clipboard degraded)`, stdout.includes('clipboard unavailable')],
    [`${name}: Ctrl+C exited 0 (got ${code})`, code === 0],
  ];
}

async function watchStdinScenario() {
  // Never triggers a capture: we only start the resident loop and quit it.
  const script = `
set timeout 30
log_user 1
spawn /usr/bin/env node ${tclEscape(BIN)} watch --trigger stdin --dry-run --force
expect "prompt-contract watch resident" { send "q\\r" } "startup probe failed" { exit 2 } timeout { puts stderr "\\n\\[e2e\\] watch startup timeout"; exit 3 } eof { exit 4 }
expect "watch: stopped" {} timeout { puts stderr "\\n\\[e2e\\] watch stop timeout"; exit 5 }
expect eof
catch wait result
exit [lindex $result 3]
`;
  const { code, stdout } = await runExpect(script, WARM_ENV);
  const residentOk = stdout.includes('prompt-contract watch resident')
    && stdout.includes('watch: stopped')
    && code === 0;
  const refusedOk = stdout.includes('startup probe failed') && code === 2;
  return [
    [`watch stdin: resident+clean exit OR fail-closed refusal (rc=${code})`, residentOk || refusedOk],
  ];
}

if (process.platform === 'darwin' && !fs.existsSync(expectBin)) {
  console.log('SKIP  e2e: no /usr/bin/expect on this machine');
  process.exit(0);
}

const mock = createMockServer({});
const mockBase = `http://127.0.0.1:${await mock.listen()}`;
try {
  const checks = [
    ...(await draftScenario({ name: 'draft default Alt+E', args: [], banner: 'type a prompt, Alt+E enhance', enhanceKeysTcl: '\\033e', mockBase })),
    ...(await draftScenario({ name: 'draft --hotkey ctrl+k', args: ['--hotkey', 'ctrl+k'], banner: 'type a prompt, Ctrl+K enhance', enhanceKeysTcl: '\\x0b', mockBase })),
    ...(await watchStdinScenario()),
  ];
  let allPass = true;
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
    allPass = allPass && pass;
  }
  console.log(allPass ? 'test:e2e PASS' : 'test:e2e FAIL');
  process.exit(allPass ? 0 : 1);
} finally {
  await mock.close();
}
