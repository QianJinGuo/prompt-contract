/**
 * OpenAI-compatible provider — the universal protocol (covers OpenAI, DeepSeek, Qwen, GLM, Moonshot,
 * OpenRouter, vLLM, LM Studio, Ollama's /v1 …). Single streaming POST, no handshake (PRD §7.6-4).
 */
import { PromptContractError } from '../../core/src/errors.js';

/** Combine caller signal + internal timeout. Caller abort must always stay effective (ADR-017). */
function withTimeout(signal, timeoutMs) {
  const timeoutCtrl = new AbortController();
  const timer = timeoutMs
    ? setTimeout(() => timeoutCtrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs)
    : null;
  let combined = timeoutCtrl.signal;
  if (signal) {
    if (typeof AbortSignal.any === 'function') {
      combined = AbortSignal.any([signal, timeoutCtrl.signal]);
    } else {
      signal.addEventListener('abort', () => timeoutCtrl.abort(signal.reason), { once: true });
    }
  }
  return { signal: combined, cleanup: () => { if (timer) clearTimeout(timer); } };
}

export function createOpenAIProvider({ baseUrl = 'https://api.openai.com/v1', apiKey = '', fetchImpl = globalThis.fetch } = {}) {
  const root = String(baseUrl).replace(/\/+$/, '');
  return {
    name: 'openai',
    /** Open one TLS/TCP connection early so the first real request pays no handshake (PRD §7.6-1). */
    async warmup({ signal } = {}) {
      try { await fetchImpl(`${root}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal }); } catch { /* best effort */ }
    },
    async complete({ system, user, model, signal, onDelta, maxTokens = 1024, timeoutMs = 30000, temperature = 0.7 }) {
      const { signal: fullSignal, cleanup } = withTimeout(signal, timeoutMs);
      let res;
      try {
        res = await fetchImpl(`${root}/chat/completions`, {
          method: 'POST',
          signal: fullSignal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            stream: true,
            max_tokens: maxTokens,
            temperature,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user }
            ]
          })
        });
      } catch (err) {
        cleanup();
        throw err; // pipeline normalizes AbortError / network errors
      }
      if (!res.ok) {
        cleanup();
        let detail = '';
        try { detail = (await res.text()).slice(0, 300); } catch { /* body unreadable */ }
        throw new PromptContractError('provider_unavailable', `provider HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
      }
      let text = '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let json;
            try { json = JSON.parse(data); } catch { continue; }
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) { text += delta; if (onDelta) onDelta(delta); }
          }
        }
      } finally {
        cleanup();
      }
      return { text };
    }
  };
}
