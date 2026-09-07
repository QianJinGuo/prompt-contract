#!/usr/bin/env node
/**
 * Assemble the npm package into build/npm without a bundler.
 * Preserves the monorepo relative-import layout so the published package runs
 * exactly like the repo (zero-dependency guarantee carries over verbatim):
 *
 *   build/npm/
 *     package.json            (name: @qianjinguo/prompt-boost, bin x3)
 *     packages/cli/**         (bin/pb.js — imports ../../core/src/*)
 *     packages/core/src/**
 *     packages/mcp-server/**  (bin + src — imports ../../core/src/*)
 *     packages/providers/src/**
 *     profiles/*.md           (found by the upward directory walk in core/src/node.js)
 *     README.md README.en.md LICENSE
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
  // Scoped name: npm's typosquat policy blocks the unscoped "prompt-boost"
  // (too similar to the existing "promptboost" package), and a scope matching
  // the npm username is exempt from that check.
  name: '@qianjinguo/prompt-boost',
  version: '0.1.1',
  publishConfig: { access: 'public' },
  description: 'One-key prompt enhancement — turn vague ideas into structured task specs anywhere you type to an AI. CLI + MCP server. Zero dependencies, BYOK, offline-capable (Ollama).',
  license: 'Apache-2.0',
  type: 'module',
  engines: { node: '>=20' },
  bin: {
    'prompt-boost': './packages/cli/bin/pb.js',
    pb: './packages/cli/bin/pb.js',
    'prompt-boost-mcp': './packages/mcp-server/bin/prompt-boost-mcp.js'
  },
  keywords: [
    'prompt', 'prompt-engineering', 'llm', 'cli', 'mcp', 'model-context-protocol',
    'ai-agents', 'ollama', 'openai', 'developer-tools'
  ],
  repository: { type: 'git', url: 'git+https://github.com/QianJinGuo/prompt-boost.git' },
  homepage: 'https://github.com/QianJinGuo/prompt-boost#readme',
  bugs: 'https://github.com/QianJinGuo/prompt-boost/issues',
  files: ['packages/', 'profiles/', 'README.md', 'README.en.md', 'LICENSE']
};

writeFileSync(resolve(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
process.stdout.write(`assembled ${out}\n`);
