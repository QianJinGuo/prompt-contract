/**
 * PromptContract MCP server (PRD §6) — stdio, newline-delimited JSON-RPC 2.0.
 *
 * Two integration modes, deliberately asymmetric in their configuration needs:
 *  - tool  `enhance_prompt`: agent-invoked; the server calls the configured provider (BYOK via env/config).
 *  - prompt `contract-<profile>`: user-invoked slash command; the rewrite instruction is injected into the
 *    client's OWN model — this mode needs NO API key and NO provider config, so provider resolution is
 *    lazy: an unconfigured server starts fine and only tool calls report `config_error`.
 */
import { enhance, hardConstraints, STRENGTHS, PromptContractError, normalizeError } from '../../core/src/index.js';
import { loadProfiles, loadProfile, resolveConfig } from '../../core/src/node.js';
import { createOpenAIProvider } from '../../providers/src/openai.js';
import { createOllamaProvider } from '../../providers/src/ollama.js';

const SERVER_INFO = { name: 'prompt-contract', version: '0.1.0' };

export function createServer({ profiles, getRuntime }) {
  function promptTextFor(profile, text) {
    // Zero-key mode: hand the client's own model the same spec our engine would use.
    return [
      profile.body.trim(),
      hardConstraints({ maxChars: profile.maxChars, strength: 'standard' }),
      `STRENGTH MODE: ${STRENGTHS.standard}`,
      '',
      'USER INPUT:',
      text,
      '',
      'Rewrite the USER INPUT as specified and return only the enhanced prompt text.'
    ].join('\n\n');
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
      return {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: SERVER_INFO
      };
    }
    if (method === 'ping') return {};

    if (method === 'tools/list') {
      return {
        tools: [{
          name: 'enhance_prompt',
          description: 'Rewrite a vague user prompt into a clear, specific, executable prompt. Returns only the enhanced text. Requires a configured provider (CONTRACT_API_KEY/CONTRACT_PROVIDER or config file).',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The raw user prompt to enhance' },
              profile: { type: 'string', enum: profiles.map((p) => p.name), description: 'Scenario profile (default: coding-agent)' },
              strength: { type: 'string', enum: ['polish', 'standard', 'expand'], description: 'Enhancement strength (default: standard)' },
              context: { type: 'string', description: 'Optional background context (e.g. repo summary) assembled into the prompt' }
            },
            required: ['text']
          }
        }]
      };
    }

    if (method === 'tools/call') {
      if (params?.name !== 'enhance_prompt') {
        throw rpcError(id, -32602, `unknown tool "${params?.name}"`);
      }
      const args = params.arguments ?? {};
      try {
        const { config, provider } = getRuntime(); // lazy — a prompt-only server never pays this
        const profile = args.profile ? loadProfile(args.profile) : profiles.find((p) => p.name === 'coding-agent') ?? profiles[0];
        const res = await enhance(String(args.text ?? ''), {
          profile,
          provider,
          model: config.model,
          strength: args.strength,
          context: args.context,
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: res.text }] };
      } catch (err) {
        const e = normalizeError(err);
        return { content: [{ type: 'text', text: `prompt-contract error ${e.code}: ${e.message}` }], isError: true };
      }
    }

    if (method === 'prompts/list') {
      return {
        prompts: profiles.map((p) => ({
          name: `contract-${p.name}`,
          description: `Enhance a prompt with the "${p.name}" profile (uses this client's own model, no API key needed)`,
          arguments: [{ name: 'text', description: 'The raw prompt to enhance', required: true }]
        }))
      };
    }

    if (method === 'prompts/get') {
      const name = String(params?.name ?? '');
      const profile = profiles.find((p) => `contract-${p.name}` === name);
      if (!profile) throw rpcError(id, -32602, `unknown prompt "${name}"`);
      const text = String(params?.arguments?.text ?? '');
      if (!text.trim()) throw rpcError(id, -32602, 'argument "text" is required');
      return { description: `PromptContract · ${profile.name}`, messages: [{ role: 'user', content: { type: 'text', text: promptTextFor(profile, text) } }] };
    }

    throw rpcError(id, -32601, `method not found: ${method}`);
  }

  function rpcError(id, code, message) {
    const err = new Error(message);
    err.rpcCode = code;
    err.rpcId = id;
    return err;
  }

  return { handle, state: { profiles } };
}

/** Wire the server to stdin/stdout. One line = one JSON-RPC message. Never log prompt content. */
export async function serve({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, argv = [] } = {}) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const profiles = loadProfiles(flag('--profiles-dir'));

  // Provider/config is resolved lazily so the zero-key prompt mode truly needs zero configuration.
  let runtime = null;
  let startupError = null;
  function getRuntime() {
    if (runtime) return runtime;
    if (startupError) throw startupError;
    const config = resolveConfig({ provider: flag('--provider'), baseUrl: flag('--base-url'), apiKey: flag('--api-key'), model: flag('--model'), configPath: flag('--config') });
    const provider = config.provider === 'ollama'
      ? createOllamaProvider({ baseUrl: config.baseUrl })
      : createOpenAIProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey });
    provider.warmup({ model: config.model }).catch(() => {}); // §7.6-1: prewarm, best effort
    runtime = { config, provider };
    return runtime;
  }
  try {
    getRuntime();
  } catch (err) {
    startupError = err;
    stderr.write(`[prompt-contract] tool mode unavailable (${err.code ?? 'error'}: ${err.message}) — prompts (zero-key) remain available\n`);
  }

  const server = createServer({ profiles, getRuntime });
  stderr.write(`[prompt-contract] mcp server ready (tool mode: ${runtime ? `provider=${runtime.config.provider}` : 'unconfigured'}, profiles=${profiles.length})\n`);

  let buffer = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      if (msg.id === undefined || msg.id === null) continue; // notification — no response
      server.handle(msg)
        .then((result) => write({ jsonrpc: '2.0', id: msg.id, result }))
        .catch((err) => {
          const code = err.rpcCode ?? -32603;
          write({ jsonrpc: '2.0', id: err.rpcId ?? msg.id, error: { code, message: err.message } });
        });
    }
  });
  stdin.on('end', () => process.exit(0));

  function write(obj) {
    stdout.write(JSON.stringify(obj) + '\n');
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  serve({ argv: process.argv.slice(2) }).catch((err) => {
    if (err instanceof PromptContractError) { process.stderr.write(`[prompt-contract] ${err.code}: ${err.message}\n`); process.exit(1); }
    throw err;
  });
}
