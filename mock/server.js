/**
 * Local mock of an OpenAI-compatible + Ollama upstream.
 * Used by the whole test suite (deterministic, no network) and by `npm run demo`.
 * Stream pacing is throttled so client-side streaming/abort behavior is exercised for real.
 */
import { createServer } from 'node:http';

export const EN_RESULT = 'Design a small responsive website that showcases a single pet: a photo gallery, a short biography covering breed, age, and temperament, and an update feed for stories. Include a simple contact section and keep navigation to one level. Deliver as static pages with no build step, accessible on both desktop and mobile.';
export const ZH_RESULT = '请围绕这段代码输出一份结构化说明：先概述整体职责与适用场景，再按执行顺序分点列出关键逻辑，标注每一步的输入输出；随后指出边界条件、异常路径与需要注意的性能点。说明须沿用代码中的原有术语，不引入未出现的概念，总长度不超过八百字。';

function detectZh(text) { return /[\u4e00-\u9fff]/.test(text); }
function pickResult(userText) { return detectZh(userText) ? ZH_RESULT : EN_RESULT; }

function extractUserInput(messages) {
  const last = messages?.[messages.length - 1];
  const content = last?.content ?? '';
  const m = content.match(/USER INPUT:\s*\n([\s\S]*)/);
  return m ? m[1].trim() : content;
}

export function createMockServer({ port = 0 } = {}) {
  const state = {
    requests: 0,
    lastChatBody: null,
    lastGenerateBody: null,
    lastMessagesBody: null,
    aborts: 0
  };

  const server = createServer((req, res) => {
    // CORS: the playground calls this mock directly from the browser (cross-origin on purpose —
    // same BYOK-direct architecture as real providers). Preflight must pass for POST + headers.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      state.requests++;
      const url = req.url ?? '';

      if (req.method === 'GET' && (url === '/v1/models' || url === '/api/tags')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
        return;
      }

      if (req.method === 'POST' && url === '/v1/chat/completions') {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        if ((req.headers.authorization ?? '') !== 'Bearer test-key-123') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'bad key' } }));
          return;
        }
        const full = pickResult(extractUserInput(parsed.messages));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunks = full.match(/[\s\S]{1,16}/g) ?? [];
        let i = 0;
        // NOTE: no req.on('close') here — on Node ≥18 it fires as soon as the request body is
        // consumed, which would cancel the stream before the first chunk. Client aborts surface
        // as res.destroyed inside the interval instead.
        const timer = setInterval(() => {
          if (res.destroyed) { state.aborts++; clearInterval(timer); return; }
          if (i >= chunks.length) {
            clearInterval(timer);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          const payload = { choices: [{ delta: { content: chunks[i++] } }] };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }, 8);
        return;
      }

      // Anthropic Messages protocol: different auth header, system param, and event shapes.
      // A thinking_delta is emitted on purpose so provider tests can prove reasoning is dropped.
      if (req.method === 'POST' && url === '/v1/messages') {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        state.lastMessagesBody = parsed;
        if ((req.headers['x-api-key'] ?? '') !== 'test-key-123') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { message: 'bad key' } }));
          return;
        }
        const full = pickResult(extractUserInput(parsed.messages));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"internal reasoning must never surface"}}\n\n');
        const chunks = full.match(/[\s\S]{1,16}/g) ?? [];
        let i = 0;
        const timer = setInterval(() => {
          if (res.destroyed) { state.aborts++; clearInterval(timer); return; }
          if (i >= chunks.length) {
            clearInterval(timer);
            res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
            res.end();
            return;
          }
          const payload = { type: 'content_block_delta', delta: { type: 'text_delta', text: chunks[i++] } };
          res.write(`event: content_block_delta\ndata: ${JSON.stringify(payload)}\n\n`);
        }, 8);
        return;
      }

      if (req.method === 'POST' && url === '/api/chat') {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        state.lastChatBody = parsed;
        const full = pickResult(extractUserInput(parsed.messages));
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const chunks = full.match(/[\s\S]{1,16}/g) ?? [];
        let i = 0;
        const timer = setInterval(() => {
          if (res.destroyed) { state.aborts++; clearInterval(timer); return; }
          if (i >= chunks.length) {
            clearInterval(timer);
            res.write(`${JSON.stringify({ done: true })}\n`);
            res.end();
            return;
          }
          res.write(`${JSON.stringify({ message: { content: chunks[i++] }, done: false })}\n`);
        }, 8);
        return;
      }

      if (req.method === 'POST' && url === '/api/generate') {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        state.lastGenerateBody = parsed;
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.end(`${JSON.stringify({ done: true })}\n`);
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  return {
    server,
    state,
    listen: () => new Promise((resolveListen) => {
      server.listen(port, '127.0.0.1', () => resolveListen(server.address().port));
    }),
    close: () => new Promise((r) => server.close(r))
  };
}

if (process.argv[1]?.endsWith('mock/server.js')) {
  const port = parseInt(process.env.MOCK_PORT ?? '8787', 10);
  const m = createMockServer({ port });
  m.listen().then((p) => {
    process.stdout.write(`mock upstream listening on http://127.0.0.1:${p}\n`);
    process.stdout.write('  openai-compatible: POST /v1/chat/completions (key: test-key-123)\n');
    process.stdout.write('  anthropic:         POST /v1/messages (x-api-key: test-key-123)\n');
    process.stdout.write('  ollama:            POST /api/chat\n');
  });
}
