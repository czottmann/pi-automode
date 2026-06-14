# AGENTS.md

## Project overview

This repository is `@czottmann/pi-automode`, a Pi extension package that implements Claude Code-style auto mode guardrails. The extension intercepts Pi agent tool calls before execution and blocks actions through permission rules, deterministic hard-deny checks, protected-path handling, and an LLM classifier.

This is not a sandbox. Do not describe it as one.

## Important files

- `extensions/auto-mode.ts` — main extension implementation and exported testable helpers.
- `tests/auto-mode.test.ts` — Node test suite for config merging, permission matching, hard-deny checks, classifier parsing, and hook behavior.
- `examples/automode.local.json` — example user/project-local configuration.
- `README.md` — user-facing documentation and install/config reference.
- `package.json` — npm package metadata, Pi manifest, scripts, peer/dev dependencies.

## Development commands

Run these before handing off code changes:

```bash
npm run check
npm test
```

For package/release-sensitive changes, also run:

```bash
npm pack --dry-run
```

`npm run build` is currently an alias for TypeScript no-emit checking.

## Coding conventions

- TypeScript is strict, ESM, NodeNext (`tsconfig.json`).
- Keep code simple and explicit. Avoid abstractions unless multiple call sites justify them.
- Prefer exported pure helpers for logic that needs tests.
- Keep deterministic hard-deny logic independent from classifier behavior where possible.
- Fail closed for safety decisions: missing classifier, invalid classifier output, or hook errors should block rather than allow risky actions.
- Preserve Pi tool names in lowercase in docs and config examples: `bash(...)`, `write(...)`, `edit(...)`, `read(...)`, `find(...)`, `ls(...)`.
- Do not add runtime dependencies unless necessary. Pi core imports belong in `peerDependencies` with `"*"`; development versions belong in `devDependencies`.

## Testing expectations

When changing guardrail behavior, add or update tests in `tests/auto-mode.test.ts` for:

- config precedence and diagnostics;
- permission pattern parsing/matching;
- deterministic hard-deny checks;
- protected-path behavior, including symlinks or cross-project paths when relevant;
- classifier decision parsing and fail-closed behavior;
- `tool_call` hook ordering: permissions first, deterministic hard-deny second, read-only bypass, classifier last.

Bug fixes to blocking/allowing behavior need tests that prove the observed behavior is fixed.

## Safety rules for this repo

This project is itself a safety-control extension. Treat these areas as high risk:

- hard-deny rules and deterministic checks;
- config-source precedence, especially shared project `.pi/automode.json` not weakening `autoMode`;
- classifier prompt semantics;
- protected-path matching;
- shell parsing and command classification;
- permission deny/ask handling.

Do not weaken safety behavior, broaden allow rules, or bypass classifier checks without explicit user direction and tests. Changes to docs must not imply guarantees the extension does not provide.

## Pi extension/package references

Before editing Pi extension APIs, command/UI behavior, tool hooks, package metadata, or package install behavior, consult the installed Pi docs:

- `docs/extensions.md`
- `docs/packages.md`
- relevant files under `examples/extensions/`

Key Pi API constraints used by this project:

- `tool_call` can block by returning `{ block: true, reason }`.
- `event.input` is mutable, but this extension should generally classify the requested action rather than mutate it.
- Use `ctx.hasUI`/`ctx.mode` before UI-only behavior.
- Use `ctx.signal` for nested model calls or async work during active turns.
- `pi.appendEntry()` persists extension state outside LLM context; restore from `ctx.sessionManager` on `session_start`.

## Documentation rules

- Keep `README.md` user-facing and concrete.
- Keep security wording precise: this extension reduces unsafe autonomous tool use; it is not an OS-level security boundary.
- When adding config examples, include `$defaults` unless the example is intentionally demonstrating replacement behavior.
- Keep command lists and examples in sync with `extensions/auto-mode.ts`.

## Git hygiene

- Check `git status --short` before committing or making broad edits.
- Do not overwrite unrelated user changes.
- Do not edit `.env` files or local Pi auto-mode config unless explicitly asked.
- Commit only when explicitly asked.
