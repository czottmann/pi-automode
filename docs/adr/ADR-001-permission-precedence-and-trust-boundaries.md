# ADR-001: Permission precedence and configuration trust boundaries

**Date:** 2026-08-23

## Context

Pi-automode supports `permissions.deny`, `permissions.ask`, and `permissions.allow` tool patterns. These rules affect whether a tool call reaches the classifier.

An allow rule reduces classifier coverage. A checked-in repository file must not reduce that coverage. An accepted ask rule must also keep its promise of classifier review.

The wildcard matcher limits its input size to keep matching time bounded. Deny and ask rules must fail closed for oversized inputs. The same behavior is unsafe for allow rules.

## Decision

Pi-automode uses this permission policy:

1. A matching `permissions.deny` rule blocks the tool call.
2. A matching `permissions.ask` rule requires user confirmation.
3. If the user declines, pi-automode blocks the tool call.
4. If the user accepts, deterministic denial checks continue.
5. After these checks pass, the classifier reviews the accepted tool call.
6. An accepted ask rule disables all later deterministic allow tiers for that call.
7. If no ask rule matched, a `permissions.allow` rule can skip classifier review.
8. Deterministic hard-deny checks, path-deny checks, and protected-path controls take precedence over allow rules.

Pi-automode reads `permissions.allow` only from user-owned configuration sources:

- `~/.pi/agent/automode.json`
- trusted `.pi/automode.local.json`
- `PI_AUTOMODE_SETTINGS_JSON`

Shared `.pi/automode.json` can add deny and ask rules after project trust. It cannot add allow rules.

[ADR-002](ADR-002-global-config-in-extension-data-directory.md) replaces only the global configuration path. Permission precedence and trust boundaries stay unchanged.

For an oversized matcher input, deny and ask rules return a match. Allow rules return no match. This behavior keeps denial rules fail-closed without broadening allow rules.

Filesystem target discovery is a prerequisite to permission matching: incomplete or unsafe discovery blocks the call. For OMP multi-file edits, bracket-wrapped writes and delimited reads, deny and ask rules match any effective target. Permission allow coverage is required for every target, and no protected source or rename destination can use an allow tier. Canonicalization resolves symlinks before parent traversal. Pi scalar path and read fallback behavior remains supported; native OMP recovery that cannot be enumerated safely is blocked.

User authorization excludes OMP agent-attributed and synthetic prompts. A delegated task is model-authored work, not a new human decision. Metadata-free Pi user messages retain their existing behavior.

## Consequences

A repository cannot use checked-in configuration to remove classifier review. Users can still add project-specific allow rules in the local configuration file.

An accepted ask rule always causes classifier review after deterministic checks pass. This behavior is stricter than a model where confirmation grants direct permission.

The matcher needs separate overflow behavior for denial and allow contexts. Tests must cover both behaviors.

The permission lists are not symmetric across configuration sources. The documentation and diagnostics must make this difference clear.
