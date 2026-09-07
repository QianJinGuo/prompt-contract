import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMockServer, ZH_RESULT } from '../../../mock/server.js';

let mock, base;
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js');

before(async () => {
  mock = createMockServer({});
  const port = await mock.listen();
  base = `http://127.0.0.1:${port}`;
});

after(async () => { await mock.close(); });

function startServer() {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PB_PROVIDER: 'openai', PB_BASE_URL: `${base}/v1`, PB_API_KEY: 'test-key-123', PB_MODEL: 'mock-model' }
  });
  const pending = [];
  let buffer = '';
  const waiters = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buffer += d;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const w = waiters.shift();
      if (w) w(msg);
      else pending.push(msg);
    }
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const request = (obj) => new Promise((resolveReq) => {
    const waiter = (msg) => resolveReq(msg);
    if (pending.length) waiter(pending.shift()); else waiters.push(waiter);
    child.stdin.write(JSON.stringify(obj) + '\n');
  });
  const done = () => new Promise((r) => child.on('close', r));
  const kill = () => { child.stdin.end(); };
  return { child, request, done, kill, getStderr: () => stderr };
}

test('MCP: initialize → tools → tool call → prompts, full handshake', async () => {
  const s = startServer();
  try {
    const init = await s.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.result.serverInfo.name, 'prompt-boost');
    assert.ok(init.result.capabilities.tools);
    assert.ok(init.result.capabilities.prompts);

    const tools = await s.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(tools.result.tools.length, 1);
    assert.equal(tools.result.tools[0].name, 'enhance_prompt');
    assert.deepEqual(tools.result.tools[0].inputSchema.required, ['text']);

    const call = await s.request({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'enhance_prompt', arguments: { text: '帮我做一个展示我家狗的网站' } }
    });
    assert.equal(call.result.isError, undefined);
    assert.equal(call.result.content[0].text, ZH_RESULT);

    const callProfiled = await s.request({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'enhance_prompt', arguments: { text: 'A website for my dog', profile: 'writing', strength: 'polish' } }
    });
    assert.equal(callProfiled.result.isError, undefined);
    assert.ok(callProfiled.result.content[0].text.length > 0);

    const prompts = await s.request({ jsonrpc: '2.0', id: 5, method: 'prompts/list' });
    assert.deepEqual(prompts.result.prompts.map((p) => p.name), ['boost-coding-agent', 'boost-image-gen', 'boost-writing']);

    const get = await s.request({
      jsonrpc: '2.0', id: 6, method: 'prompts/get',
      params: { name: 'boost-writing', arguments: { text: '帮我写一封请假邮件' } }
    });
    const promptText = get.result.messages[0].content.text;
    assert.match(promptText, /USER INPUT:\s*\n+帮我写一封请假邮件/);
    assert.match(promptText, /HARD CONSTRAINTS:/);

    const unknown = await s.request({ jsonrpc: '2.0', id: 7, method: 'bogus/method' });
    assert.equal(unknown.error.code, -32601);

    const badTool = await s.request({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'enhance_prompt', arguments: { text: '' } }
    });
    assert.equal(badTool.result.isError, true);
    assert.match(badTool.result.content[0].text, /empty_input/);
  } finally {
    s.kill();
    await s.done();
  }
});

test('MCP: notification messages get no response frame', async () => {
  const s = startServer();
  try {
    child_notify(s);
    const res = await s.request({ jsonrpc: '2.0', id: 100, method: 'ping' });
    assert.deepEqual(res.result, {});
  } finally {
    s.kill();
    await s.done();
  }
});

test('MCP: zero-key startup — prompts work, tool calls report config_error honestly (R12 caveat fixed)', async () => {
  // strip every config source so nothing can satisfy the tool mode
  const cleanEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) if (k.startsWith('PB_')) delete cleanEnv[k];
  cleanEnv.PB_CONFIG = '/tmp/definitely-missing-pb-config.json';
  const child = spawn(process.execPath, [SERVER], { env: cleanEnv });
  const pending = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buffer += d;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) pending.push(JSON.parse(line));
    }
  });
  const request = (obj) => new Promise((resolveReq) => {
    const check = () => {
      if (pending.length) resolveReq(pending.shift());
      else setTimeout(check, 20);
    };
    child.stdin.write(JSON.stringify(obj) + '\n');
    check();
  });
  try {
    const init = await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(init.result.serverInfo.name, 'prompt-boost');

    const get = await request({
      jsonrpc: '2.0', id: 2, method: 'prompts/get',
      params: { name: 'boost-coding-agent', arguments: { text: '做个网站' } }
    });
    assert.match(get.result.messages[0].content.text, /USER INPUT:\s*\n+做个网站/);

    const call = await request({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'enhance_prompt', arguments: { text: '做个网站' } }
    });
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /config_error/);
  } finally {
    child.stdin.end();
    await new Promise((r) => child.on('close', r));
  }
});

function child_notify(s) {
  s.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
}
