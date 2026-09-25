# Configuration

The extension follows the documented Claude Code configuration model where Pi supports it.

It reads `autoMode` only from Pi-owned configuration sources:

- `~/.pi/agent/extensions/pi-automode/config.json`
- `.pi/automode.local.json` for trusted projects
- `PI_AUTOMODE_SETTINGS_JSON`

At startup, pi-automode moves a legacy `~/.pi/agent/automode.json` file to the new global path. If both files exist, it uses the new file and reports the conflict. If migration fails, it uses the legacy file for that session and reports the error.

It does not read project configuration until Pi trusts the project. For an untrusted project, it ignores `.pi/automode.local.json` and `.pi/automode.json`. `/automode config` reports each ignored file that exists.

Shared project `.pi/automode.json` cannot weaken auto mode. For a trusted project, it can add `permissions.deny` and `permissions.ask` rules.

The shared file cannot set `autoMode` or add `permissions.allow` rules. If the file contains `permissions.allow`, `/automode config` reports a diagnostic.

To disable pi-automode for the current project, create or edit `.pi/automode.local.json`:

```json
{
  "autoMode": {
    "enabled": false
  }
}
```

This file is project-local. Pi reads it only after project trust. Do not commit this file. Shared project `.pi/automode.json` cannot disable auto mode.

Set a global default classifier model in `~/.pi/agent/extensions/pi-automode/config.json`. For a trusted project, override it in `.pi/automode.local.json`.

`classifierReasoningLevel` requests `low`, `medium`, `high`, `xhigh`, or `max` reasoning for both classifier stages. If the key is absent, pi-automode sends no reasoning preference. The server then selects the level.

Pi AI clamps an unsupported value to the nearest level that the selected model supports. A model without reasoning support resolves to `off`. `low` matches the reasoning effort of Codex Auto Review.

Higher levels can use all 512 or 1200 stage tokens before they produce visible output. In this case, the classifier fails closed. If truncation occurs before the required `0` or `1` digit, increase `fastClassifierMaxTokens`. The default is 512, and the minimum is 16.

`classifierTimeoutMs` limits each classifier request in milliseconds. The default is 20000, and the minimum is 1000. The fast and detailed stages have separate budgets.

If a request stalls or exceeds its budget, pi-automode aborts it. Then auto mode fails closed and blocks the action.

`allowInsideWorkingDirectory` adds a deterministic allow tier for the file tools. The default value is `false`. The file tools are `read`, `write`, `edit`, `grep`, `find`, and `ls`.

The value `allowInsideWorkingDirectory: true` allows access to paths inside the working directory without classifier review. Pi-automode sends access to outside paths to the classifier. This rule also applies to read calls.

This tier takes precedence over `classifyReadOnlyTools`. If both configuration fields are enabled, pi-automode still allows in-tree file access locally. `classifyReadOnlyTools: true` does not change this behavior.

Protected in-tree targets do not use this allow tier. Writes and edits to `.git/hooks`, `.pi` controls, shell profiles, and configuration files still reach the classifier.

`deniedPaths` is a list of path glob patterns. The default list is `[]`. A matching pattern blocks a file-tool call before classifier review or an allow tier.

Patterns support `~`, `$HOME`, and `${HOME}` expansion. The `*` wildcard matches all characters, including `/`. Thus, `**/id_rsa` matches a private key at any depth.

Each pattern can contain at most 4,096 UTF-16 code units. Pi-automode matches the typed path and its symlink-resolved form. It also resolves the fixed path prefix of each pattern. Thus, a symlink alias cannot bypass a denied target.

If a recursive `grep` or `find` scope can contain a denied path, pi-automode blocks the call. A broad pattern such as `*.env` blocks these tools for every directory scope.

A matching path blocks the call without classifier review or an override. The list applies only to file tools. The classifier governs `bash` path access. Both keys use the normal scalar and array precedence.

`allowInsideWorkingDirectory` uses scalar precedence: global, then project-local, then `PI_AUTOMODE_SETTINGS_JSON`. `deniedPaths` entries accumulate across these configuration sources.

Shared project `.pi/automode.json` cannot set either field. Omitting either field at a higher-precedence source does not clear a lower-source value.

Example:

```json
{
  "autoMode": {
    "classifierModel": "provider/model-id",
    "classifierReasoningLevel": "low",
    "classifyReadOnlyTools": false,
    "fastClassifierMaxTokens": 512,
    "classifierTimeoutMs": 20000,
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
    "ask": ["bash(git push *)"],
    "allow": ["bash(git status*)", "example-extension-tool"]
  }
}
```

`maxUserTranscriptTokens` and `maxToolTranscriptTokens` are approximate budgets for each category. Both default to 4000 and accept integers of at least 32.

Pi-automode does not support the former `maxTranscriptLines` field. Evidence selection now uses token budgets instead of line counts.

## Ask-user tools and explicit authorization

Classifier evidence includes normal user messages and assistant tool-call inputs. It excludes assistant prose and all tool results. This exclusion includes answers from ask-user tools such as `@vanillagreen/pi-questions`.

Selecting "Yes" in that tool helps the agent select its next action. Pi-automode does not treat the result as authorization to override a soft deny.

Send the authorization as a normal chat message. Then the agent can retry the action. Tool results remain excluded because they can contain untrusted or prompt-injected content.

## `$defaults`

See [Defaults and rule-list behavior](defaults.md) for built-in `environment`, `allow`, `protectedPaths`, `soft_deny`, and `hard_deny` entries. The document also explains replacement behavior after omission of `$defaults`.

## Observability logging

Auto mode can write a JSONL observability log for decisions and classifier usage. Persisted sessions use a sidecar next to the Pi session file. In-memory sessions use a global application directory. Logging is off by default.

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

With logging enabled, persisted-session sidecars also contain ccusage-compatible entries for every classifier response. When `classifierIo` is off, `ccusage pi` still reports a separate `-pi-automode` session. In-memory logs use the same entry shape but live outside the normal Pi session tree.

See [Observability logging](observability-logging.md) for the log file location, entry schema, and the `classifierIo` privacy tradeoff. Run `/automode config` to see the resolved log file path.

## Permission patterns

Permission patterns use Pi tool names. Examples include `bash(...)`, `write(...)`, `edit(...)`, and `read(...)`. The parser accepts capitalized names such as `Bash(...)`. The documented form is lowercase because Pi tool names are lowercase.

`permissions.allow` is a deterministic allow tier. The default list is `[]`. A matching rule skips classifier review.

Use this tier for a narrow command such as `bash(git status*)`. You can also use it for a side-effect-free extension or MCP tool.

The matcher understands primary arguments for `bash`, the file tools, and `grep`. For file tools, it uses the resolved `input.path`. For `grep`, it uses `input.pattern`.

For `bash`, pi-automode parses `input.command` with `unbash`. Deny and ask rules inspect each executable command in the Bash syntax tree. This includes pipelines, logical chains, compound commands, substitutions, and literal scripts passed to `bash -c`, `sh -c`, or `eval`. The analysis also follows these literal shell scripts through transparent `command`, `exec`, and `env` dispatch.

The matcher normalizes whitespace between Bash tokens. It preserves whitespace and quoting inside each token. Thus, `bash(git push*)` matches `git  push origin main`. Quoted operators do not create extra commands.

A Bash allow decision requires coverage for each executable command. A multi-command pattern must match the same AST structure and operators. This structure check also applies to one command inside a group, wrapper, control structure, or background statement. Separate single-command patterns only cover top-level foreground chains and plain pipelines. Other supported structure requires one matching structural pattern. A multi-command pattern must match the same number of commands in the same order. Each pattern command must match its corresponding input command. One wildcard cannot hide an additional command or a different operator.

A redirect requires explicit coverage in the allow pattern. The redirect operator, file descriptor, variable name, and target pattern must match. Here-documents and dynamic redirect targets continue to the classifier. Parser errors, dynamic command names, and dynamic wrapper scripts cannot use `permissions.allow`.

Control nodes with unrepresented semantic values cannot use `permissions.allow`. This includes loops, functions, coprocesses, case statements, test commands, and arithmetic commands. These scripts continue to the classifier.

Pi-automode does not execute shell expansions. It cannot resolve aliases, variables, generated scripts, or dynamic `eval` input. These calls continue to the classifier unless a deterministic rule blocks them.

For other tools, the matcher uses the serialized input object. Use a bare tool name for an MCP or extension tool. For example, `example-extension-tool` matches every call to that tool.

The providing extension or MCP server defines the Pi tool name. Pi-automode does not need a predefined list.

A match skips only the classifier call. It cannot skip `permissions.deny`, deterministic hard-deny checks, `deniedPaths`, or protected-path controls. An accepted `permissions.ask` rule also takes precedence. After confirmation, the call continues through deterministic checks and then reaches the classifier. It cannot use `permissions.allow`, the inside-working-directory tier, or the read-only fast path.

Pi-automode reads `permissions.allow` only from global configuration, trusted `.pi/automode.local.json`, and `PI_AUTOMODE_SETTINGS_JSON`. Shared `.pi/automode.json` cannot add allow rules.

A pattern can contain at most 4,096 UTF-16 code units. Bash analysis accepts at most 1,048,576 UTF-16 code units. A longer Bash input is blocked before parsing.

For other allow matching, an input can contain at most 1,048,576 UTF-16 code units. A longer input returns no match. Deny and ask patterns match the same oversized input so that they fail closed.

`write` and `edit` calls whose resolved target is a protected path are never covered by `permissions.allow`. This includes protected targets reached through symlink aliases.

See [Permission recipes](permission-recipes.md) for narrow examples of Bash permissions, directory changes, command chains, redirects, and classifier guidance.

## Custom models (like OpenRouter's presets)

Pi-automode can only select models that Pi exposes through its model registry. Add unlisted models to `~/.pi/agent/models.json`.

For example, register an OpenRouter preset in the built-in `openrouter` provider:

```json
{
  "providers": {
    "openrouter": {
      "models": [
        {
          "id": "@preset/nvidia-nemotron-3-nano-30b-a3b-fast",
          "name": "NVIDIA: Nemotron 3 Nano 30B A3B Fast (Preset)",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 262144,
          "maxTokens": 235929,
          "cost": {
            "input": 0.05,
            "output": 0.2,
            "cacheRead": 0.03,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
```

Restart Pi (or run `/reload`), then select the model with `/automode model openrouter/@preset/nvidia-nemotron-3-nano-30b-a3b-fast`.

## TypeSafe Jev classifier

Set `classifierModel` to `typesafe/jev-latest` to classify with TypeSafe's Jev System One model instead of an LLM. Set `TYPESAFE_API_KEY` in Pi's environment. `/automode model typesafe/jev-latest` saves it without a model-registry lookup.

Jev replaces both LLM stages with one call. The configured `hard_deny` and `soft_deny` rules become the options of a Choice question. Two Noul questions check for an ALLOW exception and direct user authorization. Pi-automode then decides locally:

- Allow when the probability of "no deny rule" is at least 0.8.
- Block with `hard_deny` when a hard-deny rule is the top match, or when hard-deny rules together hold at least 0.2 probability.
- Otherwise, the top soft-deny rule blocks unless the ALLOW-exception or user-authorization probability is at least 0.8.

The denial reason names the matched rule. `classifierReasoningLevel` and `fastClassifierMaxTokens` do not apply. `classifierTimeoutMs` does. Request errors, missing keys, and malformed answers fail closed.
