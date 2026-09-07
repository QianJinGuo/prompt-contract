/**
 * Ollama provider — native /api/chat (ndjson streaming).
 * Key detail (PRD §7.6-1 / risk R9): every request carries `keep_alive` so the small model stays
 * resident in memory — a cold model load takes seconds and would kill the hotkey experience.
 */
import { PromptBoostError } from '../../core/src/errors.js';

export function createOllamaProvider({ baseUrl = 'http://localhost:11434', keepAlive = '60m', fetchImpl = globalThis.fetch } = {}) {
  const root = String(baseUrl).replace(/\/+$/, '');
  return {
    name: 'ollama',
    keepAlive,
    /** Preload the model into memory so the first hotkey press doesn't pay the cold-load cost. */
    async warmup({ model, signal } = {}) {
      if (!model) return;
      try {
        await fetchImpl(`${root}/api/generate`, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, prompt: '', keep_alive: keepAlive })
        });
      } catch { /* best effort — doctor/doctor-report surfaces connectivity */ }
    },
    async complete({ system, user, model, signal, onDelta, maxTokens = 1024, timeoutMs = 30000, temperature = 0.7 }) {
      if (!model) throw new PromptBoostError('config_error', 'ollama provider requires a model');
      let timer = null;
      let timeoutCtrl = null;
      let fullSignal = signal;
      if (!signal && timeoutMs) {
        timeoutCtrl = new AbortController();
        timer = setTimeout(() => timeoutCtrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
        fullSignal = timeoutCtrl.signal;
      }
      let res;
      try {
        res = await fetchImpl(`${root}/api/chat`, {
          method: 'POST',
          signal: fullSignal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: true,
            keep_alive: keepAlive,
            options: { num_predict: maxTokens, temperature },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user }
            ]
          })
        });
      } catch (err) {
        if (timer) clearTimeout(timer);
        throw err;
      }
      if (!res.ok) {
        if (timer) clearTimeout(timer);
        let detail = '';
        try { detail = (await res.text()).slice(0, 300); } catch { /* body unreadable */ }
        throw new PromptBoostError('provider_unavailable', `ollama HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
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
            if (!line) continue;
            let json;
            try { json = JSON.parse(line); } catch { continue; }
            const delta = json.message?.content;
            if (delta) { text += delta; if (onDelta) onDelta(delta); }
            if (json.done) return { text };
          }
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
      return { text };
    }
  };
}
