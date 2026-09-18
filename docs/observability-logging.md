# Observability logging

Auto mode can write a JSONL observability log for decisions and classifier usage. Persisted sessions use a sidecar next to the Pi session file. In-memory sessions use a global application directory.

Logging is off by default. Logging fails open, so a write error never changes an allow or block decision.

## Enabling

Set `autoMode.log` in a Pi-owned configuration source. These sources include `~/.pi/agent/extensions/pi-automode/config.json`, trusted `.pi/automode.local.json`, and `PI_AUTOMODE_SETTINGS_JSON`.

```json
{
  "autoMode": {
    "log": {
      "enabled": true,
      "classifierIo": false
    }
  }
}
```

- `enabled` — write one `decision` line per tool-call decision and one ccusage-compatible `message` line per classifier model response.
- `classifierIo` — also write the classifier prompt, raw responses, and parsed decision for classifier-routed actions. The default is `false`. See [Privacy](#privacy).

Fields merge independently across configuration sources. For example, set `enabled` globally and set `classifierIo` for a trusted project.

Shared project `.pi/automode.json` cannot set `log`. The shared file cannot set any `autoMode` field. `/automode config` reports an invalid shape.

Pi-automode writes log entries only while auto mode is **enabled**. With auto mode off, no tool calls reach the hook. Thus, pi-automode writes no entries.

## Log file location

Pi-automode stores the log next to the current Pi session file. It inserts `-pi-automode` before the extension:

```text
<session-file>                       →  <dir>/<id>.jsonl
<session-file>-pi-automode.jsonl     →  <dir>/<id>-pi-automode.jsonl
```

For example, pi-automode can use `~/.pi/agent/sessions/<slug>/<id>-pi-automode.jsonl`.

If a custom session manager provides an absolute session directory without a session file, pi-automode uses `<sessionDir>/<sessionId>-pi-automode.jsonl`.

Pi in-memory sessions have no session file or session directory. These sessions include `--no-session` and non-persisted subagents. Their logs use this absolute application path:

```text
~/.pi/agent/extensions/pi-automode/logs/<encoded-session-cwd>/YYYY-MM-DD/<session-id>-pi-automode.jsonl
```

The project directory uses the same `--path-with-dashes--` encoding as normal Pi session directories. The date partition uses UTC.

A custom session manager can supply an absolute `sessionDir` without a session file. In this case, pi-automode continues to use that directory. Run `/automode config` to see the resolved path.

Persisted sessions use one combined file per session. In-memory sessions use one file for each session ID and UTC day.

If a session crosses midnight, pi-automode continues in the file for the next day. Each line contains one JSON object with a `type` discriminator. Entries for the same tool call share a `decisionId`.

For persisted sessions, `ccusage pi` reports the sidecar as a separate `-pi-automode` session. Inspect in-memory logs directly because they are outside the normal Pi session tree.

## Entry types

### `decision`

Pi-automode writes one `decision` entry for each tool-call decision. Each allowed or blocked call has exactly one entry.

| field | meaning |
| --- | --- |
| `ts` | ISO timestamp |
| `decisionId` | links to the related `classifier` entry. Local decisions have no related entry. |
| `sessionId` | Pi session id |
| `cwd` | working directory |
| `tool` | tool name, for example `bash` or `write` |
| `summary` | `actionSummary` — tool name + input JSON (truncated) |
| `kind` | enforcement path: `permissions.deny`, `permissions.ask`, `deterministic-hard-deny`, `deterministic-path-deny`, `permissions.allow`, `inside-working-directory`, `classifier`, `read-only`, or `setup` |
| `outcome` | `allow` or `block` |
| `reason` | the reason string (classifier reason, or the deterministic/permission reason) |
| `classifierModel` | the configured classifier model for a classifier-routed decision |
| `reasoning` | classifier reasoning mode and requested or effective level. See the examples below. |

The reasoning field records either server-default mode:

```json
{"mode":"server-default"}
```

or an explicit request after model-level clamping:

```json
{"mode":"explicit","requestedLevel":"max","effectiveLevel":"xhigh"}
```

Classifier-routed decisions contain the effective level after model resolution. If `classifierIo` is off or authentication fails later, this field still exists.

If pi-automode cannot resolve the model, the entry contains `requestedLevel` without `effectiveLevel`. In this case, no model-supported level exists.

Local permission, deterministic, `permissions.allow`, and read-only decisions do not run the classifier. These decisions can omit `effectiveLevel`. Pi-automode cannot observe or infer the server-selected level in `server-default` mode.

### `message` (classifier usage)

Pi-automode writes one `message` entry for each classifier response. This includes a malformed response that causes a retry.

When logging is enabled, pi-automode writes this entry before the matching `decision` line. The entry shape is compatible with `ccusage pi`:

| field | meaning |
| --- | --- |
| `timestamp` | ISO timestamp from the classifier response |
| `message.role` | always `assistant` |
| `message.model` | model ID returned by the classifier provider |
| `message.usage` | provider-reported input, output, cache, total-token, and cost fields |

For persisted sessions, `ccusage` reports this sidecar as a separate `-pi-automode` session. This entry contains no prompt or response text. When `classifierIo` is off, pi-automode still writes it.

### `classifier`

If `classifierIo: true`, pi-automode writes a `classifier` entry. It writes this entry only for classifier-routed actions.

The entry follows all related classifier-usage `message` entries. It precedes the matching `decision` entry.

| field | meaning |
| --- | --- |
| `ts` | ISO timestamp |
| `decisionId` | matches the `decision` entry for the same call |
| `model` | classifier model, for example `anthropic/claude-haiku-4`, or `jev-1.13.0` for the Jev backend |
| `provider` | classifier backend that produced the decision (`pi`, `auto`, `jev-prefilter`, `jev`); absent for pre-provider entries |
| `jev` | Jev branch, present only for Jev-routed decisions: `{ provider: "jev", model, state, questions, answers, failureReason?, fallback }` where `fallback` is `none`, `escalate`, `classifier`, or `block` |
| `reasoning` | `server-default`, or the explicit requested and effective model-supported level |
| `prompt.system` | the full system policy with `environment`/`allow`/`soft_deny`/`hard_deny` rules interpolated (empty for Jev: rule lists become questions) |
| `prompt.context` | the shared context message: loaded project instructions + classifier transcript |
| `prompt.action` | the complete, untruncated current tool action JSON |
| `prompt.fastInstruction` | the exact one-token filter instruction |
| `prompt.detailedInstruction` | the exact structured-review instruction |
| `attempts` | one entry per classifier model call (see below); empty for Jev (one `judge()` call, recorded in `jev.answers`) |
| `durationMs` | total classifier time |
| `parsed` | the final decision that was acted on (`{ decision, tier, reason }`) |

Tune Jev thresholds from this entry: `jev.answers` holds the per-rule Noul probabilities (`hard_N`/`soft_N`/`allow_N`/`explicit_auth`) and the `severity` score. A decision with `jev.fallback: "escalate"` ran the detailed generative stage after a review band; `"classifier"` fell back after a failure; `"block"` failed closed. No credential material ever appears in the entry.

Each `attempts[]` entry is `{ stage, attempt, response?, parsed?, error?, durationMs }`:

- `stage` — `fast` for the one-token filter or `detailed` for structured review.
- `response` — `{ stopReason, text, model, timestamp, usage, errorMessage? }`, the raw model output and provider-reported usage for that call, including provider-reported errors and aborted requests.
- `parsed` — the decision parsed from the response, or absent after a parse failure.
- `error` — present after a network or authentication error. In this case, `response` is absent.

The array records both stages, retries, and fail-closed cases. A fast allow has one entry. A review with one successful retry has three entries. Jev decisions record no attempts (one `judge()` call lives in `jev.answers`); `ccusage`-compatible `message` entries are likewise absent for Jev's non-chat judgment API.

## Privacy

`prompt.context` contains project instructions and transcript evidence for both classifier stages. `prompt.action` contains the separate, untruncated current action. Pi-automode logs the final stage instructions separately.

See [Auto-mode classifier flow → What is sent to the classifier](automode-classifier-flow.md#what-is-sent-to-the-classifier) for the evidence assembly rules.

The log records this payload locally. Pi-automode also sends the same data to the classifier endpoint for each classifier-routed call.

If `classifierModel` uses a cloud provider, the payload leaves the machine. Enable `classifierIo` only for classifier diagnosis or rule tuning. Leave it off for routine outcome logging.

## Sizing

- `decision` line: ~0.4–2 KB (driven by `summary`, which carries the tool input, capped at 6 KB).
- `classifier` line: ~5 KB fixed policy plus loaded project instructions, selected transcript evidence, stage instructions, and recorded responses.

`autoMode.maxUserTranscriptTokens` and `autoMode.maxToolTranscriptTokens` limit transcript evidence separately. Both fields default to approximately 4000 tokens.

Pi-automode excludes assistant prose and tool results. Provider cache hits can reduce processed or billed input. The log still records the full classifier payload.
