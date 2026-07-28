import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DENIAL_HISTORY_LIMIT } from "./constants.ts";
import type { AutoModeState, DenialRecord, EffectiveConfig } from "./types.ts";
import { safeJson, truncateMiddle } from "./utils.ts";

export function pushDenial(state: AutoModeState, denial: DenialRecord): void {
  state.recentDenials = [
    ...state.recentDenials.slice(-(DENIAL_HISTORY_LIMIT - 1)),
    denial,
  ];
}

export function statusLine(
  config: EffectiveConfig,
  state: AutoModeState,
): string {
  const enabled = state.enabledOverride ?? config.enabled;
  const circle = enabled ? "●" : "○";
  if (config.statusStyle === "off") {
    return `AM ${circle}`;
  }
  const hasActivity = state.checkedActions > 0 || state.blockedActions > 0;
  if (config.statusStyle === "minimal" && !hasActivity) {
    return `AM ${circle}`;
  }
  const allowed = state.checkedActions - state.blockedActions;
  const classifier = state.classifierAllowed > 0 || state.classifierDenied > 0
    ? ` ca:${state.classifierAllowed} cd:${state.classifierDenied}`
    : "";
  return `AM ${circle} a:${allowed} d:${state.blockedActions}${classifier}`;
}

export function statusText(
  config: EffectiveConfig,
  state: AutoModeState,
): string {
  return [
    `enabled: ${(state.enabledOverride ?? config.enabled) ? "yes" : "no"}`,
    `classifier: ${config.classifierModel ?? "current session model"}`,
    `classifier reasoning: ${config.classifierReasoningLevel ?? "server default"}`,
    `checked actions: ${state.checkedActions}`,
    `blocked actions: ${state.blockedActions}`,
    `classifier allowed: ${state.classifierAllowed}`,
    `classifier denied: ${state.classifierDenied}`,
    `permissions.deny rules: ${config.permissionDeny.length}`,
    `permissions.ask rules: ${config.permissionAsk.length}`,
    `environment entries: ${config.environment.length}`,
    `allow entries: ${config.allow.length}`,
    `soft_deny entries: ${config.softDeny.length}`,
    `hard_deny entries: ${config.hardDeny.length}`,
    `last decision: ${state.lastDecision ?? "none"}`,
    `last reason: ${state.lastReason ?? "none"}`,
  ].join("\n");
}

export function formatDenials(state: AutoModeState): string {
  if (state.recentDenials.length === 0) return "No recent auto-mode denials.";
  return state.recentDenials
    .slice()
    .reverse()
    .map(
      (denial) =>
        `${
          new Date(denial.timestamp).toLocaleTimeString()
        } ${denial.kind} ${denial.toolName}: ${denial.reason}\n  ${
          truncateMiddle(denial.action, 300)
        }`,
    )
    .join("\n\n");
}

export function actionSummary(
  toolName: string,
  input: Record<string, unknown>,
): string {
  return `${toolName} ${safeJson(input, 6000)}`;
}

export function restoreState(ctx: ExtensionContext): AutoModeState {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as {
      type?: string;
      customType?: string;
      data?: Partial<AutoModeState>;
    };
    if (
      entry.type !== "custom" ||
      entry.customType !== "pi-automode-state" ||
      !entry.data
    ) {
      continue;
    }
    return {
      enabledOverride: entry.data.enabledOverride,
      lastDecision: entry.data.lastDecision,
      lastReason: entry.data.lastReason,
      checkedActions: entry.data.checkedActions ?? 0,
      blockedActions: entry.data.blockedActions ?? 0,
      classifierAllowed: entry.data.classifierAllowed ?? 0,
      classifierDenied: entry.data.classifierDenied ?? 0,
      recentDenials: Array.isArray(entry.data.recentDenials)
        ? entry.data.recentDenials.slice(-DENIAL_HISTORY_LIMIT)
        : [],
    };
  }
  return { checkedActions: 0, blockedActions: 0, classifierAllowed: 0, classifierDenied: 0, recentDenials: [] };
}
