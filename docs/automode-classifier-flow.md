# Auto-mode classifier flow

This document describes how `pi-automode` decides whether an agent tool call can run. The classifier is only one part of the flow. Several checks happen before any model call, and some tool calls never reach the classifier at all.

## Short version

For each Pi `tool_call` event, the extension does this:

1. Load the effective auto-mode configuration for the current session.
2. If auto mode is disabled, ignore the call.
3. If the agent turn was cancelled, block the call.
4. Block a matching `permissions.deny` rule.
5. If a `permissions.ask` rule matches, ask the user.
6. If the user declines or no UI is available, block the call.
7. Mark an accepted ask call for required classifier review.
8. Run deterministic hard-deny checks.
9. If no accepted ask rule requires review, let the extension-owned `automode_inspect` tool run locally.
10. Run path-deny checks, including recursive search scopes and symlink aliases.
11. If an ask rule was accepted, skip all deterministic allow tiers.
12. Otherwise, apply the inside-working-directory, `permissions.allow`, and read-only tiers in that order.
13. Send every remaining action through a one-token conservative filter.
14. If the filter requests review, run structured classifier review.
15. Persist state and update the UI status and denial history.

The default posture is fail-closed. If model resolution, authentication, a classifier call, or response parsing fails, pi-automode blocks the action.

## Diagram

```mermaid
flowchart TD
  A[Pi emits tool_call] --> B[Build effective config]
  B --> C{Auto-mode enabled?}
  C -- no --> Z[Let tool run]
  C -- yes --> D{Agent turn cancelled?}
  D -- yes --> X[Block: cancelled]
  D -- no --> F{Matches permissions.deny?}
  F -- yes --> F1[Block locally]
  F -- no --> G{Matches permissions.ask?}

  G -- yes --> H{UI available?}
  H -- no --> H1[Block locally]
  H -- yes --> I[Ask user]
  I -- declined --> I1[Block locally]
  I -- accepted --> J[Require classifier review]
  G -- no --> J0[Continue normally]

  J --> K{Deterministic hard-deny?}
  J0 --> K
  K -- yes --> K1[Block locally]
  K -- no --> E{Extension-owned automode_inspect?}
  E -- yes --> E2{Classifier required by ask?}
  E2 -- no --> E1[Allow without state or log changes]
  E2 -- yes --> N[Run one-token filter]
  E -- no --> K2{Path denied or recursive scope unsafe?}

  K2 -- yes --> K1
  K2 -- no --> K3{Classifier required by ask?}
  K3 -- yes --> N
  K3 -- no --> K4{Inside-CWD allow tier?}
  K4 -- yes, non-protected --> L1[Allow locally]
  K4 -- no or protected --> K5{Matches permissions.allow?}
  K5 -- yes, non-protected --> L1
  K5 -- no or protected --> L{Read-only built-in fast path?}
  L -- yes --> L1
  L -- no --> N

  N --> O{Exact safe token?}
  O -- yes --> Q[Allow tool]
  O -- malformed or error --> O1[Block: fail closed]
  O -- review --> P[Request classifier_decision tool call]
  P --> P1{Valid allow decision tool call?}
  P1 -- yes --> Q
  P1 -- no or error --> R[Block with classifier reason]

  X --> S[Persist state and update UI]
  F1 --> S
  H1 --> S
  I1 --> S
  K1 --> S
  O1 --> S
  R --> S
  L1 --> T[Persist allow state and update UI]
  Q --> T
```

## Configuration loading

Pi-automode loads global and inline configuration during extension initialization. It loads project configuration on `session_start`. `/automode reload` reloads the effective configuration.

The effective configuration combines these sources:

- `~/.pi/agent/extensions/pi-automode/config.json`
- `.pi/automode.local.json` for trusted projects
- `PI_AUTOMODE_SETTINGS_JSON`
- shared `.pi/automode.json` for trusted projects, but only for `permissions.deny` and `permissions.ask`

Before `session_start`, pi-automode loads only global and inline configuration. If `ctx.isProjectTrusted()` returns `true`, it reads project configuration during `session_start` and `/automode reload`.

For an untrusted project, pi-automode ignores both project files. `/automode config` reports each ignored file that exists.

Shared `.pi/automode.json` cannot change `autoMode` rules or add `permissions.allow`. A checked-in file must not reduce classifier coverage. If shared configuration contains `permissions.allow`, `/automode config` reports a diagnostic.

Deny and ask patterns use this source order: global, shared project, project-local, inline. Allow patterns use this source order: global, project-local, inline.

To disable pi-automode for the current project, set `autoMode.enabled` to `false` in `.pi/automode.local.json`:

```json
{
  "autoMode": {
    "enabled": false
  }
}
```

This affects only the trusted project-local configuration. Shared project `.pi/automode.json` cannot disable auto mode.

List fields such as `allow`, `soft_deny`, `hard_deny`, `environment`, and `protectedPaths` support `$defaults`. Omitting `$defaults` replaces the built-ins for that section only. See [Defaults and rule-list behavior](defaults.md).

## Context captured before classification

On `before_agent_start`, the extension appends `AUTO_MODE_GUIDANCE` to the system prompt. This text states that auto mode is active. It also prohibits bypasses or weaker controls.

The same hook extracts context files from Pi's `systemPromptOptions.contextFiles`. The extracted text becomes `loadedContext`. Pi-automode formats each context file as follows:

```text
# path/to/file
<truncated content>
```

Pi-automode truncates the middle of each file to 4000 UTF-16 code units.

## Local checks before the classifier

### `permissions.deny`

Pi-automode checks `permissions.deny` first. A matching rule blocks immediately. Pi-automode does not call the classifier.

Example rule:

```json
"bash(git push --force*)"
```

Permission patterns apply to a Pi tool and its primary argument. `bash` uses `input.command`. `read`, `write`, `edit`, `find`, and `ls` use the normalized resolved `input.path`.

`grep` uses `input.pattern`. If the applicable argument is absent, the matcher uses the serialized input object.

The `*` wildcard matches zero or more characters, including newlines and path separators. Matching is case-insensitive and uses a bounded linear-time algorithm. A configured pattern can contain at most 4,096 UTF-16 code units. A primary argument can contain at most 1,048,576 UTF-16 code units. A longer argument conservatively matches a scoped deny or ask rule.

### `permissions.ask`

`permissions.ask` runs after `permissions.deny`.

If a rule matches without an available UI, pi-automode blocks the action. If a UI is available, pi-automode shows a confirmation dialog.

The dialog contains the matched rule and the action summary.

Approving that dialog does not run the tool directly. Deterministic denial checks continue first. After these checks pass, the classifier reviews the call. The call cannot use `allowInsideWorkingDirectory`, `permissions.allow`, or the read-only fast path.

### `permissions.allow`

`permissions.allow` is a deterministic allow tier. It uses the same patterns as `deny` and `ask`. Thus, it covers built-in, MCP, and extension tools:

```json
"permissions": { "allow": ["bash(git status*)", "example-extension-tool"] }
```

The matcher understands primary arguments for `bash`, the file tools, and `grep`. It uses the serialized input object for other tools.

Use a bare tool name for an MCP or extension tool. An argument pattern compares against the serialized input object.

A match skips only the classifier call. The tier cannot override permission denials, hard-deny checks, path denials, or protected-path controls. An accepted ask rule also disables this tier for the current call.

Pi-automode reads allow entries from global, trusted project-local, and inline configuration. It ignores allow entries in shared project configuration and reports a diagnostic.

A configured pattern can contain at most 4,096 UTF-16 code units. An input can contain at most 1,048,576 UTF-16 code units for allow matching. A longer input returns no match and continues to classifier review. Deny and ask matching uses the opposite overflow result so these rules fail closed.

The default list is empty. Thus, behavior does not change without explicit user configuration. Decision logs use `kind: permissions.allow`.

`/automode status` reports the rule count. `/automode config` shows the resolved patterns.

[ADR-001](adr/ADR-001-permission-precedence-and-trust-boundaries.md) records the precedence and trust-boundary rationale.

### Deterministic hard-deny checks

Some actions are too risky to leave to the classifier. Pi-automode blocks these actions before classifier review.

Current deterministic blocks include these actions:

- writes to shell profile files
- writes to `~/.ssh/authorized_keys`
- edits to auto-mode or Pi permission safety-control files
- weaker TLS or certificate verification
- persistence changes such as cron jobs, launch agents, and system service enablement
- dangerous recursive deletes of root, home, or system paths
- selected system or SSH permission mutations

The `bash` checks use the `unbash` abstract syntax tree. They inspect chains, pipelines, compound commands, substitutions, redirects, and literal shell-wrapper scripts.

Recursive-delete checks hard-deny `/`, the user home root, and top-level system roots. They exempt subpaths of the user home because these paths contain user data.

Some distributions store `HOME` under `/var`. Fedora Silverblue uses `/var/home/<user>`, for example. Pi-automode does not treat `rm -rf` on this home subtree as a system-path delete. It still blocks `rm -rf ~`.

### Read-only bypass and the path gate

Pi-automode allows read-only built-in tools after the prior checks and the `permissions.allow` tier. `classifyReadOnlyTools: true` sends them to the classifier instead.

The read-only tool set is:

```text
read, grep, find, ls
```

Pi-automode still allows reads to protected paths.

Two optional fields change the deterministic tier. `deniedPaths` blocks matching file-tool paths before classifier review or an allow tier.

`allowInsideWorkingDirectory: true` allows file access inside the working directory without classifier review. This access includes writes and edits. Pi-automode sends all out-of-tree file access to the classifier, including reads.

Protected in-tree writes and edits do not use the local allow tier. They still reach the classifier.

By default, both fields are off and `permissions.allow` is empty. Thus, every write and edit reaches the classifier.

## Protected paths

The protected-path configuration identifies safety-sensitive targets. Examples include `.git`, `.pi`, editor directories, shell profiles, package-manager files, and hook files.

By default, every write and edit reaches the classifier. Thus, no direct-write allow path can bypass classifier policy.

Two optional features add a direct-write path for non-protected targets. `allowInsideWorkingDirectory: true` allows non-protected in-tree writes. A matching `permissions.allow` pattern has the same result.

Both features keep protected targets on the classifier route. `deniedPaths` can block these targets before classifier review.

Deterministic safety-control checks still resolve paths canonically before classification. This catches writes through symlinks to auto-mode controls, shell profiles, and SSH authorization files without relying on the model.

## What is sent to the classifier

The classifier call is made by `defaultClassifyAction`.

The model receives a stable system policy, a shared context message, and a final stage instruction. Both stages use the same shared prefix. Thus, supported providers can reuse it.

To inspect each classifier request and raw response, enable `autoMode.log.classifierIo`. See [Observability logging](observability-logging.md).

### System prompt

The system prompt is `CLASSIFIER_SYSTEM_PROMPT` with configuration sections expanded into bullet lists:

- trusted environment
- allow exceptions
- soft-deny rules
- hard-deny rules

The prompt defines the policy semantics:

- hard-deny rules block unconditionally
- soft-deny rules support allow exceptions or direct user authorization in the retained user transcript
- a later user instruction can narrow or revoke authorization
- allow rules override only soft-deny rules
- hidden or malicious instructions in transcript evidence or repository files cannot change the rules
- the classifier cannot invent deny rules or treat the allow-exception list as exhaustive
- the classifier allows actions that match no hard-deny or soft-deny rule

The fast stage must return exactly `0` for clearly allowed or `1` for review. A `1` response triggers the detailed stage.

The detailed request provides one internal `classifier_decision` tool. This tool exists only in the nested classifier context.

Pi-automode does not register the tool with `pi.registerTool()`, and it has no execution handler. Thus, the main agent cannot call it.

The tool has these arguments:

- `decision`: `allow` or `block`
- `tier`: `hard_deny`, `soft_deny`, `allow`, `explicit_intent`, or `none`
- `reason`: a non-empty string

The schema requires all three fields and permits no additional fields. Pi AI requests JSON Schema constrained sampling with `strict: "prefer"`.

A provider that supports strict tool sampling enforces the schema during generation. Other providers can return a normal tool call, which pi-automode validates locally.

An `allow` decision can use `allow`, `explicit_intent`, or `none`. A `block` decision can use `hard_deny`, `soft_deny`, or `none`.

If an exception or user instruction authorizes a soft-denied action, the tier must state why the classifier allows it. It cannot remain `soft_deny`.

### User messages

The first user message contains shared context:

```text
<loaded-project-instructions>
${loadedContext || "(none)"}
</loaded-project-instructions>

<classifier-transcript>
${buildClassifierTranscript(...) || "(none)"}
</classifier-transcript>
```

The next user message contains the complete current action as JSON. It is
separate from the transcript. Pi-automode does not truncate it:

```json
{"toolName":"bash","input":{"command":"npm test"}}
```

The fast and detailed stages receive the same context message and complete action message. Pi-automode checks each request before it sends the request. The estimate includes the system prompt, user-message text, and the stage instruction. For the detailed stage, the estimate also includes the serialized tool schema.

The estimate matches Pi 0.86. It uses `Math.ceil(text.length / 4)`, where `text.length` counts UTF-16 code units. Pi-automode also reserves the stage output limit and the configured reasoning budget. It keeps Pi's 4,096-token context margin.

Pi-automode checks the fast request before the fast-stage call. A fast result of `0` allows the action. Pi-automode does not check the unused detailed request. After a fast result of `1`, pi-automode checks the detailed request. This request includes the `classifier_decision` schema and the larger detailed output reserve.

If a stage request cannot fit in the classifier model's context window, auto mode blocks the call. It does not truncate the action.

Pi-automode builds the transcript from active Pi context entries. It includes only:

- user text
- assistant tool-call names and payloads

Pi-automode excludes assistant prose, hidden reasoning, and tool results. User evidence and tool-call evidence have separate approximate-token budgets. Both budgets default to 4000.

The selector keeps the first and latest user messages. It fills the remaining budget from the newest eligible entries. It renders retained evidence in chronological order. It also marks omitted or truncated evidence.

Transcript truncation does not change the dedicated current-action message.

## Classifier model resolution

Pi-automode selects the classifier model in this order:

1. `autoMode.classifierModel` from configuration
2. the current Pi session model.

`/automode model provider/model-id` and the interactive model picker save `autoMode.classifierModel` to `~/.pi/agent/extensions/pi-automode/config.json`. Project-local `.pi/automode.local.json` can still override that global choice.

`autoMode.classifierReasoningLevel` can request `low`, `medium`, `high`, `xhigh`, or `max` reasoning for both stages.

When the key is absent, classifier calls omit a reasoning preference. The server then selects its default. When the key is present, classifier calls use the normalized Pi AI path.

Pi AI clamps the request to the nearest supported level. Models without reasoning support resolve to `off`. They remain on the normalized path without a reasoning preference.

Each classifier request sends the stage answer allowance plus the #51 reasoning reserve as `maxTokens`. The fast-stage allowance is 512 tokens. The detailed-stage allowance is 1200 tokens. `low` matches the reasoning effort of Codex Auto Review.

That value is the context-fit reserve. On a shared-ceiling provider it is one output cap, not a split between reasoning and the answer. On a budget-thinking provider the adapter may add its own thinking budget and then clamp to the context window, so the wire limit can exceed this reserve. At `xhigh` and `max`, a composed ceiling is the model output limit whenever that limit is at most the allowance plus the reserve (33,968 for the detailed stage, 33,280 for the fast stage).

The extension asks Pi's model registry for API credentials. If the model cannot be found or credentials are unavailable, classification returns a blocking decision:

```text
No classifier model/API key available; auto mode fails closed.
```

Classifier calls use `ctx.signal`, a stable classifier-specific session ID, and `cacheRetention: "short"`. They do not set a temperature because some providers reject it. The calls use provider defaults instead. Providers without cache affinity ignore that option.

The detailed request does not use provider-specific forced tool selection. Its instruction requires exactly one `classifier_decision` call. Missing or invalid calls fail closed.

`autoMode.classifierTimeoutMs` limits each fast-stage and detailed-stage request. The default is 20000 ms.

If a request exceeds its budget, pi-automode aborts it and blocks the action. A stalled provider stream has the same result.

The fast stage requires one visible digit. Its request uses the 512-token allowance plus the same reserve. Reasoning models can still spend hidden tokens before they emit the digit.

Extra visible content fails fast-stage parsing. Detailed review uses the 1200-token allowance plus the same reserve. It can retry once after a missing, invalid, or truncated decision tool call. A length stop retries once at the model output limit or the estimated context room, whichever is smaller, and never below the first ceiling. If the retry ceiling cannot exceed the first ceiling, the retry is skipped and the action fails closed after the first length stop.

## Parsing the classifier result

The fast-stage parser requires `stopReason: "stop"`. It removes surrounding whitespace and accepts only `0` or `1`.

Empty responses, additional content, malformed output, and non-stop responses block immediately. Observability logs preserve the untrimmed model response.

The detailed parser requires `stopReason: "toolUse"` and exactly one `classifier_decision` call. The response must not contain non-empty visible text.

The arguments must contain exactly `decision`, `tier`, and `reason`. Each value must have the required type and an allowed enum value.

The parser also checks the decision and tier combination. It rejects extra fields, unknown tiers, contradictory combinations, and empty reasons.

A response with `stopReason: "length"` can cause one retry. A missing or invalid decision tool call also can cause one retry.

A truncated or invalid response cannot authorize an action. Error and aborted responses block immediately.

If detailed parsing fails after its retry, pi-automode blocks the action with this reason:

```text
Classifier response did not contain a valid classifier decision tool call; auto mode fails closed.
```

If the model call throws, pi-automode blocks the action immediately. It uses a classifier failure message.

## Agent behavior after a blocked tool call

Pi converts a blocked hook response into an error result and does not run the tool. Pi-automode does not set `terminate: true`, so Pi can request the next model response.

The result states that the tool did not run and preserves the denial reason. The result and the Auto Mode guidance instruct the agent to:

- report the block to the user before work that depends on the blocked action continues
- not claim success or rely on effects from the blocked action
- not try an equivalent workaround

Independent work can continue. Interactive approval stays limited to configured `permissions.ask` rules. Classifier and deterministic denials stay final.

These instructions decrease ambiguity in the model context. They do not guarantee that each model will follow the instructions.

## State, UI, and denial history

Every checked action increments `checkedActions`.

Allowed actions store:

- `lastDecision: "allow"`
- `lastReason`

Blocked actions also increment `blockedActions` and add a denial record. Each denial record contains:

- timestamp
- tool name
- reason
- action summary
- denial kind

Recent denial history has a limit of 12 entries. Pi-automode persists state with `pi.appendEntry("pi-automode-state", state)`. Thus, state survives reloads and session restoration.

When UI is available, the extension updates the footer status and shows a warning notification for blocked actions.

## Agent inspection tool

`automode_inspect` exposes `status`, `config`, `defaults`, and `denials` views to the agent. The extension verifies the source of the registered tool before it applies the exemption.

A tool from another extension with the same name still uses normal enforcement. Every view is read-only. After local checks pass, the hook returns before classifier routing and state updates.

Pi sends tool output to the model. Therefore, the `status` and `denials` views omit denial reasons and action summaries.

The `config` view contains effective rule text. Do not store secrets in automode rules.

No state-changing command has a tool equivalent. The user must run `/automode on`, `/automode off`, `/automode reload`, `/automode reset`, and `/automode model` directly. See [Agent diagnostics](diagnostics.md) for the inspection contract, privacy limits, and diagnosis workflow.

## Command interactions

The classifier flow can be inspected or changed through slash commands:

```text
/automode status
/automode on
/automode off
/automode reload
/automode reset
/automode defaults
/automode config
/automode denials
/automode model
/automode model provider/model-id
```

`/auto-mode` is an alias.

`/automode off` disables the whole flow for the current session. `/automode on` re-enables it. `/automode model` saves the classifier model to `~/.pi/agent/extensions/pi-automode/config.json`.
