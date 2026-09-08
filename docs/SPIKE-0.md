# Spike-0: macOS capture/restore diagnostic

Spike-0 is the only `watch`-related implementation in this repository. It measures the macOS capture link and keeps the paste-back step as a validation-only dry run. `prompt-contract watch` remains unavailable even when a report passes.

## Run it

From the repository root:

```bash
node packages/cli/bin/contract.js spike-0 \
  --json \
  --output /tmp/prompt-contract-spike-0.json
```

The default run covers Chrome, PyCharm, and iTerm with 20 attempts per target. The command asks for a target setup before each group. For a terminal that would steal focus when the command starts, use a setup delay and switch to the target app during the delay:

```bash
node packages/cli/bin/contract.js spike-0 \
  --no-prompt \
  --setup-delay-ms 5000 \
  --json \
  --output /tmp/prompt-contract-spike-0.json
```

`--app Chrome,PyCharm,iTerm` selects an explicit target list. `--iterations` changes attempts per target. `--settle-ms` controls the wait after ⌘C. `--pause-ms` intentionally pauses before dry-run validation so a tester can switch focus and measure the fail-closed behavior.

Exit codes are `0` for a passing report, `1` for a measured threshold failure, and `2` for unsupported macOS/argument setup.

## Safety contract

Each attempt follows this order:

1. Read the current plain-text pasteboard with `pbpaste`.
2. Inspect `clipboard info`. If any non-text type is present, stop before ⌘C; the diagnostic does not rewrite rich clipboard data that it cannot restore.
3. Record the foreground process, bundle identifier, PID, front-window title, and `AXFocusedUIElement` identity attributes through System Events.
4. Send ⌘C only, read the selected text, and record the post-capture foreground/focus identity.
5. Restore the original plain-text clipboard with `pbcopy` in a `finally` path and verify an exact text match.
6. Record the current focus and report whether paste-back would be allowed. No ⌘V is sent.

The report never contains the selected text, the clipboard payload, or `AXValue`. It contains selected-text length plus foreground/focus metadata so the compatibility result can be audited. Window titles and accessibility descriptions can still contain user-controlled names; keep reports local and redact them before sharing.

The dry-run fields are intentionally explicit:

```json
{
  "mode": "dry-run",
  "executed": false,
  "pasteCommandSent": false,
  "userTextMutated": false,
  "wouldPasteBack": true
}
```

## Pass/fail thresholds

The report uses the following default gate:

| Check | Threshold |
|---|---:|
| Attempts per required target | 20 |
| Required targets | Chrome + PyCharm + iTerm |
| Combined selected-text capture success | ≥ 90% (54/60) |
| Combined dry-run paste-back eligibility | ≥ 90% (54/60) |
| Clipboard restore and exact verification | 100% (60/60) |
| Foreground/focus identity coverage | 100% |
| Safety failures (`pasteCommandSent` or `userTextMutated`) | 0 |

The report is a compatibility/safety result, not proof that a real paste lands in the correct editor control: this Spike never pastes. A target with a different foreground app, an empty selection, unavailable focus identity, or focus drift fails its attempt. A temporarily empty window title is tolerated when PID, bundle, and focus attributes remain stable.

## macOS permissions

- Grant Accessibility access to the terminal or launcher that starts the diagnostic in **System Settings → Privacy & Security → Accessibility**. The command uses System Events to send ⌘C and read `AXFocusedUIElement`.
- macOS may also ask to allow the terminal to control **System Events** under **Privacy & Security → Automation**. Denial is reported as a failed attempt; the diagnostic does not bypass the prompt.
- `pbpaste`/`pbcopy` must be available at `/usr/bin/pbpaste` and `/usr/bin/pbcopy`.
- The original pasteboard must be text-only for this Spike. Images, files, HTML/RTF, and other rich types are rejected before ⌘C so the diagnostic cannot silently replace them with plain text.
- No provider key, network request, or LLM call is needed.

Apple’s permission descriptions are documented in [Accessibility access](https://support.apple.com/guide/mac-help/allow-accessibility-apps-to-access-your-mac-mh43185/26/mac/26) and [Automation access](https://support.apple.com/guide/mac-help/mchl108e1718/mac).

## Known limits

- The implementation is macOS-only and intentionally supports only the initial Chrome, PyCharm, and iTerm cohort.
- Clipboard preservation is exact for text-only pasteboards. Rich clipboard preservation is not implemented; those attempts fail closed.
- The report records dry-run eligibility, not actual replacement correctness or end-to-end LLM latency.
- A terminal/automation harness can steal focus. Treat such runs as evidence of focus drift, not as a passing app result; run the diagnostic with the target app actually frontmost.
- `prompt-contract watch` stays gated by D7. A passing JSON report is evidence for a later implementation decision, not an authorization or implementation of resident watch mode.
