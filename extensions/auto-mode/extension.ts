import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { defaultClassifyAction } from "./classifier.ts";
import {
  AUTO_MODE_GUIDANCE,
  DEFAULT_ALLOW,
  DEFAULT_ENVIRONMENT,
  DEFAULT_HARD_DENY,
  DEFAULT_PROTECTED_PATHS,
  DEFAULT_SOFT_DENY,
  READ_ONLY_TOOLS,
} from "./constants.ts";
import {
  loadEffectiveConfig,
  loadEffectiveConfigWithDiagnostics,
} from "./config.ts";
import { deterministicHardDeny } from "./hard-deny.ts";
import { formatModelSpec, parseModelSpec } from "./model.ts";
import { promptForClassifierModel } from "./model-selector.ts";
import { matchesToolPattern } from "./permissions.ts";
import { isProtectedPath, resolveInputPath } from "./paths.ts";
import {
  actionSummary,
  formatDenials,
  pushDenial,
  restoreState,
  statusLine,
  statusText,
} from "./state.ts";
import { loadedContextFromSystemPromptOptions } from "./transcript.ts";
import type {
  AutoModeState,
  ClassifyAction,
  ConfigLoadResult,
  DenialRecord,
  EffectiveConfig,
} from "./types.ts";
import { safeJson } from "./utils.ts";

export type PiAutomodeOptions = {
  /** Override config loading in tests. Runtime code uses Pi-owned disk settings. */
  loadConfig?: (cwd: string) => EffectiveConfig;
  /** Override classifier calls in tests so unit tests never need a real LLM/API key. */
  classifyAction?: ClassifyAction;
};

/** Create a Pi extension instance. Default export uses production dependencies. */
export function createPiAutomode(options: PiAutomodeOptions = {}) {
  const loadConfigWithDiagnostics = options.loadConfig
    ? (cwd: string): ConfigLoadResult => ({
      config: options.loadConfig?.(cwd) ?? loadEffectiveConfig(cwd),
      diagnostics: [],
    })
    : loadEffectiveConfigWithDiagnostics;
  const classify = options.classifyAction ?? defaultClassifyAction;

  return function piAutomode(pi: ExtensionAPI) {
    let loadResult = loadConfigWithDiagnostics(process.cwd());
    let config: EffectiveConfig = loadResult.config;
    let configDiagnostics: string[] = loadResult.diagnostics;
    let state: AutoModeState = {
      checkedActions: 0,
      blockedActions: 0,
      recentDenials: [],
    };
    let loadedContext = "";

    function effectiveConfig(): EffectiveConfig {
      return {
        ...config,
        enabled: state.enabledOverride ?? config.enabled,
        classifierModel: state.classifierModelOverride ??
          config.classifierModel,
      };
    }

    function persist(): void {
      pi.appendEntry("pi-automode-state", state);
    }

    function updateUi(ctx: ExtensionContext): void {
      if (!ctx.hasUI) return;
      const cfg = effectiveConfig();
      const text = statusLine(cfg, state);
      ctx.ui.setStatus(
        "pi-automode",
        cfg.enabled
          ? ctx.ui.theme.fg("accent", text)
          : ctx.ui.theme.fg("dim", text),
      );
    }

    function block(
      ctx: ExtensionContext,
      denial: DenialRecord,
    ): { block: true; reason: string } {
      state.blockedActions += 1;
      state.lastDecision = "block";
      state.lastReason = denial.reason;
      pushDenial(state, denial);
      persist();
      updateUi(ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Auto mode blocked ${denial.toolName}: ${denial.reason}`,
          "warning",
        );
      }
      return { block: true, reason: `[pi-automode] ${denial.reason}` };
    }

    pi.on("session_start", (_event, ctx) => {
      loadResult = loadConfigWithDiagnostics(ctx.cwd);
      config = loadResult.config;
      configDiagnostics = loadResult.diagnostics;
      state = restoreState(ctx);
      updateUi(ctx);
    });

    pi.on("before_agent_start", (event) => {
      const cfg = effectiveConfig();
      if (!cfg.enabled) return undefined;
      loadedContext = loadedContextFromSystemPromptOptions(
        event.systemPromptOptions,
      );
      return { systemPrompt: `${event.systemPrompt}\n\n${AUTO_MODE_GUIDANCE}` };
    });

    pi.on("tool_call", async (event, ctx) => {
      // Enforcement order mirrors Claude Code's documented model:
      // 1. permission deny/ask rules,
      // 2. deterministic hard-deny checks that never consult the model,
      // 3. read-only fast path,
      // 4. classifier for every remaining action, fail-closed on setup/parse errors.
      const cfg = effectiveConfig();
      if (!cfg.enabled) return undefined;
      if (ctx.signal?.aborted) return { block: true, reason: "Cancelled" };

      const input = event.input as Record<string, unknown>;
      const summary = actionSummary(event.toolName, input);
      state.checkedActions += 1;

      for (const pattern of cfg.permissionDeny) {
        if (matchesToolPattern(pattern, event.toolName, input, ctx.cwd)) {
          return block(ctx, {
            timestamp: Date.now(),
            toolName: event.toolName,
            reason: `Blocked by permissions.deny: ${pattern.raw}`,
            action: summary,
            kind: "permissions.deny",
          });
        }
      }

      for (const pattern of cfg.permissionAsk) {
        if (!matchesToolPattern(pattern, event.toolName, input, ctx.cwd)) {
          continue;
        }
        if (!ctx.hasUI) {
          return block(ctx, {
            timestamp: Date.now(),
            toolName: event.toolName,
            reason:
              `Matched permissions.ask (${pattern.raw}) but no UI is available`,
            action: summary,
            kind: "permissions.ask",
          });
        }
        const allowed = await ctx.ui.confirm(
          "Auto mode permission ask",
          `Rule: ${pattern.raw}\n\nAction:\n${summary}\n\nAllow this action to continue to auto-mode classification?`,
          { signal: ctx.signal },
        );
        if (!allowed) {
          return block(ctx, {
            timestamp: Date.now(),
            toolName: event.toolName,
            reason: `Declined permissions.ask: ${pattern.raw}`,
            action: summary,
            kind: "permissions.ask",
          });
        }
      }

      const deterministicReason = deterministicHardDeny(
        event.toolName,
        input,
        ctx.cwd,
      );
      if (deterministicReason) {
        return block(ctx, {
          timestamp: Date.now(),
          toolName: event.toolName,
          reason: deterministicReason,
          action: summary,
          kind: "deterministic-hard-deny",
        });
      }

      if (READ_ONLY_TOOLS.has(event.toolName)) {
        state.lastDecision = "allow";
        state.lastReason = `Read-only built-in tool: ${event.toolName}`;
        persist();
        updateUi(ctx);
        return undefined;
      }

      // Protected paths go to the classifier regardless of allow rules.
      if (event.toolName === "write" || event.toolName === "edit") {
        const path = resolveInputPath(ctx.cwd, input.path);
        if (path && isProtectedPath(path, ctx.cwd, cfg.protectedPaths)) {
          const decision = await classify(ctx, cfg, summary, loadedContext);
          if (decision.decision === "allow") {
            state.lastDecision = "allow";
            state.lastReason = decision.reason;
            persist();
            updateUi(ctx);
            return undefined;
          }
          return block(ctx, {
            timestamp: Date.now(),
            toolName: event.toolName,
            reason: decision.reason,
            action: summary,
            kind: "classifier",
          });
        }
      }

      const decision = await classify(ctx, cfg, summary, loadedContext);
      if (decision.decision === "allow") {
        state.lastDecision = "allow";
        state.lastReason = decision.reason;
        persist();
        updateUi(ctx);
        return undefined;
      }

      return block(ctx, {
        timestamp: Date.now(),
        toolName: event.toolName,
        reason: decision.reason,
        action: summary,
        kind: "classifier",
      });
    });

    async function handleAutomodeCommand(
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const [command = "status", ...rest] = args
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const remainder = rest.join(" ").trim();

      if (command === "status") {
        ctx.ui.notify(statusText(effectiveConfig(), state), "info");
        return;
      }
      if (command === "on") {
        state.enabledOverride = true;
        persist();
        updateUi(ctx);
        ctx.ui.notify("pi-automode enabled for this session", "info");
        return;
      }
      if (command === "off") {
        state.enabledOverride = false;
        persist();
        updateUi(ctx);
        ctx.ui.notify("pi-automode disabled for this session", "warning");
        return;
      }
      if (command === "reload") {
        loadResult = loadConfigWithDiagnostics(ctx.cwd);
        config = loadResult.config;
        configDiagnostics = loadResult.diagnostics;
        persist();
        updateUi(ctx);
        ctx.ui.notify(
          "pi-automode config reloaded",
          configDiagnostics.length > 0 ? "warning" : "info",
        );
        return;
      }
      if (command === "reset") {
        state = {
          checkedActions: 0,
          blockedActions: 0,
          recentDenials: [],
          enabledOverride: state.enabledOverride,
          classifierModelOverride: state.classifierModelOverride,
        };
        persist();
        updateUi(ctx);
        ctx.ui.notify("pi-automode counters reset", "info");
        return;
      }
      if (command === "defaults") {
        ctx.ui.notify(
          safeJson(
            {
              environment: DEFAULT_ENVIRONMENT,
              allow: DEFAULT_ALLOW,
              protectedPaths: DEFAULT_PROTECTED_PATHS,
              soft_deny: DEFAULT_SOFT_DENY,
              hard_deny: DEFAULT_HARD_DENY,
            },
            12000,
          ),
          "info",
        );
        return;
      }
      if (command === "config") {
        ctx.ui.notify(
          safeJson(
            { config: effectiveConfig(), diagnostics: configDiagnostics },
            16000,
          ),
          configDiagnostics.length > 0 ? "warning" : "info",
        );
        return;
      }
      if (command === "denials") {
        ctx.ui.notify(
          formatDenials(state),
          state.recentDenials.length > 0 ? "warning" : "info",
        );
        return;
      }
      if (command === "model") {
        if (!remainder) {
          const selected = await promptForClassifierModel(
            ctx,
            effectiveConfig().classifierModel ?? state.classifierModelOverride,
          );
          if (!selected) {
            ctx.ui.notify("Classifier model unchanged", "info");
            return;
          }
          const parsed = parseModelSpec(selected);
          const model = parsed
            ? ctx.modelRegistry.find(parsed.provider, parsed.id)
            : undefined;
          if (model) {
            state.classifierModelOverride = selected;
            persist();
            updateUi(ctx);
            ctx.ui.notify(
              `pi-automode classifier set for this session: ${selected}`,
              "info",
            );
          }
          return;
        }
        const parsed = parseModelSpec(remainder);
        const model = parsed
          ? ctx.modelRegistry.find(parsed.provider, parsed.id)
          : undefined;
        if (!model) {
          ctx.ui.notify(`Model not found: ${remainder}`, "error");
          return;
        }
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
          ctx.ui.notify(auth.error, "error");
          return;
        }
        state.classifierModelOverride = formatModelSpec(model);
        persist();
        updateUi(ctx);
        ctx.ui.notify(
          `pi-automode classifier set for this session: ${state.classifierModelOverride}`,
          "info",
        );
        return;
      }

      ctx.ui.notify(
        "Usage: /automode [status|on|off|reload|reset|defaults|config|denials|model [provider/id]]",
        "error",
      );
    }

    pi.registerCommand("automode", {
      description:
        "Control pi-automode: status, on, off, reload, reset, defaults, config, denials, model",
      handler: handleAutomodeCommand,
    });

    pi.registerCommand("auto-mode", {
      description: "Alias for /automode",
      handler: handleAutomodeCommand,
    });
  };
}
