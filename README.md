# pi-automode

Claude Code-style auto mode for Pi.

This is a guardrail extension. It intercepts agent tool calls before execution and blocks actions that match permission deny rules, deterministic hard-deny checks, or the auto-mode classifier's block decision.

It is not a sandbox. Extensions run in the Pi process, and a determined malicious extension can do anything your user account can do. It also does not guard user `!` / `!!` shell commands; by design, it guards agent tool calls only. Use this to reduce unsafe autonomous tool use, not as an OS security boundary.

## Install

From npm:

```bash
pi install npm:@czottmann/pi-automode
```

From a local checkout:

```bash
pi install .
```

For one run from a local checkout:

```bash
pi -e ./extensions/auto-mode.ts
```

## Commands

```text
/automode status    # current state, rules, and classifier
/automode on        # re-enable for this session
/automode off       # disable for this session
/automode reload    # reload config from disk
/automode reset     # reset denial counters only
/automode defaults  # print the built-in rule lists
/automode config    # effective config, resolved log file path, + diagnostics
/automode denials   # denial history for this session
/automode model     # open classifier model selector and save to ~/.pi/agent/automode.json
/automode model provider/model-id # save classifier model to ~/.pi/agent/automode.json
```

`/auto-mode` is an alias.

## Agent diagnostics

The package registers one model-callable, read-only tool:

`automode_inspect` accepts one `action`:

- `status`: active state and counters
- `config`: active effective config, log path, and diagnostics
- `defaults`: built-in rule lists
- `denials`: recent denial timestamps, kinds, and tool names

The tool reads the same in-memory config and state that the guardrail enforces. After permission and deterministic checks pass, it bypasses classification without changing automode counters, persisted state, or observability logs. The extension verifies tool provenance before applying this exemption, so a name collision does not exempt another extension's implementation. The tool cannot enable, disable, reload, reset, select a model, or change configuration.

Tool output is sent to the current model. The `status` and `denials` views omit denial reasons and action payloads; inspect a known-safe reason from the local observability log when diagnosis requires it. The `config` view includes effective rule text but strips raw JSON parser details from diagnostics. Do not put credentials or other secrets in automode rules.

The bundled `automode-diagnostics` skill uses this tool to diagnose unexpected decisions without asking the user to copy output from slash commands. Configuration edits and automode state changes remain user-controlled.

## Status line

When the Pi TUI is available, the extension renders a persistent status line:

```text
AM● a:12 d:2 ca:5 cd:1
```

- `AM` — auto-mode prefix; `●` when enabled, `○` when disabled (via config or `/automode off`).
- `a:` — actions allowed so far (checked minus denied).
- `d:` — actions denied so far, for any reason (permission rule, deterministic hard-deny, or classifier).
- `ca:` / `cd:` — classifier decisions split into allowed vs denied. These segments appear only after the classifier has run at least once; `d:` counts all denials, so `d:` is always `>= cd:`.

## Docs

- [Defaults and rule-list behavior](docs/defaults.md)
- [Auto-mode classifier flow](docs/automode-classifier-flow.md)
- [Observability logging](docs/observability-logging.md)

## Configuration

The extension follows Claude Code's documented config model where Pi can support it.

It reads `autoMode` from Pi-owned config only:

- `~/.pi/agent/automode.json`
- `.pi/automode.local.json`
- `PI_AUTOMODE_SETTINGS_JSON`

It deliberately does not read `autoMode` from shared project `.pi/automode.json`, because a checked-in repo should not be able to weaken auto-mode rules. Shared project config may still contribute `permissions.deny` and `permissions.ask`.

To disable pi-automode for the current project, create or edit `.pi/automode.local.json`:

```json
{
  "autoMode": {
    "enabled": false
  }
}
```

This is project-local and should not be committed. Shared project `.pi/automode.json` cannot disable auto-mode.

Set a global default classifier model in `~/.pi/agent/automode.json`; override it per project in `.pi/automode.local.json`.

`classifierReasoningLevel` optionally requests `low`, `medium`, `high`, `xhigh`, or `max` reasoning for both classifier stages. If the key is absent, pi-automode sends no reasoning preference and leaves the choice to the server. Pi AI clamps unsupported values to the nearest level supported by the selected model; a non-reasoning model resolves to `off`. `low` matches Codex Auto Review's reasoning effort and the practical default when an explicit value is needed. Higher levels can consume the existing 512/1200-token stage limits before producing visible output, which causes the classifier to fail closed. Raise `fastClassifierMaxTokens` (default 512, integer ≥ 16) if you run a reasoning model whose fast-stage budget is truncated before it emits the required `0`/`1` digit.

`allowInsideWorkingDirectory` (default `false`) adds a deterministic silent-allow tier for the file tools (`read`, `write`, `edit`, `grep`, `find`, `ls`): when `true`, a call whose resolved path is inside the working directory is allowed without any classifier call, and file access outside the working directory is routed to the classifier (including reads, which would otherwise take the read-only fast path). This matches the Codex/Claude Code "inside the sandbox = silent, outside = review" model. The tier takes precedence over `classifyReadOnlyTools`: with both enabled, in-tree file access is still allowed without a classifier call, and out-of-tree file access is classified. `classifyReadOnlyTools: true` only routes in-tree reads to the classifier when `allowInsideWorkingDirectory` is `false`.

`deniedPaths` (default `[]`) is a list of path glob patterns that are hard-denied before the classifier and before the inside-working-directory tier — the file-tool equivalent of a secret/system deny list. Patterns support `~`, `$HOME`, and `${HOME}` expansion and `*` (which matches any characters, including `/`, so `**/id_rsa` matches a private key at any depth). Matching checks both the path as typed and its symlink-resolved form, so a `~/.ssh/*` rule still matches when `~/.ssh` is a symlink. A matching path blocks the call unconditionally (no classifier, no override). The deny list applies to file tools only; `bash` path access is governed by the classifier. Both keys follow the normal scalar/array precedence.

The setting follows the normal scalar precedence: global, then project-local, then `PI_AUTOMODE_SETTINGS_JSON`. Shared project `.pi/automode.json` cannot set it. Omitting the key at a higher-precedence scope does not clear a lower-precedence value.

Example:

```json
{
  "autoMode": {
    "classifierModel": "provider/model-id",
    "classifierReasoningLevel": "low",
    "classifyReadOnlyTools": false,
    "fastClassifierMaxTokens": 512,
    "allowInsideWorkingDirectory": false,
    "deniedPaths": [],
    "maxUserTranscriptTokens": 4000,
    "maxToolTranscriptTokens": 4000,
    "environment": [
      "$defaults",
      "Source control: github.example.com/acme-corp and all repos under it",
      "Trusted internal domains: *.corp.example.com, git.example.com",
      "Trusted cloud buckets: s3://acme-dev-artifacts, gs://acme-ci-cache",
      "Key internal services: staging deploy API at deploy.corp.example.com"
    ],
    "allow": ["$defaults"],
    "protectedPaths": ["$defaults"],
    "soft_deny": ["$defaults"],
    "hard_deny": [
      "$defaults",
      "Never send repository contents to third-party code-review APIs"
    ]
  },
  "permissions": {
    "deny": ["bash(rm -rf *)"],
    "ask": ["bash(git push *)"]
  }
}
```

`maxUserTranscriptTokens` and `maxToolTranscriptTokens` are approximate per-category budgets; both default to 4000 and accept integers of at least 32. The former `maxTranscriptLines` setting is no longer supported because evidence selection is token-budgeted rather than line-based.

### Ask-user tools and explicit authorization

Classifier evidence includes normal user messages and assistant tool-call inputs, but excludes assistant prose and all tool results. This includes answers returned by ask-user tools such as `@vanillagreen/pi-questions`. Selecting "Yes" there helps the agent decide what to do next, but pi-automode does not treat that tool result as explicit authorization to override a soft deny. Send the authorization as a normal chat message instead; the agent can then retry the action. Tool results are excluded because they may contain untrusted or prompt-injected content.

### `$defaults`

See [Defaults and rule-list behavior](docs/defaults.md) for built-in `environment`, `allow`, `protectedPaths`, `soft_deny`, and `hard_deny` entries, plus replacement behavior when `$defaults` is omitted.

### Observability logging

Auto mode can write a JSONL observability log next to the current Pi session file, so you can inspect decisions and classifier usage. It is off by default.

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

With logging enabled, the sidecar also writes ccusage-compatible entries for every classifier response. `ccusage pi` reports this usage as a separate `-pi-automode` session even when `classifierIo` is off.

See [Observability logging](docs/observability-logging.md) for the log file location, entry schema, and the `classifierIo` privacy tradeoff. Run `/automode config` to see the resolved log file path.

### Permission patterns

Permission patterns use Pi tool names, for example `bash(...)`, `write(...)`, `edit(...)`, `read(...)`. The parser accepts capitalized names like `Bash(...)` for convenience, but the documented form is lowercase because Pi tool names are lowercase.

## What is enforced before the classifier

The extension blocks these before any allow or classifier decision:

- `permissions.deny` matches
- declined `permissions.ask` matches
- shell profile writes
- SSH `authorized_keys` writes
- cron, launch agent, and system service persistence
- TLS/certificate/auth weakening patterns
- root, home, and system-path destructive deletes
- edits to `.pi/automode*`, `.pi` auto-mode files, and this extension's safety-control files

Read-only Pi tools (`read`, `grep`, `find`, `ls`) are allowed after those checks. Every side-effecting action goes to the classifier, including all `write` and `edit` calls, `bash`, MCP, subagent, network-capable tools, and unknown tools. This keeps classifier hard-deny rules unconditional; direct file writes cannot bypass them. Set `classifyReadOnlyTools: true` to route read-only tools through the classifier as well, so reads outside the trusted working tree can be denied by policy. With it enabled, every `read`, `grep`, `find`, and `ls` call runs the two-stage classifier, which raises the number of model calls, the latency, and the cost per session.

Path matches in `deniedPaths` are blocked before every classifier and fast-path decision, so secret and system paths never reach the model through the file tools. The deny list does not govern `bash`; shell access to those paths is handled by the classifier and the deterministic hard-deny checks. With `allowInsideWorkingDirectory: true`, file tools inside the working directory are allowed without a classifier call, and outside-working-directory file access (reads included) goes to the classifier.

Classification starts with a one-token conservative filter and runs structured review only when that filter requests it. Both stages use a classifier-specific session key and short provider cache retention where the provider supports it. Missing models, provider failures, or malformed responses block the action.

## Examples

- `examples/automode.local.json`: copy to `.pi/automode.local.json` in a project and edit the domains, buckets, and source-control org.

## Known limits

Claude Code's real classifier and exact built-in rules are private. This package implements the documented precedence and configuration behavior, with a local classifier prompt and deterministic hard-deny checks.

## Development

```bash
npm run check
npm test
npm pack --dry-run
```

The tests cover the risky parts: scoped permission matching, config-source precedence, `$defaults` behavior, config diagnostics, deterministic hard-deny checks, shell parsing, write/edit classifier routing, symlink-aware safety-control checks, token-budgeted transcript selection, staged classifier parsing and caching options, and hook-level blocking/allowing.

## Publishing

GitHub Actions publishes the package to npm when a GitHub Release is published. The release tag must match `package.json` exactly, with or without a leading `v` (`v1.0.0` and `1.0.0` both work for version `1.0.0`).

The workflow uses npm Trusted Publishing, so it does not need an npm token secret. Configure this package on npm with this repository and workflow file (`.github/workflows/publish.yml`). The workflow builds the package, runs `npm run check`, and publishes with npm provenance.

### Release tag must point at the version bump

The publish workflow checks out the commit the release tag points at and compares `package.json` against the tag name. **The tag must point at a commit where `package.json` already carries the new version.** Concretely: commit the version bump (`chore: release X.Y.Z`), push `main`, then create the GitHub release targeting that pushed commit. Creating the release before pushing the version bump — or targeting a commit that still has the old version — fails the `Check release tag` step with `Release tag (vX.Y.Z) does not match package.json version (x.y.z)`.

If the tag was cut against the wrong commit, fix it by force-moving it to the version-bump commit and pushing, then trigger the workflow via `gh workflow run publish.yml --ref vX.Y.Z` (the `release` event fires on tag creation; re-running a failed `release`-triggered run reuses the original ref and won't pick up the moved tag).

## Author

Carlo Zottmann, <carlo@zottmann.dev>

- Website: https://actions.work
- GitHub: https://github.com/czottmann
- Bluesky: https://bsky.app/profile/zottmann.dev
- Mastodon: https://norden.social/@czottmann
