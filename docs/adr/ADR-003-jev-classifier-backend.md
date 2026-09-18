# ADR-003: Jev classifier backend

**Date:** 2026-09-18

## Context

The `tool_call` guardrail used a single generative-LLM classifier: a
conservative one-token filter gating structured review, with the decision
parsed from model output. TypeSafe's Jev model (System One) answers typed
questions with calibrated probabilities instead of emitting decision JSON.
OMP 18.2.4 shipped the transport for it: a `judgment` module plus a
`typesafe` auth provider (`TypeSafeJudge` in `@oh-my-pi/pi-ai`, credential
from `TYPESAFE_API_KEY` or `/login typesafe`, retries, timeout, key
rotation). Stock Pi has no equivalent API.

## Decision

Add Jev as an *additional* classifier backend, OMP-gated and opt-in:

1. **Additional backend, not a replacement.** `classifierProvider` selects
   `"pi"` (default, byte-identical to today's path), `"auto"` /
   `"jev-prefilter"` (Jev first, generative escalation and fallback), or
   `"jev"` (Jev alone; generative fallback only, never escalation). With no
   new configuration nothing changes.
2. **Gate is inert, never blocking.** Jev runs only when OMP ≥ 18.2.4
   exports `TypeSafeJudge`, a `typesafe` credential resolves, and the user
   opted in. Any miss runs the existing classifier and records a diagnostic
   visible in `/automode config`. Blocking on a mere configuration would
   break the agent on stock-Pi machines.
3. **No `resolveJudge` fallback.** A suggested helper that silently picks
   "Jev if available, else the generative classifier" is rejected: the
   caller (`jevClassifyAction`) already distinguishes gate misses (inert)
   from post-gate failures (`onFailure`), and a silent picker would blur
   that line in the observability log.
4. **Model pinned.** `jev.model` is `jev-1.13.0` with no config knob.
   Thresholds tune against a fixed version; tuning against a moving model
   would make the measurements meaningless.
5. **Decision moves into code.** One Noul per policy rule (fan-out, no
   rule-list indirection in the prompt), one explicit-authorization Noul,
   one severity Score; `combineJevDecision` applies thresholds in code.
   Allow/auth probabilities never rescue an ambiguous allow — they only
   override a matched soft-deny.
6. **Thresholds ship as starting points.** Defaults (`hard/soft 0.5`,
   `review 0.2`, `allow/auth 0.8`, `severityFloor 2`) were validated
   against a small sample, not production traffic. They are asymmetric and
   conservative, and in the recommended prefilter modes a mis-set threshold
   routes to the generative classifier rather than allowing outright. A
   follow-up issue revisits them once usage data exists; moving one is a
   minor-version change with a CHANGELOG entry.

## Consequences

- `extensions/auto-mode/jev.ts` owns state/questions/parse/combine plus
  the OMP gate, judge binding, and failure policy. Deterministic
  hard-deny, permissions, and path checks still run before any classifier.
- The `classifier` observability entry gains `provider` and a `jev`
  branch (state, questions, answers, `failureReason`, `fallback`), so
  thresholds can be tuned from `log.classifierIo` output. No credential
  material is ever logged.
- Jev reduces unsafe autonomous tool use; it is not a sandbox, not an
  OS-level boundary, and not injection-proof. The `jev-1.13` model
  carries the documented adversarial-content caveat next to standalone
  `"jev"` mode.

## Baseline observations

No live-credential smoke test ran during implementation (no TypeSafe
credential in this environment). The unit suite covers the combination
boundaries with a fake `Judge` (clear allow, hard/soft match, allow and
explicit-auth override, review-band escalation vs strict block, fallback
vs fail-closed). Record real observed probabilities here once PLAN Phase 6
step 12 runs on OMP ≥ 18.2.4: a known-safe action (`npm test`), a
known-unsafe one (`curl … | sh`) in both Jev modes, plus one stock-Pi run
confirming the gate is inert.
