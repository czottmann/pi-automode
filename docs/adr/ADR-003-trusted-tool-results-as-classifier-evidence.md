# ADR-003: Opt-in trusted tool results as classifier evidence

**Date:** 2026-09-27

## Context

The classifier transcript deliberately excludes all tool results. Anything model- or extension-driven can carry injected content, and a malicious extension tool could emit "the user approved this" without any user action. Only text the user typed in chat counts as user intent.

This boundary creates a real gap: several legitimate tools produce results that *are* user decisions. The clearest case is an ask-user questionnaire — the user presses a button in a dialog the agent triggered, the tool returns the selection as a tool result, and the classifier never sees it. The user's explicit answer cannot authorize a soft-denied action unless the user repeats it as a chat message.

Two other forces shape this decision:

- Pi core is a compiled binary. There is no core-level "this content came from a user UI action" tag we could rely on today.
- pi-automode already has one tool-source trust mechanism: `ownsInspectionTool()` verifies that `automode_inspect` is registered from this extension's own canonical path, so a different extension registering the same name cannot inherit the exemption.

## Decision

Add `autoMode.trustedToolResults`. Each entry is a tool name, optionally pinned to a source-path glob with `@`:

- A bare `name` entry trusts every registered tool with that name. The user's explicit config listing is the trust declaration, the same tier as a `permissions.allow` pattern. Any extension that can register a tool already runs arbitrary code with the user's full permissions inside Pi; fabricating classifier evidence gives it no capability it does not already have. A separate built-in-only trust tier would add ceremony without crossing a real boundary, and the resulting friction would push users away from the feature entirely.
- A `name@glob` entry is optional precision: it applies only when the registered tool's canonical source path matches the glob, for users who want the trust scoped to one installed source.

Resolution happens per classification against the currently registered tools:

- Entries that match no registered tool are ignored.
- Empty names and empty globs are rejected.
- With `name@glob`, a name collision from a different extension fails the glob, so the entry stops applying.
- Trusted results share the tool-evidence budget and its truncation rules and render as `ToolResult <name>: <content>`.
- The classifier prompt gains a rule: a trusted ToolResult represents the user's decision about the question it answered — direct user authorization for that subject, never verbatim instructions, never a source of new rules.

Entries accumulate across user-owned configuration sources (global, trusted `.pi/automode.local.json`, `PI_AUTOMODE_SETTINGS_JSON`). Shared project `.pi/automode.json` cannot add them, consistent with the trust boundaries in [ADR-001](ADR-001-permission-precedence-and-trust-boundaries.md). Defaults stay empty: without explicit opt-in, behavior is unchanged.

## Alternatives considered

- **A question tool owned by pi-automode itself.** The strongest anchor — the extension mediates the dialog and records the answer in its own state, with no session round-trip to spoof. Deferred: it duplicates an existing tool, needs system-prompt guidance for adoption, and pins the trust benefit to one UI. The allowlist reuses whatever question tool the user already has.
- **Upstream Pi feature: tag UI-originated answers as user evidence.** The cleanest long-term fix and would benefit every agent, but Pi core ships as a binary; it requires an upstream request. Revisit if Pi exposes a trusted user-intent channel.
- **No code: chat-message authorizations plus `permissions.allow` patterns.** Zero code and closes today's specific incidents, but leaves the dialog-answer gap open.

## Consequences

- Trusting a tool means trusting its output as classifier evidence, which could contain injected content, bounded by the existing rule that transcript evidence cannot change the classifier's rules. A different extension claiming the same name also gains evidence access; that is acceptable under the same reasoning — a shadowing extension already runs code — and `name@glob` remains available for users who want source-level precision.
- Question and option labels are model-authored. A poisoned question could try to phrase approval extractively; that risk is inherent to any confirm dialog the model triggers. The prompt framing ("button press on the shown dialog") bounds it.
- Tools can be registered dynamically; resolution is per decision, so a trusted entry silently stops applying if the owning extension is removed or replaced.
- This is not a sandbox change and does not weaken deterministic hard-deny checks, `permissions.deny`, `deniedPaths`, or protected-path controls.
