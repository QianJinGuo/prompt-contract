import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMockServer, ZH_RESULT } from '../../../mock/server.js';

let mock, base, repoRoot;
const PB = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'pb.js');

before(async () => {
  mock = createMockServer({});
  const port = await mock.listen();
  base = `http://127.0.0.1:${port}`;
  repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
});

after(async () => { await mock.close(); });

function runPb(args, { env = {}, input } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [PB, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env }
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

const OPENAI_ENV = { PB_PROVIDER: 'openai', PB_BASE_URL: `${base}/v1`, PB_API_KEY: 'test-key-123', PB_MODEL: 'mock-model' };

test('e2e: pb "..." enhances via openai-compatible upstream and passes rule assertions', async () => {
  const { code, stdout, stderr } = await runPb(['--json', '--provider', 'openai', '--base-url', `${base}/v1`, '--api-key', 'test-key-123', '--model', 'mock-model', '帮我做一个展示我家狗的网站']);
  assert.equal(code, 0, stderr);
  const out = JSON.parse(stdout);
  assert.equal(out.original, '帮我做一个展示我家狗的网站');
  assert.equal(out.enhanced, ZH_RESULT);
  assert.equal(out.meta.profile, 'coding-agent');
  assert.equal(out.meta.model, 'mock-model');
  assert.equal(out.rules.pass, true, JSON.stringify(out.rules.results));
});

test('e2e: pb reads prompt from stdin (pipe mode)', async () => {
  const { code, stdout } = await runPb(
    ['--no-stream', '--provider', 'openai', '--base-url', `${base}/v1`, '--api-key', 'test-key-123', '--model', 'mock-model'],
    { input: '帮我做一个展示我家狗的网站' }
  );
  assert.equal(code, 0);
  assert.equal(stdout.trim(), ZH_RESULT);
});

test('pb profiles lists the three built-in profiles', async () => {
  const { code, stdout } = await runPb(['profiles']);
  assert.equal(code, 0);
  for (const name of ['coding-agent', 'writing', 'image-gen']) assert.match(stdout, new RegExp(name));
});

test('pb check exits 1 on a failing pair (gate mode) and 0 on a good pair', async () => {
  const bad = await runPb(['check', '--original', '做个博客', '--enhanced', '好的，以下是实现方案：先安装依赖。']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /FAIL/);
  const good = await runPb(['check', '--original', '帮我做一个展示我家狗的网站', '--enhanced', ZH_RESULT]);
  assert.equal(good.code, 0, good.stderr);
});

test('pb watch is gated by decision D7', async () => {
  const { code, stderr } = await runPb(['watch']);
  assert.equal(code, 2);
  assert.match(stderr, /D7/);
});

test('pb spike-0 exposes the macOS dry-run diagnostic', async () => {
  const { code, stdout } = await runPb(['spike-0', '--help']);
  assert.equal(code, 0);
  assert.match(stdout, /dry-run/);
  assert.match(stdout, /Chrome/);
  assert.match(stdout, /PyCharm/);
  assert.match(stdout, /iTerm/);
});

test('pb doctor reports provider problems honestly', async () => {
  const { code, stderr } = await runPb(['doctor', '--provider', 'openai', '--base-url', `${base}/v1`, '--api-key', 'wrong-key', '--model', 'mock-model']);
  assert.equal(code, 1);
  assert.match(stderr, /FAIL/);
});
