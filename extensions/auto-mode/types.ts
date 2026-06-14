import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type AutoModeSettings = {
  enabled?: boolean;
  classifierModel?: string;
  maxTranscriptLines?: number;
  environment?: unknown;
  allow?: unknown;
  protectedPaths?: unknown;
  soft_deny?: unknown;
  softDeny?: unknown;
  hard_deny?: unknown;
  hardDeny?: unknown;
};

export type SettingsFile = {
  autoMode?: AutoModeSettings;
  permissions?: {
    deny?: unknown;
    ask?: unknown;
  };
};

export type LoadedSettingsFile = {
  path: string;
  settings?: SettingsFile;
  diagnostics: string[];
};

export type ToolPattern = {
  raw: string;
  toolName?: string;
  argumentPattern?: string;
};

export type EffectiveConfig = {
  enabled: boolean;
  classifierModel?: string;
  maxTranscriptLines: number;
  environment: string[];
  allow: string[];
  protectedPaths: string[];
  softDeny: string[];
  hardDeny: string[];
  permissionDeny: ToolPattern[];
  permissionAsk: ToolPattern[];
};

export type AutoModeState = {
  enabledOverride?: boolean;
  classifierModelOverride?: string;
  lastDecision?: "allow" | "block";
  lastReason?: string;
  checkedActions: number;
  blockedActions: number;
  recentDenials: DenialRecord[];
};

export type DenialRecord = {
  timestamp: number;
  toolName: string;
  reason: string;
  action: string;
  kind:
    | "permissions.deny"
    | "permissions.ask"
    | "deterministic-hard-deny"
    | "classifier"
    | "setup";
};

export type ClassificationDecision = {
  decision: "allow" | "block";
  tier: "hard_deny" | "soft_deny" | "allow" | "explicit_intent" | "none";
  reason: string;
};

export type SettingsSources = {
  globalSettings?: SettingsFile[];
  projectLocalSettings?: SettingsFile[];
  projectSharedSettings?: SettingsFile[];
  inlineSettings?: SettingsFile[];
};

export type ConfigLoadResult = {
  config: EffectiveConfig;
  diagnostics: string[];
};

export type ClassifyAction = (
  ctx: ExtensionContext,
  config: EffectiveConfig,
  action: string,
  loadedContext: string,
) => Promise<ClassificationDecision>;
