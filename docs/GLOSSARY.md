# Glossary

This glossary defines project terms for `@czottmann/pi-automode`. It does not define standard technical words. Each entry links to a longer explanation where applicable.

## Enforcement flow

The enforcement flow is the ordered pipeline that runs before each agent tool call. See [Auto-mode classifier flow](automode-classifier-flow.md).

**Auto mode** — A Claude Code-style guardrail posture. A pre-execution classifier allows routine, reversible actions and blocks risky actions. It replaces routine permission prompts.

**Deterministic hard-deny** — Local code checks that block high-risk actions before classifier review. A user or model cannot override them. They are independent of the classifier-level [hard_deny](#classifier-policy-and-rules) rules.

**`permissions.allow` tier** — A user-owned list of scoped tool patterns. A match skips classifier review after deterministic checks pass. An accepted `permissions.ask` rule disables this tier for the current call. The tier cannot override a denial or cover protected `write` and `edit` targets. See [ADR-001](adr/ADR-001-permission-precedence-and-trust-boundaries.md).

**Read-only bypass** — The default allow tier for `read`, `grep`, `find`, and `ls`. Permission and deterministic checks run before this tier. `classifyReadOnlyTools` sends these calls to the classifier instead.

**Staged classifier** — A two-stage safety classifier. A conservative one-token filter controls access to an optional structured review. See [Fast stage](#enforcement-flow) and [Detailed stage](#enforcement-flow).

**Fast stage** — The first classifier stage. It returns `0` for a clearly allowed action or `1` for an action that can require review.

**Detailed stage** — The second classifier stage. It runs after a fast-stage review result and returns a structured allow or block decision.

## Classifier policy and rules

The classifier policy defines denial tiers and rule-list syntax. See [Defaults and rule-list behavior](defaults.md).

**hard_deny** — Classifier rules that block unconditionally. They are independent of the code-level [deterministic hard-deny](#enforcement-flow) checks.

**soft_deny** — Classifier rules that normally block but support defined overrides. Unlike [hard_deny](#classifier-policy-and-rules), these rules are not unconditional.

**explicit_intent** — A classifier tier for direct user authorization in the retained user transcript. It authorizes an action that matches a [soft_deny](#classifier-policy-and-rules) rule. A later user instruction that narrows or revokes authorization controls. For a pre-existing local file, see [Defaults and rule-list behavior](defaults.md).

**allow exception** (`autoMode.allow`) — A prose rule that overrides a matching [soft_deny](#classifier-policy-and-rules) rule. It cannot override [hard_deny](#classifier-policy-and-rules). It is independent of the [`permissions.allow` tier](#enforcement-flow).

**Jev** — TypeSafe's System One judgment model, an opt-in classifier backend on OMP only. It answers one typed question per policy rule with calibrated probabilities; pi-automode combines the answers in code. Requires OMP ≥ 18.2.4, a TypeSafe credential, and `classifierProvider` set to `"auto"`, `"jev-prefilter"`, or `"jev"`. See [Configuration](configuration.md#classifier-provider-jev-opt-in).

**classifierProvider** — The `autoMode` field selecting the classifier backend: `"pi"` (default generative two-stage classifier), `"auto"`/`"jev-prefilter"` (Jev first, generative escalation and fallback), or `"jev"` (Jev alone; generative fallback only). Without the OMP gate the setting is inert.

## Status

**AM status line** — The persistent TUI footer that starts with `AM`. It reports the auto-mode state and action counts.
