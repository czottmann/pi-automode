# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## Bug fixes

- **System-wide delete checks** — Block recursive deletion of `/Users` and its subdirectories. Check the search root after `find -H`, `-L`, or `-P` before `-delete`.

## [1.17.0] - 2026-09-22

## New features

- **Schema-constrained classifier decisions** — Return detailed-stage decisions through an internal `classifier_decision` tool call. Supported providers enforce the schema during generation, and pi-automode validates every returned call locally. When strict tool sampling is available, this reduces fail-closed blocks caused by malformed or contract-invalid decision JSON. (#50)
- **[Permission recipes](docs/permission-recipes.md)** — Add safe, composable examples for Bash permissions, working-directory changes, command chains, redirects, and classifier guidance. Thanks to @georgesleen for the impulse! (#46)

## Bug fixes

- **Status indicator separator** — Add one space between the `AM` prefix and the status symbol.
- **Classifier context budgeting** — Estimate fast and detailed classifier requests in tokens instead of mixing UTF-8 bytes with token limits. Check detailed-stage capacity only after the fast stage requests review. Large project contexts no longer block small actions that fit. (#37)
- **Explicit blocked-action feedback** — State that blocked tools did not run. Tell the agent not to claim success or rely on blocked effects. Require a report before dependent work continues. (#38)
- **Shared classifier reasoning reserves** — Use OMP 18 Anthropic reasoning budgets for classifier context checks under Pi and OMP. Reserve 4,096 tokens at `low` and 32,768 tokens at `xhigh` and `max` for all classifier providers. (#51)
- **Pi 0.86 classifier compatibility** — Route explicit-reasoning classifier calls through the model registry's normalized streaming API. Keep direct-provider support for older Pi versions and the compat fallback for OMP 18. (#52)
- **Dynamic Bash allow coverage** — Route commands with unresolved Bash argument expansions or active pathname expansions to classifier review. Preserve static quoted, escaped, and ANSI-C glob literals. (#54)
- **Classifier model validation** — Reject non-string and malformed `classifierModel` values during diagnostics and configuration merging. Preserve valid lower-precedence values and the session-model fallback. Prevent invalid configuration from causing tool-hook exceptions. (#55)
- **Malformed permission deny diagnostics** — Report malformed `permissions.deny` patterns with their configuration source and list index. Preserve fail-closed deny matching and no-match allow behavior. (#56)
- **Cancelled tool-call accounting** — Route already-cancelled calls through the standard block path. Record counters, denial history, persisted state, UI updates, and decision logs without Bash analysis or classifier work. (#57)

## [1.16.0] - 2026-09-07

## New features

- **[Bounded existing-file authorization](docs/defaults.md#soft_deny)** — Allow user authorization for pre-existing local-file changes that names task, worktree, path scope, and allowed operation. (#32)

## Bug fixes

- **OpenCode classifier routing** — Add OpenCode session headers to every classifier completion path. Preserve Pi's header precedence and exact host matching. (#35)
- **OMP 18 project trust compatibility** — Treat runtimes without `isProjectTrusted()` as untrusted. Prevent startup and configuration commands from throwing. (#34)

## [1.15.0] - 2026-08-28

## Bug fixes

- **OMP 18 classifier compatibility** — Support OMP 18 model registries that lack `complete()` and `getProvider()`. Load the legacy completion API only for these registries. Keep current Pi on its runtime registry path so extension-registered providers remain available. Thanks, @NarryG! (#29)

## [1.14.0] - 2026-08-27

## Bug fixes

- **Classifier stream timeout** — Apply `classifierTimeoutMs` to the full response stream. Provider behavior cannot keep classifier calls pending after the deadline. Parent cancellation remains active. Reject values above the Node.js timer limit. (#30)
- **OS temp-directory deletes** — Stop hard-denying recursive-delete subtrees under `os.tmpdir()` and `/tmp`. On macOS these resolve into `/private/tmp` and `/private/var/folders`, which matched the `/private` system root and blocked every temp cleanup. Deleting a temp root itself stays blocked. (#31)
- **Validated temp-root declarations** — Derive the exempt temp roots only from launcher-declared values that stay safe: reject values such as `/`, empty strings, aliases of `HOME`, `/`, or a system root, and ancestors of `HOME`. Without validation, a malformed `TMPDIR` could disable deterministic denials for protected targets, and a broad `permissions.allow` rule could then allow the action without classifier review. Recompute candidates when the effective tmpdir changes. (#31)

## [1.13.0] - 2026-08-25

## New features

- **Bash AST analysis** — Replace handwritten shell parsing with `unbash`. Permission and hard-deny checks now inspect command structure, nested commands, wrappers, redirects, and malformed input. Bash allow rules require complete structural coverage and fail closed when analysis is unsafe. (#26)
- **Extension-owned global config** — Store global settings at `~/.pi/agent/extensions/pi-automode/config.json`. Migrate the legacy file automatically, preserve a safe fallback after migration errors, and report conflicts through notifications and diagnostics. (#27)

## Bug fixes

- **Conservative permission rules** — Malformed deny and ask patterns block actions. Malformed patterns do not expand allow rules. Permission checks examine each Bash subcommand and normalize whitespace. Path checks resolve symlinks and normalize `file://` and Windows paths. (#22)
- **Recursive deletion hard-deny** — Detect uppercase flags and GNU abbreviations for recursive `rm`, including commands behind `command`, `exec`, and `env`. Parse the `--` delimiter and shell tilde expansion. Protect Linux and macOS system roots without blocking active-home subdirectories, `/opt`, or `/srv`. (#23)
- **Global Pi safety-control paths** — Hard-deny direct writes and edits to `~/.pi/agent/extensions/`, `~/.pi/agent/settings.json`, and `~/.pi/agent/settings/`. Resolve case variants and symlink targets before matching. (#24)
- **Case-insensitive protected paths** — Match protected paths without case distinctions and normalize Unicode spellings. This closes path bypasses on case-insensitive filesystems. (#25)

## [1.12.0] - 2026-08-23

## New features

- **Deterministic permission allows** — Add user-owned `permissions.allow` patterns that skip classifier review after deterministic checks pass. Accepted ask rules still require classifier review. Thank you, @sergeykonkin! (#14)
- **Configurable classifier request timeout** — new `autoMode.classifierTimeoutMs` setting. The default is 20000 ms. The timeout applies to each classifier request. The fast stage and the detailed stage each have their own budget. A request that exceeds the timeout is aborted. Auto mode fails closed and blocks the action.
- **Read-only agent diagnostics** — Add `automode_inspect` tool for status, configuration, defaults, and recent denial metadata. Thank you, @blalor! (#11)

## Bug fixes

- **Reject invalid config values** — Invalid boolean and log config values (e.g. `enabled: 0`, `log.enabled: 1`) are now rejected at merge time instead of being applied with diagnostics only. (#20)
- **Preserve defaults for malformed rule lists** — A malformed `hard_deny` entry like `[42]` no longer strips all built-in hard-deny rules. Malformed entries are rejected and defaults preserved conservatively. (#21)
- **Runtime classifier providers** — Dispatch classifier calls through Pi's runtime model registry so providers registered with `pi.registerProvider()` work immediately. Preserve normalized reasoning and header-only authentication on the temporary simple-completion bridge. (#15)
- **Bounded wildcard matching** — Replace regex-based permission and denied-path globs with a linear-time matcher. Reject oversized patterns and fail closed for oversized runtime inputs. (#19)
- **Complete classifier action input** — Send the exact current tool input to both classifier stages in a dedicated message. Block the action if it cannot fit without truncation. (#17)
- **Path policy normalization** — Use Pi-compatible resolution for file-tool paths, including file URLs, `@` and tilde aliases, and read fallback names. Enforce denied paths across omitted and recursive search scopes and both sides of symlink aliases. (#18)
- **Project config trust gate** — Ignore `.pi/automode.local.json` and `.pi/automode.json` until Pi trusts the project. Apply the trust gate during startup and config reloads. (#16)
- **In-memory observability logs** — Write logs to an extension-owned directory (`~/.pi/agent/extensions/pi-automode/logs/`) instead of the launching project directory. Thanks, @HerbertGao! (#13)

[Unreleased]: https://github.com/czottmann/pi-automode/compare/v1.17.0...HEAD
[1.17.0]: https://github.com/czottmann/pi-automode/compare/v1.16.0...v1.17.0
[1.16.0]: https://github.com/czottmann/pi-automode/compare/v1.15.0...v1.16.0
[1.15.0]: https://github.com/czottmann/pi-automode/compare/v1.14.0...v1.15.0
[1.14.0]: https://github.com/czottmann/pi-automode/compare/v1.13.0...v1.14.0
[1.13.0]: https://github.com/czottmann/pi-automode/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/czottmann/pi-automode/compare/v1.11.0...v1.12.0
