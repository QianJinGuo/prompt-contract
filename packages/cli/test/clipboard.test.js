import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyWithTools, makeSystemCopyFn } from '../src/clipboard.js';

/** A "tool" that always exits 0: the node binary itself. */
const okTool = () => ({ cmd: process.execPath, args: ['-e', 'process.stdin.resume(); process.exit(0)'] });
const failTool = () => ({ cmd: process.execPath, args: ['-e', 'process.exit(1)'] });
const missingTool = () => ({ cmd: 'contract-missing-tool-xyz', args: [] });

test('copyWithTools succeeds with the first working tool', async () => {
  assert.equal(await copyWithTools('hello', [okTool()]), true);
});

test('copyWithTools falls through failures to a working tool', async () => {
  assert.equal(await copyWithTools('hello', [missingTool(), failTool(), okTool()]), true);
});

test('copyWithTools reports false when every tool fails', async () => {
  assert.equal(await copyWithTools('hello', [missingTool(), failTool()]), false);
  assert.equal(await copyWithTools('hello', []), false);
});

test('makeSystemCopyFn picks pbcopy on darwin and degrades elsewhere without throwing', async () => {
  assert.equal(typeof makeSystemCopyFn('darwin'), 'function');
  assert.equal(await makeSystemCopyFn('plan9')('hello'), false); // no wl-copy/xclip -> degrade, not throw
});
