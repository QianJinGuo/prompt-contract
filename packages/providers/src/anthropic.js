/**
 * Anthropic provider — native Messages API (SSE). The one protocol family the OpenAI-compatible
 * adapter cannot cover: different auth header (x-api-key), separate `system` parameter, and
 * content_block_delta events. Reasoning deltas (thinking_delta) are dropped at the transport
 * layer; any <think>…</think> that still lands inside text is stripped later by core/clean.js.
 */
import { PromptContractError } from '../../core/src/errors.js';
import { withTimeout } from './openai.js';

export const ANTHROPIC_VERSION = '2023-06-01';

export function createAnthropicProvider({ baseUrl = 'https://api.anthropic.com', apiKey = '', version = ANTHROPIC_VERSION, fetchImpl = globalThis.fetch } = {}) {
  const root = String(baseUrl).replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': version };
  return {
    name: 'anthropic',
    /** Best-effort connection open (PRD §7.6-1); /v1/models exists but a miss never blocks a request. */
    async warmup({ signal } = {}) {
      try { await fetchImpl(`${root}/v1/models`, { headers, signal }); } catch { /* best effort */ }
    },
    async complete({ system, user, model, signal, onDelta, maxTokens = 1024, timeoutMs = 30000, temperature = 0.7 }) {
      const { signal: fullSignal, cleanup } = withTimeout(signal, timeoutMs);
      let res;
      try {
        res = await fetchImpl(`${root}/v1/messages`, {
          method: 'POST',
          signal: fullSignal,
          headers,
          body: JSON.stringify({
            model,
            stream: true,
            // Anthropic requires max_tokens — pipeline derives it from the profile's maxChars.
            max_tokens: maxTokens,
            temperature,
            system,
            messages: [{ role: 'user', content: user }]
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
        throw new PromptContractError('provider_unavailable', `anthropic HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
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
            if (!data) continue;
            let json;
            try { json = JSON.parse(data); } catch { continue; }
            if (json.type === 'error') {
              throw new PromptContractError('provider_unavailable', `anthropic stream error: ${json.error?.message ?? 'unknown'}`);
            }
            // Only text deltas are answer content; thinking_delta / signature deltas are dropped here.
            if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta' && json.delta.text) {
              text += json.delta.text;
              if (onDelta) onDelta(json.delta.text);
            }
            if (json.type === 'message_stop') return { text };
          }
        }
      } finally {
        cleanup();
      }
      return { text };
    }
  };
}
