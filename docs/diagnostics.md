# Agent diagnostics

`automode_inspect` is a model-callable, read-only tool. An agent can use it to inspect active pi-automode state without copied slash-command output.

Use this tool to investigate an unexpected allow or block. Do not use it to change a safety control or to bypass a denial.

## Inspection views

The tool accepts one `action` value.

| Action | Purpose | Result |
| --- | --- | --- |
| `status` | Inspect active state and counters. | A readable status summary and the enabled override, last decision, and action counters. |
| `config` | Inspect the effective configuration. | The active configuration, the resolved observability log path, and configuration diagnostics. |
| `defaults` | Inspect built-in rule lists. | The built-in environment, allow, protected-path, soft-deny, and hard-deny lists. |
| `denials` | Find recent rejected actions. | Reverse-chronological timestamps, enforcement kinds, and tool names. |

The tool reads the same in-memory configuration and state that pi-automode enforces. Configuration changes take effect after session start or `/automode reload`.

## Enforcement behavior

An inspection call is not an unrestricted escape hatch.

1. `permissions.deny` runs first.
2. `permissions.ask` runs next.
3. Deterministic hard-deny checks run next.
4. The extension bypasses classifier routing only for its own registered `automode_inspect` tool.

If a local check blocks the call, pi-automode records it as a blocked action. If the call passes, inspection does not change counters, state, or logs.

The extension verifies the registered tool source before it applies the bypass. A tool from another extension with the same name does not receive this exemption.

The tool cannot enable or disable auto mode, reload configuration, reset state, select a model, or edit configuration. The user must run the related `/automode` command directly.

## Model-visible data

Pi sends tool output to the current model. The output has deliberate privacy limits:

- `status` does not include the last decision reason.
- `denials` does not include denial reasons or action payloads.
- `config` removes the parser detail from invalid JSON diagnostics.

The `config` view returns effective rule text. Do not put credentials, tokens, private keys, signed URLs, or other secrets in pi-automode rules or configuration.

The tool serializes output defensively. Arrays longer than 30 entries become an object with these fields:

```json
{
  "$truncatedArray": true,
  "items": ["first entries"],
  "omittedEntries": 18,
  "totalEntries": 48
}
```

String values and the complete serialized result also have size limits. Treat a truncated result as incomplete. An omitted rule can still exist.

## Observability log path

Use the `config` view to get the log path for the current session. Its `logFile` value uses the same resolution as observability logging:

- A persisted session uses a sidecar beside its Pi session file.
- An in-memory session uses the application-owned log directory for the effective session working directory.

For in-memory sessions, pi-automode uses this default location:

```text
~/.pi/agent/extensions/pi-automode/logs/<encoded-session-cwd>/YYYY-MM-DD/<session-id>-pi-automode.jsonl
```

This includes `--no-session` runs and non-persisted subagents. The path does not use the launching process working directory.

See [Observability logging](observability-logging.md) for log configuration and entry schemas.

## Diagnosis workflow

To tell why Jev is or is not active, read the `config` view: `classifierProvider` shows the selected backend and `jev` shows its thresholds. When the OMP gate misses, `/automode config` diagnostics name the missing condition ("Jev needs Oh My Pi 18.2.4 or newer" or "run `/login typesafe` or set `TYPESAFE_API_KEY`"). The `classifier` observability entry records the acting backend in `provider` and the Jev branch in `jev` (`fallback: none | escalate | classifier | block`).

1. Call `automode_inspect` with `status`, `config`, and `denials`.
2. If observability logging is enabled, use the reported log path.
3. Read a matching decision entry before you propose a rule change.
4. Identify the enforcement layer before you change a rule.
5. If a configuration change is necessary, explain the change.
6. Ask the user to run `/automode off`.
7. Make only the requested configuration change during that maintenance window.
8. Ask the user to run `/automode reload` and `/automode on`.
9. Use `automode_inspect` to make sure that auto mode is enabled.
10. Retry only an action that you know is safe.

Do not replay an unsafe action because auto mode is off. Do not print sensitive tool input or log content in a diagnosis report.
