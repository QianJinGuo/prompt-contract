/**
 * Best-effort clipboard write for `contract draft`. The REPL never fails
 * because of the clipboard: candidates degrade in order and a missing or
 * failing tool simply reports false (docs/DRAFT.md).
 */
import { spawn } from 'node:child_process';

const DARWIN_TOOLS = [{ cmd: 'pbcopy', args: [] }];
const LINUX_TOOLS = [
  { cmd: 'wl-copy', args: [] },
  { cmd: 'xclip', args: ['-selection', 'clipboard'] },
];

export function makeSystemCopyFn(platform = process.platform) {
  const tools = platform === 'darwin' ? DARWIN_TOOLS : LINUX_TOOLS;
  return (text) => copyWithTools(text, tools);
}

/** Try each tool in order; true when one spawns and exits 0. */
export function copyWithTools(text, tools) {
  const [head, ...rest] = tools;
  if (!head) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(head.cmd, head.args, { stdio: ['pipe', 'ignore', 'ignore'] });
    let settled = false;
    const next = () => {
      if (settled) return;
      settled = true;
      resolve(copyWithTools(text, rest));
    };
    child.on('error', next);
    child.on('close', (code) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        resolve(true);
      } else {
        next();
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}
