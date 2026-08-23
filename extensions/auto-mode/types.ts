import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ClassifierReasoningLevel =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type EffectiveClassifierReasoningLevel =
  | "off"
  | "minimal"
  | ClassifierReasoningLevel;

export type ClassifierReasoning =
  | { mode: "server-default" }
  | {
    mode: "explicit";
    requestedLevel: ClassifierReasoningLevel;
    effectiveLevel: EffectiveClassifierReasoningLevel;
  };

export type ClassifierReasoningLog =
  | ClassifierReasoning
  | {
    mode: "explicit";
    requestedLevel: ClassifierReasoningLevel;
    effectiveLevel?: undefined;
  };

/** Observability log configuration. Off by default. */
export type LogConfig = {
  enabled: boolean;
  /** When true, also log classifier prompt/response payloads. */
  classifierIo: boolean;
};

/** Status line verbosity. */
export type StatusStyle = "full" | "minimal" | "off";

export type AutoModeSettings = {
  enabled?: boolean;
  classifierModel?: string;
  classifierReasoningLevel?: ClassifierReasoningLevel;
  /** When true, read-only tools (read/grep/find/ls) are classified instead of auto-allowed. */
  classifyReadOnlyTools?: boolean;
  /** Override the fast-stage completion token budget (default 512). */
  fastClassifierMaxTokens?: number;
  /** Per-request timeout for classifier completions in milliseconds (default 20000). */
  classifierTimeoutMs?: number;
  /** When true, file tools whose resolved path is inside the working directory are allowed deterministically (no classifier), and outside-CWD file access is classified. */
  allowInsideWorkingDirectory?: boolean;
  /** Path glob patterns (file tools) that are always denied before the classifier. Supports `~` and `*` (matches any characters, including `/`). */
  deniedPaths?: unknown;
  maxUserTranscriptTokens?: number;
  maxToolTranscriptTokens?: number;
  statusStyle?: StatusStyle;
  environment?: unknown;
  allow?: unknown;
  protectedPaths?: unknown;
  soft_deny?: unknown;
  softDeny?: unknown;
  hard_deny?: unknown;
  hardDeny?: unknown;
  log?: Partial<LogConfig>;
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
  classifierReasoningLevel?: ClassifierReasoningLevel;
  classifyReadOnlyTools: boolean;
  fastClassifierMaxTokens: number;
  classifierTimeoutMs: number;
  allowInsideWorkingDirectory: boolean;
  deniedPaths: string[];
  maxUserTranscriptTokens: number;
  maxToolTranscriptTokens: number;
  statusStyle: StatusStyle;
  environment: string[];
  allow: string[];
  protectedPaths: string[];
  softDeny: string[];
  hardDeny: string[];
  permissionDeny: ToolPattern[];
  permissionAsk: ToolPattern[];
  log: LogConfig;
};

export type AutoModeState = {
  enabledOverride?: boolean;
  lastDecision?: "allow" | "block";
  lastReason?: string;
  checkedActions: number;
  blockedActions: number;
  classifierAllowed: number;
  classifierDenied: number;
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
    | "deterministic-path-deny"
    | "classifier"
    | "setup";
};

/** Denial kind plus the deterministic allow fast paths, used for decision log entries. */
export type DecisionKind =
  | DenialRecord["kind"]
  | "read-only"
  | "inside-working-directory";

export type ClassificationDecision = {
  decision: "allow" | "block";
  tier: "hard_deny" | "soft_deny" | "allow" | "explicit_intent" | "none";
  reason: string;
};

/** One classifier attempt: the raw model response (or error) and parsed decision. */
export type ClassifierIoAttempt = {
  stage: "fast" | "detailed";
  attempt: number;
  response?: {
    stopReason?: string;
    text: string;
    model: string;
    timestamp: number;
    usage: AssistantMessage["usage"];
    errorMessage?: string;
  };
  parsed?: ClassificationDecision;
  error?: string;
  durationMs: number;
};

/** Full classifier I/O for an action, surfaced for optional observability logging. */
export type ClassifierIo = {
  model: string;
  reasoning: ClassifierReasoning;
  prompt: {
    system: string;
    context: string;
    action: string;
    fastInstruction: string;
    detailedInstruction: string;
  };
  attempts: ClassifierIoAttempt[];
  durationMs: number;
};

/** Classification decision plus resolved reasoning and the I/O that produced it (when available). */
export type ClassifyResult = ClassificationDecision & {
  reasoning?: ClassifierReasoningLog;
  io?: ClassifierIo;
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
) => Promise<ClassifyResult>;
