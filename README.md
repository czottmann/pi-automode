# pi-automode

Claude Code-style auto mode for Pi.

This is a guardrail extension. It intercepts agent tool calls before execution and blocks actions that match permission deny rules, deterministic hard-deny checks, or the auto-mode classifier's block decision.

It is not a sandbox. Extensions run in the Pi process. A malicious extension can do anything that your user account can do.

Pi-automode does not guard user `!` or `!!` shell commands. It guards only agent tool calls. Use it to reduce unsafe autonomous tool use. Do not use it as an OS security boundary.

## Compatibility

Pi-automode supports Pi and Oh My Pi (OMP) 18. It automatically uses OMP's legacy completion API. The integration needs no OMP-specific configuration.

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
/automode model     # open classifier model selector and save to ~/.pi/agent/extensions/pi-automode/config.json
/automode model provider/model-id # save classifier model to ~/.pi/agent/extensions/pi-automode/config.json
```

`/auto-mode` is an alias.

## TypeSafe Jev classifier

To classify with TypeSafe's Jev model instead of an LLM, set your API key before you start Pi:

```bash
export TYPESAFE_API_KEY=your-key   # from https://console.typesafe.ai/settings/keys
```

Then run `/automode model typesafe/jev-latest`. See [Configuration](docs/configuration.md#typesafe-jev-classifier) for how Jev answers map to decisions.

## Agent diagnostics

The package registers one model-callable, read-only tool:

`automode_inspect` accepts one `action`:

- `status`: active state and counters
- `config`: active effective configuration, log path, and diagnostics
- `defaults`: built-in rule lists
- `denials`: recent denial timestamps, kinds, and tool names

The tool reads the same in-memory configuration and state that the guardrail enforces. Permission and deterministic checks run before the bypass.

The bypass does not change automode counters, persisted state, or observability logs. The extension verifies the source of the tool before it applies the exemption. Thus, a name collision does not exempt a tool from another extension.

The tool cannot enable or disable auto mode. It cannot reload configuration, reset state, select a model, or change configuration.

Pi sends tool output to the current model. The `status` and `denials` views omit denial reasons and action payloads.

If a diagnosis requires a reason, inspect a known-safe entry in the local observability log. The `config` view includes effective rule text. It removes raw JSON parser details from diagnostics.

Do not put credentials or other secrets in automode rules.

The bundled `automode-diagnostics` skill uses this tool to diagnose unexpected decisions without asking the user to copy output from slash commands. Configuration edits and automode state changes remain user-controlled. See [Agent diagnostics](docs/diagnostics.md) for the inspection contract, privacy limits, and diagnosis workflow.

## Status line

When the Pi TUI is available, the extension renders a persistent status line:

```text
AM ● a:12 d:2 ca:5 cd:1
```

- `AM` — auto-mode prefix. `●` means enabled. `○` means disabled through configuration or `/automode off`.
- `a:` — actions allowed so far (checked minus denied).
- `d:` — actions denied so far, for any reason (permission rule, deterministic hard-deny, or classifier).
- `ca:` / `cd:` — classifier decisions split into allowed and denied. These segments appear after the first classifier call. `d:` counts all denials, so `d:` is always `>= cd:`.

## Docs

- [Configuration](docs/configuration.md)
- [Permission recipes](docs/permission-recipes.md)
- [Defaults and rule-list behavior](docs/defaults.md)
- [Auto-mode classifier flow](docs/automode-classifier-flow.md)
- [Observability logging](docs/observability-logging.md)
- [Architecture decisions](docs/adr/INDEX.md)

## What runs before the classifier

The extension blocks these before any allow or classifier decision:

- `permissions.deny` matches
- declined `permissions.ask` matches
- shell profile writes
- SSH `authorized_keys` writes
- cron, launch agent, and system service persistence
- TLS/certificate/auth weakening patterns
- root, home, and system-path destructive deletes. Subtrees of validated launcher-declared temp directories are treated as disposable. Declared roots that alias `HOME`, `/`, or a system root, or that contain `HOME`, are rejected instead.
- edits to `.pi/automode*`, `.pi` auto-mode files, and this extension's safety-control files

After these checks, pi-automode applies `permissions.allow`. Protected `write` and `edit` targets continue to the classifier.

Accepted ask rules also continue to the classifier. They cannot use an allow tier. Pi-automode then allows the read-only tools `read`, `grep`, `find`, and `ls`. Every remaining action goes to the classifier.

A `permissions.allow` rule intentionally skips classifier policy, including classifier `hard_deny` rules. Use narrow patterns and user-owned configuration. Deterministic hard-deny and path controls remain unconditional.

Set `classifyReadOnlyTools: true` (default `false`) to route read-only tools through the classifier. This configuration value increases model calls, latency, and session cost.

Pi-automode blocks a `deniedPaths` match before classifier review or an allow tier. Thus, file tools cannot send matching secret or system paths to the model.

The list does not govern `bash`. The classifier and deterministic hard-deny checks govern shell access to these paths.

The value `allowInsideWorkingDirectory: true` allows file access inside the working directory locally. Pi-automode sends all outside file access to the classifier, including reads.

Classification starts with a conservative one-token filter. If the filter requests review, pi-automode requests one internal `classifier_decision` tool call.

The tool exists only in the nested classifier request. It is not registered with `pi.registerTool()`, and the main agent cannot call it.

Pi AI requests schema-constrained sampling with `strict: "prefer"`. Supported providers enforce the schema during generation. Pi-automode validates every returned tool call locally.

Both stages receive the complete current tool input in a dedicated message. Transcript truncation cannot remove action content. If the exact input cannot fit in the classifier context, auto mode blocks the call.

Both stages use a classifier-specific session key. They request short cache retention from providers that support it. A missing model, provider failure, or invalid response blocks the action.
Pi-automode parses Bash structure with `unbash` before permission and deterministic hard-deny checks. The analysis includes nested commands and literal shell-wrapper scripts. A Bash parse error blocks the action.

## Examples

- `examples/automode.local.json`: copy to `.pi/automode.local.json` in a project and edit the domains, buckets, and source-control org.
- [Permission recipes](docs/permission-recipes.md): use narrow examples for common permission and classifier-policy changes.

## Known limits

Claude Code's real classifier and exact built-in rules are private. This package implements the documented precedence and configuration behavior, with a local classifier prompt and deterministic hard-deny checks.

## Development

```bash
npm run check
npm test
npm pack --dry-run
```

The tests cover these safety-sensitive areas:

- scoped permission matching
- the `permissions.allow` tier and its precedence
- configuration-source precedence and diagnostics
- `$defaults` behavior
- deterministic hard-deny checks and Bash AST analysis
- classifier routing for `write` and `edit`
- symlink-aware safety-control checks
- token-budgeted transcript selection
- staged classifier tool-call parsing and cache behavior
- hook-level allow and block behavior

## Publishing

When a maintainer publishes a GitHub Release, GitHub Actions publishes the package to npm. The required release tag format is `v<version>`. The `<version>` value must be the same as the version in `package.json`. For example, version `1.0.0` requires tag `v1.0.0`.

The workflow uses npm Trusted Publishing, so it does not need an npm token secret. Configure this package on npm with this repository and workflow file (`.github/workflows/publish.yml`). The workflow builds the package, runs `npm run check`, and publishes with npm provenance.

### Release tag must point at the version bump

The publish workflow checks the commit that the release tag identifies. It compares the version in `package.json` with the tag name.

**The tag must identify a commit that contains the new version.**

1. Commit the version change with `chore: release X.Y.Z`.
2. Push `main`.
3. Create the GitHub release from that commit.

If the tag identifies an older version, the `Check release tag` step fails. It reports `Release tag (vX.Y.Z) does not match package.json version (x.y.z)`.

CAUTION: Do not move a correct release tag. Moving the tag changes a published reference.

1. If the tag identifies the wrong commit, force-move it to the version-change commit.
2. Force-push the corrected tag.
3. Run `gh workflow run publish.yml --ref vX.Y.Z`.

When GitHub creates the tag, the `release` event occurs. A rerun of a failed `release` workflow uses the original reference. It does not use the moved tag.

## Author

Carlo Zottmann, <carlo@zottmann.dev>

- Website: https://actions.work
- GitHub: https://github.com/czottmann
- Bluesky: https://bsky.app/profile/zottmann.dev
- Mastodon: https://norden.social/@czottmann
