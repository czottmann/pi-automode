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
/automode config    # current effective config + diagnostics
/automode denials   # denial history for this session
/automode model     # open classifier model selector and save to ~/.pi/agent/automode.json
/automode model provider/model-id # save classifier model to ~/.pi/agent/automode.json
```

`/auto-mode` is an alias.

## Docs

- [Defaults and rule-list behavior](docs/defaults.md)
- [Auto-mode classifier flow](docs/automode-classifier-flow.md)

## Configuration

The extension follows Claude Code's documented config model where Pi can support it.

It reads `autoMode` from Pi-owned config only:

- `~/.pi/agent/automode.json`
- `.pi/automode.local.json`
- `PI_AUTOMODE_SETTINGS_JSON`

It deliberately does not read `autoMode` from shared project `.pi/automode.json`, because a checked-in repo should not be able to weaken auto-mode rules. Shared project config may still contribute `permissions.deny` and `permissions.ask`.

Set a global default classifier model in `~/.pi/agent/automode.json`; override it per project in `.pi/automode.local.json`.

Example:

```json
{
  "autoMode": {
    "classifierModel": "provider/model-id",
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

### `$defaults`

See [Defaults and rule-list behavior](docs/defaults.md) for built-in `environment`, `allow`, `protectedPaths`, `soft_deny`, and `hard_deny` entries, plus replacement behavior when `$defaults` is omitted.

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

Read-only Pi tools (`read`, `grep`, `find`, `ls`) are allowed after those checks.

Writes to [protected paths](docs/defaults.md#protectedpaths) (shell profiles, tool configs, `.git`, `.vscode`, `.pi`, etc.) always go to the classifier, even if an `allow` rule matches. The classifier decides whether to permit the write.

Everything else goes to the classifier. If the classifier is missing, fails, or returns invalid JSON, the action is blocked.

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

The tests cover the risky parts: scoped permission matching, config-source precedence, `$defaults` behavior, config diagnostics, deterministic hard-deny checks, shell parsing for risky bash fragments, classifier JSON parsing, hook-level blocking/allowing, classifier mocking, and protected-path enforcement.

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
