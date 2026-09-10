# Watch: resident hotkey mode (`prompt-contract watch`)

`prompt-contract watch` is the Snipaste-style resident mode (PRD §7): you select text anywhere
on macOS, press the hotkey, and the selected prompt is replaced with its enhanced
version. It reuses the same engine as the CLI — profile + hard constraints +
one streaming LLM call — and the same capture/clipboard machinery that
`prompt-contract spike-0` measures.

## Run it

```bash
# 1. Gather capture-safety evidence first (decision D7 — one-time, macOS)
node packages/cli/bin/contract.js spike-0 --json \
  --output ~/.cache/prompt-contract/spike-0.json

# 2. Go resident
node packages/cli/bin/contract.js watch \
  --report ~/.cache/prompt-contract/spike-0.json \
  --provider anthropic   # or openai, ollama (local, no key), or presets: deepseek/qwen/glm/moonshot/groq/openrouter/lmstudio
```

Then: focus any app, select a rough prompt, press **⌥B**. The selection is
captured (⌘C with clipboard backup), enhanced by your model, re-validated
against the capture-time focus identity, and pasted back (⌘V) over the
selection. Your original clipboard content is restored afterwards.

### The evidence gate (decision D7)

Watch pastes over your text, so it refuses to start without measured evidence:

- `--report <path>` — a passing `prompt-contract spike-0` compatibility report
  (`schemaVersion: prompt-contract/spike-0.v1`, `decision.pass: true`), or
- `--force` — explicit override if you accept the risk without evidence.

The gate is one-directional: a Spike-0 report never unlocks anything by itself,
and watch never runs the diagnostic for you.

## What a cycle does

1. **Capture** — snapshot the clipboard (text-only pasteboards only), record the
   foreground/focus identity, send ⌘C, read the selection, restore the clipboard.
   With no selection, it falls back to the current clipboard text; with neither,
   it notifies and waits.
2. **Enhance** — one stateless LLM call with the configured profile and strength
   (output clamped by the profile's `maxChars`).
3. **Re-validate focus** — the foreground/focus identity must still match capture
   time. If you switched apps while the model was thinking, watch aborts with a
   notification instead of pasting into the wrong window (fail closed).
4. **Paste back** — write the enhanced text to the clipboard, send ⌘V, wait
   `--paste-delay-ms` (default 1000), then restore whatever was on the clipboard
   before the paste. If the clipboard held non-text content that cannot be
   preserved, watch says so instead of failing silently. The delay is a
   measured compromise, not a guarantee: System Events delivers keystrokes
   asynchronously, and on a live TextEdit round-trip a 150–500ms window let the
   restore beat the app's paste read (the document then received the *restored*
   content), while 1000ms+ passed. The window cuts both ways — a manual ⌘C
   inside it would be clobbered by the restore — so raise `--paste-delay-ms`
   for slow apps and lower it if you copy frequently mid-window. The PRD's
   floating confirmation window (not in this version) is the design that
   removes the race entirely.

`--dry-run` runs steps 1–2 and prints the enhanced text without ever issuing ⌘V.

## Hotkeys and triggers

The trigger hotkey is yours to define. Precedence: `--hotkey` flag > the
`"hotkey"` field in `~/.prompt-contract/config.json` > built-in default `alt+b`:

```json
{ "provider": "openai", "baseUrl": "…", "apiKey": "…", "model": "…", "hotkey": "ctrl+alt+b" }
```

- Modifiers and their Mac keys: `ctrl` = ⌃ Control, `alt`/`option` = ⌥ Option,
  `cmd` = ⌘ Command, `shift` = ⇧ Shift. So `"ctrl+alt+b"` means hold ⌃⌥ and
  press B — the startup banner echoes it back as `⌃⌥B  [ctrl+alt+b]`. Keys:
  a–z, 0–9, `space`, `return`, `tab`, `escape`, `delete`, `f1`–`f12`, and
  punctuation. At least one modifier is required.
- **Pick a combo you never type.** A registered hotkey is consumed system-wide:
  with the default `alt+b`, pressing ⌥B no longer types "∫" — watch fires
  instead. If you use ⌥-combos for characters, or your editor/IDE binds
  ⌥B/⌘B, choose something like `ctrl+alt+b` or `cmd+shift+b` in the config
  file so the resident mode never surprises you. An invalid spec fails fast at
  startup with a fix-it message.
- **⌘C is not the trigger.** Everyday copying never invokes watch; ⌘C is only
  sent synthetically *after* you deliberately press the trigger, and the
  original clipboard is restored right afterwards.
- `--trigger stdin` — portable fallback: each Enter fires a cycle, `q` quits.
  No global hotkey needed; useful over SSH or for manual testing.

The global hotkey is registered by a small Swift helper (Carbon
`RegisterEventHotKey`) that pb compiles on first run from source embedded in
`packages/cli/src/watch.js` into `~/.cache/prompt-contract/` (override with
`CONTRACT_CACHE_DIR`). Hotkey registration itself needs no extra permission; the
compiled binary is reproducible from the audited source file. Compiling needs
the Xcode Command Line Tools (`xcode-select --install`).

## macOS permissions

- **Accessibility** (System Settings → Privacy & Security → Accessibility) must
  be granted to the terminal/launcher that starts `prompt-contract watch` — the same
  requirement as `prompt-contract spike-0`, needed for the ⌘C/⌘V keystrokes and the
  `AXFocusedUIElement` queries.
- macOS may also ask to allow the terminal to control **System Events** under
  Privacy & Security → Automation.
- A startup probe verifies clipboard access and the focus query before watch
  goes resident; on failure it exits with the specific permission guidance.

## Honest limits

- **Paste is destructive.** ⌘V replaces the selected text, and ⌘Z behavior
  varies by app (contenteditable, React controlled components) — it is not a
  product guarantee. The focus re-validation is the safety mechanism; treat it
  as necessary, not sufficient. The PRD's floating confirmation window (§7.3)
  is the planned stronger guard and is **not** part of this version.
- Also not in this version: menu bar icon/tray, launchd auto-start, code
  signing/notarization (PRD M0.5 full scope). `prompt-contract watch` is a foreground
  terminal process; Ctrl+C quits.
- macOS only (like Spike-0). `--trigger stdin` works on any platform for
  testing, but capture/paste still needs macOS.
- Only plain-text selections and clipboards are handled; rich pasteboards fail
  closed before any keystroke is sent.
- Latency is dominated by model TTFT. Watch warms the provider connection at
  startup and keeps the hotkey path initialization-free (PRD §7.6), but the
  first enhance on a cold local Ollama model still takes seconds — keep the
  model pinned via `keep_alive`.
- The `prompt-contract watch` cycle is covered by unit tests with injected fakes
  (`packages/cli/test/watch.test.js`); the physical capture→paste landing was
  validated by the Spike-0 cohort you run with `--report`. Neither proves
  enhanced prompts improve downstream outcomes.
