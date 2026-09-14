import { realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  classifierReasoningForConfig,
  defaultClassifyAction,
  serializeClassifierAction,
} from "./classifier.ts";
import { analyzeBash, type BashAnalysis } from "./bash.ts";
import {
  AUTO_MODE_GUIDANCE,
  DEFAULT_ALLOW,
  DEFAULT_ENVIRONMENT,
  DEFAULT_HARD_DENY,
  DEFAULT_PROTECTED_PATHS,
  DEFAULT_SOFT_DENY,
  PATH_BEARING_TOOLS,
  READ_ONLY_TOOLS,
  piGlobalSettingsPaths,
} from "./constants.ts";
import {
  type GlobalConfigPreparation,
  loadEffectiveConfigWithDiagnostics,
  prepareGlobalConfig,
  writeGlobalClassifierModel,
} from "./config.ts";
import { deterministicHardDeny } from "./hard-deny.ts";
import {
  createLogger,
  newDecisionId,
  resolveLogPath,
  type Logger,
} from "./log.ts";
import { formatModelSpec, parseModelSpec } from "./model.ts";
import { promptForClassifierModel } from "./model-selector.ts";
import {
  matchesAllowedToolPatterns,
  matchesDeniedPath,
  matchesToolPattern,
  matchingBashCommandText,
  recursiveSearchMayReachDeniedPath,
} from "./permissions.ts";
import {
  extractInputPath,
  isInside,
  isProtectedPath,
  resolvePathForPolicy,
  resolveToolInputPath,
} from "./paths.ts";
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
  ClassifierReasoningLog,
  ClassifyAction,
  ClassifyResult,
  ConfigLoadResult,
  DecisionKind,
  DenialRecord,
  EffectiveConfig,
} from "./types.ts";
import { safeJson, truncateMiddle } from "./utils.ts";

const INSPECT_TOOL = "automode_inspect";
const INSPECTION_ACTIONS = ["status", "config", "defaults", "denials"] as const;
type InspectionAction = (typeof INSPECTION_ACTIONS)[number];

function matchedCommandSummary(command: string | undefined): string | undefined {
  return command ? truncateMiddle(command, 500) : undefined;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const EXTENSION_PATH = canonicalPath(fileURLToPath(import.meta.url));
const EXTENSION_ENTRY_PATH = canonicalPath(
  resolve(dirname(EXTENSION_PATH), "../auto-mode.ts"),
);

export function modelVisibleConfigDiagnostics(
  diagnostics: string[],
): string[] {
  return diagnostics.map((diagnostic) =>
    diagnostic.replace(
      /invalid JSON \([\s\S]*\)$/,
      "invalid JSON (parser details omitted from model-visible output)",
    )
  );
}

function projectIsTrusted(
  ctx: { isProjectTrusted?: () => boolean },
): boolean {
  return typeof ctx.isProjectTrusted === "function"
    ? ctx.isProjectTrusted()
    : false;
}

export type PiAutomodeOptions = {
  /** Override config loading in tests. Runtime code uses Pi-owned disk settings. */
  loadConfig?: (cwd: string, projectTrusted: boolean) => EffectiveConfig;
  /** Override classifier calls in tests so unit tests never need a real LLM/API key. */
  classifyAction?: ClassifyAction;
  /** Override classifier-model persistence in tests. Runtime code writes the active global config. */
  saveClassifierModel?: (classifierModel: string) => void;
  /** Override global config migration and path selection in tests. */
  prepareGlobalConfig?: () => GlobalConfigPreparation;
  /** Override the application-owned observability log root in tests. */
  logRoot?: string;
  /** Override the observability log clock in tests. */
  now?: () => Date;
  /** Override Bash analysis in tests. Runtime code uses unbash. */
  analyzeBash?: typeof analyzeBash;
};

type LogCtx = {
  logger: Logger;
  decisionId: string;
  classifierModel?: string;
  reasoning: ClassifierReasoningLog;
};

/** Append ccusage-compatible usage and optional classifier I/O entries. */
function logClassifierIo(decision: ClassifyResult, log: LogCtx): void {
  if (decision.reasoning) log.reasoning = decision.reasoning;
  if (decision.io) log.reasoning = decision.io.reasoning;
  if (!log.logger.enabled || !decision.io) return;

  for (const attempt of decision.io.attempts) {
    const response = attempt.response;
    if (!response) continue;
    log.logger.append({
      type: "message",
      timestamp: new Date(response.timestamp).toISOString(),
      message: {
        role: "assistant",
        model: response.model,
        usage: response.usage,
      },
    });
  }

  if (!log.logger.classifierIo) return;
  log.logger.append({
    type: "classifier",
    ts: new Date().toISOString(),
    decisionId: log.decisionId,
    model: decision.io.model,
    reasoning: decision.io.reasoning,
    prompt: decision.io.prompt,
    attempts: decision.io.attempts,
    durationMs: decision.io.durationMs,
    parsed: {
      decision: decision.decision,
      tier: decision.tier,
      reason: decision.reason,
    },
  });
}

/** Create a Pi extension instance. Default export uses production dependencies. */
export function createPiAutomode(options: PiAutomodeOptions = {}) {
  const classify = options.classifyAction ?? defaultClassifyAction;
  const now = options.now ?? (() => new Date());

  return function piAutomode(pi: ExtensionAPI) {
    const globalConfig = options.prepareGlobalConfig?.() ??
      (options.loadConfig
        ? { status: "current" as const, activePath: piGlobalSettingsPaths()[0] }
        : prepareGlobalConfig());
    const loadConfigWithDiagnostics = (
      cwd: string,
      projectTrusted: boolean,
    ): ConfigLoadResult => {
      const result = options.loadConfig
        ? {
          config: options.loadConfig(cwd, projectTrusted),
          diagnostics: [],
        }
        : loadEffectiveConfigWithDiagnostics(
          cwd,
          projectTrusted,
          globalConfig.activePath,
        );
      return globalConfig.diagnostic
        ? {
          ...result,
          diagnostics: [...result.diagnostics, globalConfig.diagnostic],
        }
        : result;
    };
    const persistClassifierModel = options.saveClassifierModel ??
      ((classifierModel: string) =>
        writeGlobalClassifierModel(classifierModel, globalConfig.activePath));
    const saveClassifierModel = globalConfig.writeBlockedReason
      ? (_classifierModel: string) => {
        throw new Error(globalConfig.writeBlockedReason);
      }
      : persistClassifierModel;
    let loadResult = loadConfigWithDiagnostics(process.cwd(), false);
    let config: EffectiveConfig = loadResult.config;
    let configDiagnostics: string[] = loadResult.diagnostics;
    let state: AutoModeState = {
      checkedActions: 0,
      blockedActions: 0,
      classifierAllowed: 0,
      classifierDenied: 0,
      recentDenials: [],
    };
    let loadedContext = "";
    let globalConfigNoticeShown = false;

    function effectiveConfig(): EffectiveConfig {
      return {
        ...config,
        enabled: state.enabledOverride ?? config.enabled,
      };
    }

    function ownsInspectionTool(): boolean {
      const tool = pi.getAllTools().find(({ name }) => name === INSPECT_TOOL);
      if (!tool) return false;
      const sourcePath = canonicalPath(tool.sourceInfo.path);
      return sourcePath === EXTENSION_PATH || sourcePath === EXTENSION_ENTRY_PATH;
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

    function inspectAutomode(
      action: InspectionAction,
      ctx: ExtensionContext,
    ): unknown {
      const cfg = effectiveConfig();
      if (action === "status") {
        const status = [
          `enabled: ${cfg.enabled ? "yes" : "no"}`,
          `classifier: ${cfg.classifierModel ?? "current session model"}`,
          `classifier reasoning: ${cfg.classifierReasoningLevel ?? "server default"}`,
          `checked actions: ${state.checkedActions}`,
          `blocked actions: ${state.blockedActions}`,
          `classifier allowed: ${state.classifierAllowed}`,
          `classifier denied: ${state.classifierDenied}`,
          `permissions.deny rules: ${cfg.permissionDeny.length}`,
          `permissions.ask rules: ${cfg.permissionAsk.length}`,
          `permissions.allow rules: ${cfg.permissionAllow.length}`,
          `environment entries: ${cfg.environment.length}`,
          `allow entries: ${cfg.allow.length}`,
          `soft_deny entries: ${cfg.softDeny.length}`,
          `hard_deny entries: ${cfg.hardDeny.length}`,
          `last decision: ${state.lastDecision ?? "none"}`,
          "last reason: omitted from model-visible inspection",
        ].join("\n");
        return {
          status,
          state: {
            enabledOverride: state.enabledOverride,
            lastDecision: state.lastDecision,
            checkedActions: state.checkedActions,
            blockedActions: state.blockedActions,
            classifierAllowed: state.classifierAllowed,
            classifierDenied: state.classifierDenied,
          },
        };
      }
      if (action === "config") {
        return {
          config: cfg,
          logFile: resolveLogPath(
            ctx.sessionManager.getSessionFile?.(),
            ctx.sessionManager.getSessionDir?.() ?? "",
            ctx.sessionManager.getSessionId?.() ?? "unknown",
            ctx.cwd,
            options.logRoot,
            now(),
          ),
          diagnostics: modelVisibleConfigDiagnostics(configDiagnostics),
        };
      }
      if (action === "defaults") {
        return {
          environment: DEFAULT_ENVIRONMENT,
          allow: DEFAULT_ALLOW,
          protectedPaths: DEFAULT_PROTECTED_PATHS,
          soft_deny: DEFAULT_SOFT_DENY,
          hard_deny: DEFAULT_HARD_DENY,
        };
      }
      const denials = state.recentDenials.slice().reverse().map((denial) => ({
        timestamp: denial.timestamp,
        kind: denial.kind,
        toolName: denial.toolName,
      }));
      return {
        summary: denials.length === 0
          ? "No recent auto-mode denials."
          : `${denials.length} recent auto-mode denial(s). Reasons and action payloads are omitted.`,
        denials,
      };
    }

    function block(
      ctx: ExtensionContext,
      denial: DenialRecord,
      logCtx: LogCtx,
    ): { block: true; reason: string } {
      state.blockedActions += 1;
      state.lastDecision = "block";
      state.lastReason = denial.reason;
      pushDenial(state, denial);
      persist();
      updateUi(ctx);
      if (logCtx.logger.enabled) {
        logCtx.logger.append({
          type: "decision",
          ts: new Date().toISOString(),
          decisionId: logCtx.decisionId,
          sessionId: ctx.sessionManager.getSessionId?.(),
          cwd: ctx.cwd,
          tool: denial.toolName,
          summary: denial.action,
          kind: denial.kind,
          outcome: "block",
          reason: denial.reason,
          classifierModel: logCtx.classifierModel,
          reasoning: logCtx.reasoning,
        });
      }
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Auto mode blocked ${denial.toolName}: ${denial.reason}`,
          "warning",
        );
      }
      return { block: true, reason: `[pi-automode] ${denial.reason}` };
    }

    function allow(
      ctx: ExtensionContext,
      kind: DecisionKind,
      reason: string,
      toolName: string,
      summary: string,
      logCtx: LogCtx,
    ): undefined {
      state.lastDecision = "allow";
      state.lastReason = reason;
      persist();
      updateUi(ctx);
      if (logCtx.logger.enabled) {
        logCtx.logger.append({
          type: "decision",
          ts: new Date().toISOString(),
          decisionId: logCtx.decisionId,
          sessionId: ctx.sessionManager.getSessionId?.(),
          cwd: ctx.cwd,
          tool: toolName,
          summary,
          kind,
          outcome: "allow",
          reason,
          classifierModel: logCtx.classifierModel,
          reasoning: logCtx.reasoning,
        });
      }
      return undefined;
    }

    pi.on("session_start", (_event, ctx) => {
      loadResult = loadConfigWithDiagnostics(
        ctx.cwd,
        projectIsTrusted(ctx),
      );
      config = loadResult.config;
      configDiagnostics = loadResult.diagnostics;
      state = restoreState(ctx);
      if (
        ctx.hasUI &&
        globalConfig.notification &&
        !globalConfigNoticeShown
      ) {
        ctx.ui.notify(
          globalConfig.notification,
          globalConfig.status === "migrated" ? "info" : "warning",
        );
        globalConfigNoticeShown = true;
      }
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
      // Enforcement order:
      // 1. permission deny/ask rules,
      // 2. deterministic hard-deny checks that never consult the model,
      // 3. extension-owned read-only inspection tool,
      // 4. deterministic path denials,
      // 5. accepted ask rules force classifier review and skip all allow tiers,
      // 6. inside-CWD, permissions.allow, and read-only allow tiers,
      // 7. classifier for every remaining action, fail-closed on setup/parse errors.
      const cfg = effectiveConfig();
      if (!cfg.enabled) return undefined;
      if (ctx.signal?.aborted) return { block: true, reason: "Cancelled" };

      const isOwnedInspection = event.toolName === INSPECT_TOOL &&
        ownsInspectionTool();
      const input = event.input as Record<string, unknown>;
      let bashAnalysis: BashAnalysis | undefined;
      if (event.toolName === "bash") {
        const source = typeof input.command === "string" ? input.command : "";
        try {
          bashAnalysis = (options.analyzeBash ?? analyzeBash)(source);
        } catch (error) {
          bashAnalysis = {
            source,
            commands: [],
            redirects: [],
            redirectTargets: [],
            structure: [],
            allowStructureSafe: false,
            errors: [{
              message: `Bash analysis failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            }],
          };
        }
      }
      const summary = actionSummary(event.toolName, input);
      if (!isOwnedInspection) state.checkedActions += 1;
      const logCtx: LogCtx = {
        logger: createLogger({
          enabled: cfg.log.enabled,
          classifierIo: cfg.log.classifierIo,
          sessionFile: ctx.sessionManager.getSessionFile?.(),
          sessionDir: ctx.sessionManager.getSessionDir?.() ?? "",
          sessionCwd: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionId?.() ?? "unknown",
          logRoot: options.logRoot,
          now: now(),
        }),
        decisionId: newDecisionId(),
        classifierModel: cfg.classifierModel,
        reasoning: classifierReasoningForConfig(cfg.classifierReasoningLevel),
      };

      for (const pattern of cfg.permissionDeny) {
        if (
          matchesToolPattern(
            pattern,
            event.toolName,
            input,
            ctx.cwd,
            "match",
            bashAnalysis,
          )
        ) {
          const matchedCommand = matchedCommandSummary(
            matchingBashCommandText(pattern, bashAnalysis),
          );
          if (isOwnedInspection) state.checkedActions += 1;
          return block(ctx, {
            timestamp: Date.now(),
            toolName: event.toolName,
            reason: `Blocked by permissions.deny: ${pattern.raw}${
              matchedCommand ? `; matched command: ${matchedCommand}` : ""
            }`,
            action: summary,
            kind: "permissions.deny",
          }, logCtx);
        }
      }

      let askRequiresClassifier = false;
      for (const pattern of cfg.permissionAsk) {
        if (
          !matchesToolPattern(
            pattern,
            event.toolName,
            input,
            ctx.cwd,
            "match",
            bashAnalysis,
          )
        ) {
          continue;
        }
        if (!ctx.hasUI) {
          const matchedCommand = matchedCommandSummary(
            matchingBashCommandText(pattern, bashAnalysis),
          );
          if (isOwnedInspection) state.checkedActions += 1;
          return block(ctx, {
            timestamp: Date.now(),
            toolName: event.toolName,
            reason:
              `Matched permissions.ask (${pattern.raw})${
                matchedCommand ? ` for command: ${matchedCommand}` : ""
              } but no UI is available`,
            action: summary,
            kind: "permissions.ask",
          }, logCtx);
        }
        const allowed = await ctx.ui.confirm(
          "Auto mode permission ask",
          `Rule: ${pattern.raw}\n\nAction:\n${summary}\n\nAllow this action to continue to auto-mode classification?`,
          { signal: ctx.signal },
        );
        if (!allowed) {
          const matchedCommand = matchedCommandSummary(
            matchingBashCommandText(pattern, bashAnalysis),
          );
          if (isOwnedInspection) state.checkedActions += 1;
          return block(ctx, {
            timestamp: Date.now(),
            toolName: event.toolName,
            reason: `Declined permissions.ask: ${pattern.raw}${
              matchedCommand ? `; matched command: ${matchedCommand}` : ""
            }`,
            action: summary,
            kind: "permissions.ask",
          }, logCtx);
        }
        askRequiresClassifier = true;
      }

      const deterministicReason = deterministicHardDeny(
        event.toolName,
        input,
        ctx.cwd,
        bashAnalysis,
      );
      if (deterministicReason) {
        if (isOwnedInspection) state.checkedActions += 1;
        return block(ctx, {
          timestamp: Date.now(),
          toolName: event.toolName,
          reason: deterministicReason,
          action: summary,
          kind: "deterministic-hard-deny",
        }, logCtx);
      }

      if (isOwnedInspection && !askRequiresClassifier) return undefined;
      if (isOwnedInspection) state.checkedActions += 1;

      // Deterministic path gate for file tools.
      //
      // `deniedPaths` always applies: a matching path is hard-denied before any
      // classifier or fast path, so secrets and system dirs never reach the
      // model. `allowInsideWorkingDirectory` adds a deterministic silent-allow
      // tier for file tools whose resolved path is inside the working
      // directory, and routes outside-CWD file access to the classifier
      // (bypassing the read-only fast path so reads outside the tree are
      // reviewed too).
      //
      // The gate is skipped entirely when both features are off, so the
      // default configuration costs no extra filesystem calls.
      let readOnlyFastPath =
        !askRequiresClassifier &&
        !cfg.classifyReadOnlyTools &&
        READ_ONLY_TOOLS.has(event.toolName);
      if (
        (cfg.deniedPaths.length > 0 || cfg.allowInsideWorkingDirectory) &&
        PATH_BEARING_TOOLS.has(event.toolName)
      ) {
        const inputPath = extractInputPath(event.toolName, input);
        if (inputPath !== undefined) {
          const resolved =
            resolveToolInputPath(event.toolName, ctx.cwd, inputPath) ??
            inputPath;
          const policyPath = resolvePathForPolicy(resolved) ?? resolved;
          const denied =
            cfg.deniedPaths.length > 0 &&
            (matchesDeniedPath(resolved, cfg.deniedPaths) ||
              matchesDeniedPath(policyPath, cfg.deniedPaths));
          if (denied) {
            return block(ctx, {
              timestamp: Date.now(),
              toolName: event.toolName,
              reason: `Path denied by policy: ${policyPath}`,
              action: summary,
              kind: "deterministic-path-deny",
            }, logCtx);
          }
          let recursiveSearch =
            event.toolName === "grep" || event.toolName === "find";
          if (recursiveSearch) {
            try {
              recursiveSearch = statSync(policyPath).isDirectory();
            } catch {
              // A missing search root will fail in the tool. Treat it as a
              // directory here so a denied scope cannot fail open in a race.
            }
          }
          const deniedSearchScope =
            recursiveSearch &&
            cfg.deniedPaths.length > 0 &&
            (recursiveSearchMayReachDeniedPath(resolved, cfg.deniedPaths) ||
              recursiveSearchMayReachDeniedPath(
                policyPath,
                cfg.deniedPaths,
              ));
          if (deniedSearchScope) {
            return block(ctx, {
              timestamp: Date.now(),
              toolName: event.toolName,
              reason: `Search scope can contain a path denied by policy: ${policyPath}`,
              action: summary,
              kind: "deterministic-path-deny",
            }, logCtx);
          }
          if (cfg.allowInsideWorkingDirectory) {
            const policyCwd = resolvePathForPolicy(ctx.cwd) ?? ctx.cwd;
            if (isInside(policyPath, policyCwd)) {
              // Protected in-tree writes and accepted ask rules must still
              // reach the classifier. They cannot use the inside-CWD tier.
              const protectedWrite =
                (event.toolName === "write" || event.toolName === "edit") &&
                isProtectedPath(policyPath, policyCwd, cfg.protectedPaths);
              if (!askRequiresClassifier && !protectedWrite) {
                return allow(
                  ctx,
                  "inside-working-directory",
                  `Path inside working directory: ${policyPath}`,
                  event.toolName,
                  summary,
                  logCtx,
                );
              }
            }
            // Outside the working directory, protected writes, and accepted
            // ask rules must not use the read-only fast path.
            readOnlyFastPath = false;
          }
        }
      }

      // Deterministic allow tier. It runs after every deterministic denial.
      // Accepted ask rules skip this tier and always reach the classifier.
      if (!askRequiresClassifier) {
        if (
          matchesAllowedToolPatterns(
            cfg.permissionAllow,
            event.toolName,
            input,
            ctx.cwd,
            bashAnalysis,
          )
        ) {
          // A protected-path write/edit is never covered by permissions.allow;
          // it stays on the classifier path (same rule as the inside-CWD tier).
          let protectedWrite = false;
          if (event.toolName === "write" || event.toolName === "edit") {
            const inputPath = extractInputPath(event.toolName, input);
            const resolved = inputPath === undefined
              ? undefined
              : resolveToolInputPath(event.toolName, ctx.cwd, inputPath) ??
                inputPath;
            if (
              resolved !== undefined &&
              isProtectedPath(resolved, ctx.cwd, cfg.protectedPaths)
            ) {
              protectedWrite = true;
            }
          }
          if (!protectedWrite) {
            return allow(
              ctx,
              "permissions.allow",
              "Allowed by permissions.allow",
              event.toolName,
              summary,
              logCtx,
            );
          }
        }
      }

      if (readOnlyFastPath) {
        return allow(
          ctx,
          "read-only",
          `Read-only built-in tool: ${event.toolName}`,
          event.toolName,
          summary,
          logCtx,
        );
      }

      const decision = await classify(
        ctx,
        cfg,
        serializeClassifierAction(event.toolName, input),
        loadedContext,
      );
      logClassifierIo(decision, logCtx);
      if (decision.decision === "allow") {
        state.classifierAllowed += 1;
        return allow(
          ctx,
          "classifier",
          decision.reason,
          event.toolName,
          summary,
          logCtx,
        );
      }

      state.classifierDenied += 1;
      return block(ctx, {
        timestamp: Date.now(),
        toolName: event.toolName,
        reason: decision.reason,
        action: summary,
        kind: "classifier",
      }, logCtx);
    });

    pi.registerTool({
      name: INSPECT_TOOL,
      label: "Inspect Auto Mode",
      description:
        "Inspect the active pi-automode status, effective config, built-in defaults, or recent denial metadata. This tool is read-only and cannot enable, disable, reload, reset, or reconfigure auto mode. Its output is sent to the current model; denial reasons and action payloads are omitted.",
      promptSnippet:
        "Inspect active pi-automode state and diagnostic information without changing it",
      parameters: Type.Object({
        action: StringEnum(INSPECTION_ACTIONS, {
          description: "The read-only auto-mode view to return",
        }),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        if (signal?.aborted) throw new Error("Auto-mode inspection cancelled");
        const result = inspectAutomode(params.action, ctx);
        return {
          content: [{ type: "text", text: safeJson(result, 16000) }],
          details: result,
        };
      },
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
        loadResult = loadConfigWithDiagnostics(
          ctx.cwd,
          projectIsTrusted(ctx),
        );
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
          classifierAllowed: 0,
          classifierDenied: 0,
          recentDenials: [],
          enabledOverride: state.enabledOverride,
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
        const logFile = resolveLogPath(
          ctx.sessionManager.getSessionFile?.(),
          ctx.sessionManager.getSessionDir?.() ?? "",
          ctx.sessionManager.getSessionId?.() ?? "unknown",
          ctx.cwd,
          options.logRoot,
          now(),
        );
        ctx.ui.notify(
          safeJson(
            {
              config: effectiveConfig(),
              logFile,
              diagnostics: configDiagnostics,
            },
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
        const selected = remainder || await promptForClassifierModel(
          ctx,
          effectiveConfig().classifierModel,
        );
        if (!selected) {
          ctx.ui.notify("Classifier model unchanged", "info");
          return;
        }
        const parsed = parseModelSpec(selected);
        const model = parsed
          ? ctx.modelRegistry.find(parsed.provider, parsed.id)
          : undefined;
        if (!model) {
          ctx.ui.notify(`Model not found: ${selected}`, "error");
          return;
        }
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
          ctx.ui.notify(auth.error, "error");
          return;
        }
        const modelSpec = formatModelSpec(model);
        try {
          saveClassifierModel(modelSpec);
        } catch (error) {
          ctx.ui.notify(
            `Failed to save classifier model: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "error",
          );
          return;
        }
        loadResult = loadConfigWithDiagnostics(
          ctx.cwd,
          projectIsTrusted(ctx),
        );
        config = loadResult.config;
        configDiagnostics = loadResult.diagnostics;
        persist();
        updateUi(ctx);
        const active = effectiveConfig().classifierModel ??
          "current session model";
        ctx.ui.notify(
          active === modelSpec
            ? `pi-automode classifier saved globally: ${modelSpec}`
            : `pi-automode classifier saved globally: ${modelSpec}; current config uses ${active}`,
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
