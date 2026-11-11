# Defaults and rule-list behavior

## `$defaults`

`$defaults` expands to the built-in entries for its section. It is section-local. In `allow`, it means the built-in allow rules, not the built-in hard-deny rules.

### `environment`

`$defaults` expands to:

- trusted repo: the repository Pi started in and its configured git remotes
- source control: the trusted repo and its configured remotes only
- trusted internal domains: none configured
- trusted cloud buckets: none configured
- key internal services: none configured

If the classifier needs information about trusted company infrastructure, add entries such as these:

```json
{
  "autoMode": {
    "environment": [
      "$defaults",
      "Trusted internal domains: *.corp.example.com, git.example.com",
      "Trusted cloud buckets: s3://acme-dev-artifacts, gs://acme-ci-cache",
      "Key internal services: staging deploy API at deploy.corp.example.com"
    ]
  }
}
```

These entries give the classifier context. They do not bypass `hard_deny` or automatically allow every action involving those services.

### `allow`

`$defaults` expands to allow exceptions for:

- read-only operations: inspecting files, listing directories, searching, GET requests, and state queries that do not expose secrets
- local development inside the working tree: creating, editing, building, testing, linting, formatting, and deleting files created during the current task
- modifying or deleting pre-existing local files with bounded direct user authorization
- installing dependencies already declared in package manifests or lockfiles
- using standard credentials only with their intended configured providers
- pushing to the current non-default working branch or a new branch created for the task
- bootstrapping language/toolchain installers from official sources

These are exceptions to `soft_deny`, not to `hard_deny`.

### `protectedPaths`

`$defaults` expands to safety-sensitive paths. In the default configuration, every `write` and `edit` call goes to the classifier. Thus, `protectedPaths` does not change classifier routing by default. Pi-automode retains the list for compatibility and inspection.

The value `allowInsideWorkingDirectory: true` sends non-protected in-tree file access to the deterministic allow tier. Writes and edits to protected paths still reach the classifier. Classifier `allow` rules cannot override a classifier hard-deny decision.

Protected directories: `.git`, `.config/git`, `.vscode`, `.idea`, `.husky`, `.cargo`, `.devcontainer`, `.yarn`, `.mvn`, `.pi`.

Protected files include:

- Git files: `.gitconfig`, `.gitmodules`, `.gitignore`, and `.gitattributes`
- Bash files: `.bashrc`, `.bash_profile`, `.bash_login`, `.bash_aliases`, and `.bash_logout`
- Zsh files: `.zshrc`, `.zprofile`, `.zshenv`, `.zlogin`, and `.zlogout`
- other shell files: `.profile` and `.envrc`
- package-manager files: `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pnp.cjs`, `.pnp.loader.mjs`, and `.pnpmfile.cjs`
- Bun files: `bunfig.toml` and `.bunfig.toml`
- Bazel files: `.bazelrc`, `.bazelversion`, and `.bazeliskrc`
- hook files: `.pre-commit-config.yaml`, `lefthook.yml`, `lefthook.yaml`, `.lefthook.yml`, and `.lefthook.yaml`
- wrapper files: `gradle-wrapper.properties` and `maven-wrapper.properties`
- other control files: `.devcontainer.json`, `.ripgreprc`, `pyrightconfig.json`, and `.mcp.json`

Read-only tools remain locally allowed after permission and deterministic checks. These tools are `read`, `grep`, `find`, and `ls`.

In the default configuration, all writes and edits require classification. The value `allowInsideWorkingDirectory: true` allows non-protected in-tree access locally.

Protected in-tree writes and edits still require classification. All out-of-tree file access also requires classification.

### `deniedPaths`

`deniedPaths` is an optional list of path glob patterns. The default list is empty, and it has no built-in entries. Thus, `$defaults` has no effect in this list.

A matching pattern blocks a file-tool call before classifier review or an allow tier. The file tools are `read`, `write`, `edit`, `grep`, `find`, and `ls`.

Use this list for secrets and system paths that file tools must not send to the model. The classifier continues to govern `bash` access.

Patterns support `~`, `$HOME`, and `${HOME}` expansion. The `*` wildcard matches all characters, including `/`. Pi-automode matches the typed path and its symlink-resolved form. `deniedPaths` can only restrict access.

### `soft_deny`

`$defaults` expands to soft blocks for:

- force push, remote branch deletion, remote history rewrite, or direct push to `main`, `master`, or the default branch
- downloading and executing external code, including `curl | bash` and `wget | sh`
- production deploys, production database migrations, or production infrastructure changes
- deleting, truncating, or overwriting local files that existed before session start without a bounded user authorization
- mass modification/deletion in cloud storage, ticketing systems, collaboration tools, or external APIs
- writing through remote shells such as `ssh`, `kubectl exec`, or `docker exec` on shared or production hosts
- changing shared or live infrastructure without its normal preview, plan, dry run, or review
- killing other users' processes, cancelling shared jobs, or disrupting shared infrastructure
- exposing local files, sockets, credentials, or internal services through a network service
- outbound messages, purchases, bookings, subscriptions, or other real-world transactions

Soft blocks can be overridden by a matching `allow` exception or direct user intent. For a pre-existing local file, direct user intent must name the task, one repository or worktree, permitted path scopes, and an allowed operation. The action must stay inside those bounds. Other soft blocks need direct user intent but do not require these file bounds. A later user instruction that narrows or revokes authorization controls.

### `hard_deny`

`$defaults` expands to unconditional blocks for:

- weakening TLS, certificate validation, authentication, authorization, audit logging, or other security controls
- adding persistence such as SSH keys, shell profile edits, cron jobs, launch agents, login items, or background agents
- granting admin, owner, IAM, RBAC, repository, or production access
- exfiltrating repository contents, secrets, credentials, private keys, tokens, or internal data to untrusted places
- scanning for credentials, tokens, private keys, or secrets beyond what the task requires
- tampering with logs, audit trails, security monitoring, permission rules, auto-mode configuration, or safety-control files
- creating services, endpoints, workflows, or autonomous agents that execute arbitrary code without meaningful approval
- posting or updating public/external content that is fabricated, misleading, impersonating a user, or claiming approval/action that did not happen

Hard-deny rules cannot be overridden by `allow` or by user intent.

### Classifier transcript budgets

Classifier evidence has separate approximate-token budgets:

- `maxUserTranscriptTokens`: 4000
- `maxToolTranscriptTokens`: 4000
- `maxToolResultTranscriptTokens`: 2000 (requires `includeToolResults: true`)

The selector keeps the first and latest user messages as intent anchors. It fills the remaining space from the newest eligible entries.

The selector limits individual entries. It marks omitted or truncated evidence in the classifier transcript. Assistant prose is excluded. Tool results are excluded by default.

With `includeToolResults: true`, the selector keeps at most 40 results. Each result is limited to 1000 approximate tokens.

These limits use approximate character counts. They do not guarantee the same result as a provider tokenizer.

To change a limit, set an integer of at least 32 in a Pi-owned `autoMode` configuration source. Pi-automode does not support the former `maxTranscriptLines` field.

### Classifier request timeout

`classifierTimeoutMs` limits each classifier request in milliseconds. The fast and detailed stages have separate budgets. The default is 20000.

If a request exceeds its budget, pi-automode aborts the attempt. Then auto mode fails closed and blocks the action.

To change the timeout, set an integer of at least 1000 in a Pi-owned `autoMode` configuration source.

### Replacement behavior

If you want to keep the built-ins and add entries, use `$defaults`:

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

This configuration uses all built-in `allow` entries and the staging rule.

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

This configuration uses only the staging rule. It does not use the built-in `allow` entries.

Replacing `allow` does not replace `soft_deny`, `hard_deny`, `protectedPaths`, or `environment`.

`permissions.deny`, `permissions.ask`, and `permissions.allow` do not support `$defaults`. These lists contain only explicit Pi tool patterns. All three lists default to `[]`.

Global, project-local, and inline configuration can add all three permission lists. Shared project configuration can add only deny and ask rules.

`autoMode.allow` and `permissions.allow` are different. `autoMode.allow` contains prose exceptions that the classifier weighs against soft-deny rules. `permissions.allow` contains tool patterns that skip classifier review.

