/**
 * Browser-safe public API of the engine. Node-only extras (fs profile loading, config resolution)
 * live in ./node.js so this file can be imported directly by the playground.
 */
export { CODES, PromptBoostError, normalizeError } from './errors.js';
export { detectScriptName } from './lang.js';
export { stripWrappingQuotes, stripFences, clampChars, postprocess } from './clean.js';
export { checkRules } from './rules.js';
export { parseProfile, parseYamlLite } from './profile.js';
export { enhance, assembleMessages, hardConstraints, STRENGTHS } from './pipeline.js';
