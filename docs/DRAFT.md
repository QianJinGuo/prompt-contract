# contract draft — interactive prompt drafting

`draft` is a terminal line where you rough out a prompt and let the model
rewrite it in place. It complements [`watch`](WATCH.md): watch enhances text
you selected in *another* app; draft is where you type from scratch.

```bash
node packages/cli/bin/contract.js draft                # default hotkey: alt+e
node packages/cli/bin/contract.js draft --hotkey ctrl+k
```

## The loop

```text
contract draft — type a prompt, Alt+E enhance, Enter accept, Ctrl+C exit
▍ build a website for my dog_
```

1. Type a rough prompt.
2. Press the enhance hotkey → the line is rewritten in place (multi-line
   replies are folded onto the line). Keep editing, or press the hotkey again.
3. Enter accepts: the prompt is printed to stdout and copied to the
   clipboard — paste it into any coding agent.
4. Ctrl+C / Ctrl+D exit cleanly (code 0).

Everything one-shot mode offers applies here too: `--profile`, `--strength`,
`--context`, `--max-chars`, `--timeout`, provider selection via
`--provider/--base-url/--api-key/--model` (or `CONTRACT_*` env /
`~/.prompt-contract/config.json`).

## Hotkey rules

- `MOD+KEY` with modifiers `ctrl`/`control`, `alt`/`option`, `shift` and a
  key `a-z` or `0-9`; at least one of ctrl/alt is required — a bare key or
  shift-only combo would fire on normal typing.
- `cmd`/`⌘` combos are rejected: they never reach terminal stdin.
- `ctrl+c` and `ctrl+d` stay reserved for exit. Invalid specs exit 2 with a
  fix hint before any provider setup.

## Clipboard

On Enter the accepted prompt is copied best-effort: `pbcopy` on macOS,
`wl-copy` then `xclip` on Linux. When no tool works, a notice is printed and
the session continues — the prompt is always on stdout. Set
`CONTRACT_NO_CLIPBOARD=1` to skip the clipboard entirely (CI, tests).

## Platform support

Pure readline — works on macOS and Linux with no Accessibility permission
and no helper binary. This is the cross-platform counterpart to
[`watch`](WATCH.md), which is macOS-only by design.

## Testing

- Unit + black-box piped-stdin tests: `packages/cli/test/draft.test.js`,
  `packages/cli/test/clipboard.test.js` (offline via `mock/server.js`).
- Real-terminal end-to-end: `npm run test:e2e` (`scripts/e2e.mjs`) drives the
  built CLI through a pseudo-TTY via the system `expect`, covering raw mode,
  real key delivery, and exit codes — the same harness also asserts the
  `watch --trigger stdin` startup and fail-closed paths.
