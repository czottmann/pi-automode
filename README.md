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
/automode model     # open classifier model selector
/automode model provider/model-id # set classifier directly
```

`/auto-mode` is an alias.

## Configuration

The extension follows Claude Code's documented config model where Pi can support it.

It reads `autoMode` from Pi-owned config only:

- `~/.pi/automode.json`
- `.pi/automode.local.json`
- `PI_AUTOMODE_SETTINGS_JSON`

It deliberately does not read `autoMode` from shared project `.pi/automode.json`, because a checked-in repo should not be able to weaken auto-mode rules. Shared project config may still contribute `permissions.deny` and `permissions.ask`.

Example:

```json
{
  "autoMode": {
    "environment": [
      "$defaults",
      "Source control: github.example.com/acme-corp and all repos under it",
      "Trusted internal domains: *.corp.example.com"
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

`$defaults` expands to this plugin's built-in entries for the section where it appears. It is section-local: `$defaults` in `allow` means the built-in allow rules, not the built-in hard-deny rules.

#### `environment`

`$defaults` expands to:

- trusted repo: the repository Pi started in and its configured git remotes
- source control: the trusted repo and its configured remotes only
- trusted internal domains: none configured
- trusted cloud buckets: none configured
- key internal services: none configured

#### `allow`

`$defaults` expands to allow exceptions for:

- read-only operations: inspecting files, listing directories, searching, GET requests, and state queries that do not expose secrets
- local development inside the working tree: creating, editing, building, testing, linting, formatting, and deleting files created during the current task
- installing dependencies already declared in package manifests or lockfiles
- using standard credentials only with their intended configured providers
- pushing to the current non-default working branch or a new branch created for the task
- bootstrapping language/toolchain installers from official sources

These are exceptions to `soft_deny`, not to `hard_deny`.

#### `protectedPaths`

`$defaults` expands to paths where writes are never auto-approved — they always go to the classifier, regardless of `allow` rules. This matches Claude Code's protected-paths behavior.

Protected directories: `.git`, `.config/git`, `.vscode`, `.idea`, `.husky`, `.cargo`, `.devcontainer`, `.yarn`, `.mvn`, `.pi`.

Protected files: `.gitconfig`, `.gitmodules`, `.gitignore`, `.gitattributes`, shell profiles (`.bashrc`, `.zshrc`, `.profile`, etc.), `.envrc`, package manager configs (`.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pnp.cjs`, `bunfig.toml`, etc.), Bazel configs (`.bazelrc`, `.bazelversion`, `.bazeliskrc`), hook configs (`.pre-commit-config.yaml`, `lefthook.yml`), Gradle/Maven wrappers, `.devcontainer.json`, `.ripgreprc`, `pyrightconfig.json`, `.mcp.json`.

Read-only tools (`read`, `grep`, `find`, `ls`) bypass this check — reads to protected paths are always allowed. Only `write` and `edit` are affected.

#### `soft_deny`

`$defaults` expands to soft blocks for:

- force push, remote branch deletion, remote history rewrite, or direct push to `main`, `master`, or the default branch
- downloading and executing external code, including `curl | bash` and `wget | sh`
- production deploys, production database migrations, or production infrastructure changes
- deleting, truncating, or overwriting pre-existing local files unless the user named the specific target
- mass modification/deletion in cloud storage, ticketing systems, collaboration tools, or external APIs
- writing through remote shells such as `ssh`, `kubectl exec`, or `docker exec` on shared or production hosts
- changing live/shared infrastructure without a preview, plan, dry-run, or review when one normally exists
- killing other users' processes, cancelling shared jobs, or disrupting shared infrastructure
- exposing local files, sockets, credentials, or internal services through a network service
- outbound messages, purchases, bookings, subscriptions, or other real-world transactions

Soft blocks can be overridden by a matching `allow` exception or by direct, specific user intent.

#### `hard_deny`

`$defaults` expands to unconditional blocks for:

- weakening TLS, certificate validation, authentication, authorization, audit logging, or other security controls
- adding persistence such as SSH keys, shell profile edits, cron jobs, launch agents, login items, or background agents
- granting admin, owner, IAM, RBAC, repository, or production access
- exfiltrating repository contents, secrets, credentials, private keys, tokens, or internal data to untrusted places
- scanning for credentials, tokens, private keys, or secrets beyond what the task requires
- tampering with logs, audit trails, security monitoring, permission rules, auto-mode config, or safety-control files
- creating services, endpoints, workflows, or autonomous agents that execute arbitrary code without meaningful approval
- posting or updating public/external content that is fabricated, misleading, impersonating a user, or claiming approval/action that did not happen

Hard-deny rules cannot be overridden by `allow` or by user intent.

#### Replacement behavior

Use `$defaults` when you want to keep the built-ins and add your own entries:

```json
{
  "autoMode": {
    "allow": [
      "$defaults",
      "Running the staging deploy script is allowed."
    ]
  }
}
```

That means: use all built-in `allow` entries, plus the staging rule.

If you omit `$defaults`, you replace the built-ins for that section:

```json
{
  "autoMode": {
    "allow": [
      "Running the staging deploy script is allowed."
    ]
  }
}
```

That means: use only that one `allow` entry. The built-in `allow` entries are not used. Replacing `allow` does not replace `soft_deny`, `hard_deny`, `protectedPaths`, or `environment`.

`$defaults` is not used in `permissions.deny` or `permissions.ask`. Those lists contain only explicit Pi tool patterns.

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

Writes to [protected paths](#protectedpaths) (shell profiles, tool configs, `.git`, `.vscode`, `.pi`, etc.) always go to the classifier, even if an `allow` rule matches. The classifier decides whether to permit the write.

Everything else goes to the classifier. If the classifier is missing, fails, or returns invalid JSON, the action is blocked.

## Examples

- `examples/automode.local.json`: copy to `.pi/automode.local.json` in a project and edit the domains, buckets, and source-control org.

## Development

```bash
npm run check
npm test
npm pack --dry-run
```

The tests cover the risky parts: scoped permission matching, config-source precedence, `$defaults` behavior, config diagnostics, deterministic hard-deny checks, shell parsing for risky bash fragments, classifier JSON parsing, hook-level blocking/allowing, classifier mocking, and protected-path enforcement.

## Known limits

Claude Code's real classifier and exact built-in rules are private. This package implements the documented precedence and configuration behavior, with a local classifier prompt and deterministic hard-deny checks.
