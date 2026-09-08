#!/usr/bin/env node
/**
 * Assemble the npm package into build/npm without a bundler.
 * Preserves the monorepo relative-import layout so the published package runs
 * exactly like the repo (zero-dependency guarantee carries over verbatim):
 *
 *   build/npm/
 *     package.json            (name: @qianjinguo/prompt-contract, bin x3)
 *     packages/cli/**         (bin/contract.js — imports ../../core/src/*)
 *     packages/core/src/**
 *     packages/mcp-server/**  (bin + src — imports ../../core/src/*)
 *     packages/providers/src/**
 *     profiles/*.md           (found by the upward directory walk in core/src/node.js)
 *     README.md README.zh-CN.md LICENSE
 */
import { rmSync, mkdirSync, cpSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'build/npm');

if (existsSync(out)) rmSync(out, { recursive: true });
mkdirSync(out, { recursive: true });

for (const src of [
  'packages/cli/bin',
  'packages/cli/src',
  'packages/cli/package.json',
  'packages/core/src',
  'packages/mcp-server/bin',
  'packages/mcp-server/src',
  'packages/providers/src',
  'profiles',
  'README.md',
  'README.zh-CN.md',
  'LICENSE'
]) {
  cpSync(resolve(root, src), resolve(out, src), { recursive: true });
}

const pkg = {
  // Scoped name: npm blocks unscoped names here — "prompt-boost" via the
  // typosquat policy (too similar to the existing "promptboost" package) and
  // "prompt-contract" because another publisher already owns it. A scope
  // matching the npm username is exempt from the similarity check, and the
  // "prompt-contract" bin key keeps `npx @qianjinguo/prompt-contract` working.
  name: '@qianjinguo/prompt-contract',
  version: '0.2.0',
  publishConfig: { access: 'public' },
  description: 'One-key prompt enhancement — turn vague ideas into structured task specs anywhere you type to an AI. CLI + MCP server. Zero dependencies, BYOK, offline-capable (Ollama).',
  license: 'Apache-2.0',
  type: 'module',
  engines: { node: '>=20' },
  bin: {
    'prompt-contract': './packages/cli/bin/contract.js',
    contract: './packages/cli/bin/contract.js',
    'prompt-contract-mcp': './packages/mcp-server/bin/prompt-contract-mcp.js'
  },
  keywords: [
    'prompt', 'prompt-engineering', 'llm', 'cli', 'mcp', 'model-context-protocol',
    'ai-agents', 'ollama', 'openai', 'developer-tools'
  ],
  repository: { type: 'git', url: 'git+https://github.com/QianJinGuo/prompt-contract.git' },
  homepage: 'https://github.com/QianJinGuo/prompt-contract#readme',
  bugs: 'https://github.com/QianJinGuo/prompt-contract/issues',
  files: ['packages/', 'profiles/', 'README.md', 'README.zh-CN.md', 'LICENSE']
};

writeFileSync(resolve(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
process.stdout.write(`assembled ${out}\n`);
