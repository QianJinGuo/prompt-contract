/** Structured error codes — stable public contract across all shells (CLI/MCP/playground). PRD §1.2/§5.2. */
export const CODES = {
  EMPTY_INPUT: 'empty_input',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  LLM_ERROR: 'llm_error',
  ABORTED: 'aborted',
  CONFIG: 'config_error',
  PROFILE_NOT_FOUND: 'profile_not_found'
};

export class PromptContractError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message || code, { cause });
    this.name = 'PromptContractError';
    this.code = code;
  }
}

/** Normalize any thrown value into a PromptContractError with a stable code (ADR-017 semantics: abort is fast, result is dropped). */
export function normalizeError(err) {
  if (err instanceof PromptContractError) return err;
  if (err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR')) {
    return new PromptContractError(CODES.ABORTED, 'aborted by caller', { cause: err });
  }
  return new PromptContractError(CODES.PROVIDER_UNAVAILABLE, err?.message || 'unexpected error', { cause: err });
}
