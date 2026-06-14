import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_ALLOW,
  DEFAULT_ENVIRONMENT,
  DEFAULT_HARD_DENY,
  DEFAULT_MAX_TRANSCRIPT_LINES,
  DEFAULT_PROTECTED_PATHS,
  DEFAULT_SOFT_DENY,
  PI_GLOBAL_SETTINGS,
  PI_PROJECT_LOCAL_SETTINGS,
  PI_PROJECT_SHARED_SETTINGS,
} from "./constants.ts";
import { parseToolPattern } from "./permissions.ts";
import type {
  AutoModeSettings,
  ConfigLoadResult,
  EffectiveConfig,
  LoadedSettingsFile,
  SettingsFile,
  SettingsSources,
  ToolPattern,
} from "./types.ts";
import { hasOwn, stringArray } from "./utils.ts";

function readSettingsFile(path: string): LoadedSettingsFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const settings = JSON.parse(readFileSync(path, "utf8")) as SettingsFile;
    return {
      path,
      settings,
      diagnostics: validateSettingsFile(settings, path),
    };
  } catch (error) {
    return {
      path,
      diagnostics: [
        `${path}: invalid JSON (${
          error instanceof Error ? error.message : String(error)
        })`,
      ],
    };
  }
}

function validateStringArraySetting(
  value: unknown,
  source: string,
  key: string,
  diagnostics: string[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    diagnostics.push(`${source}: ${key} must be an array of strings`);
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim() === "") {
      diagnostics.push(
        `${source}: ${key}[${index}] must be a non-empty string`,
      );
    }
  }
  if (value.length > 0 && !value.includes("$defaults")) {
    diagnostics.push(
      `${source}: ${key} omits "$defaults" and replaces the built-in ${key} rules`,
    );
  }
}

/** Validate config shape and emit human-readable diagnostics for `/automode config`. */
export function validateSettingsFile(
  settings: SettingsFile,
  source: string,
): string[] {
  const diagnostics: string[] = [];
  const root = settings as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (key !== "autoMode" && key !== "permissions") {
      diagnostics.push(`${source}: unknown top-level key ${key}`);
    }
  }

  if (settings.autoMode !== undefined) {
    if (
      !settings.autoMode ||
      typeof settings.autoMode !== "object" ||
      Array.isArray(settings.autoMode)
    ) {
      diagnostics.push(`${source}: autoMode must be an object`);
    } else {
      const autoMode = settings.autoMode as Record<string, unknown>;
      const knownAutoMode = new Set([
        "enabled",
        "classifierModel",
        "maxTranscriptLines",
        "environment",
        "allow",
        "protectedPaths",
        "soft_deny",
        "softDeny",
        "hard_deny",
        "hardDeny",
      ]);
      for (const key of Object.keys(autoMode)) {
        if (!knownAutoMode.has(key)) {
          diagnostics.push(`${source}: unknown autoMode key ${key}`);
        }
      }
      if (
        hasOwn(autoMode, "enabled") && typeof autoMode.enabled !== "boolean"
      ) {
        diagnostics.push(`${source}: autoMode.enabled must be a boolean`);
      }
      if (
        hasOwn(autoMode, "classifierModel") &&
        typeof autoMode.classifierModel !== "string"
      ) {
        diagnostics.push(
          `${source}: autoMode.classifierModel must be a provider/model string`,
        );
      }
      if (
        hasOwn(autoMode, "maxTranscriptLines") &&
        (!Number.isInteger(autoMode.maxTranscriptLines) ||
          Number(autoMode.maxTranscriptLines) <= 0)
      ) {
        diagnostics.push(
          `${source}: autoMode.maxTranscriptLines must be a positive integer`,
        );
      }
      validateStringArraySetting(
        autoMode.environment,
        source,
        "autoMode.environment",
        diagnostics,
      );
      validateStringArraySetting(
        autoMode.allow,
        source,
        "autoMode.allow",
        diagnostics,
      );
      validateStringArraySetting(
        autoMode.protectedPaths,
        source,
        "autoMode.protectedPaths",
        diagnostics,
      );
      validateStringArraySetting(
        autoMode.soft_deny ?? autoMode.softDeny,
        source,
        "autoMode.soft_deny",
        diagnostics,
      );
      validateStringArraySetting(
        autoMode.hard_deny ?? autoMode.hardDeny,
        source,
        "autoMode.hard_deny",
        diagnostics,
      );
    }
  }

  if (settings.permissions !== undefined) {
    if (
      !settings.permissions ||
      typeof settings.permissions !== "object" ||
      Array.isArray(settings.permissions)
    ) {
      diagnostics.push(`${source}: permissions must be an object`);
    } else {
      const permissions = settings.permissions as Record<string, unknown>;
      for (const key of Object.keys(permissions)) {
        if (key !== "deny" && key !== "ask") {
          diagnostics.push(`${source}: unknown permissions key ${key}`);
        }
      }
      for (const key of ["deny", "ask"] as const) {
        const value = permissions[key];
        if (value === undefined) continue;
        if (!Array.isArray(value)) {
          diagnostics.push(
            `${source}: permissions.${key} must be an array of tool patterns`,
          );
          continue;
        }
        for (const [index, entry] of value.entries()) {
          if (typeof entry !== "string" || !parseToolPattern(entry)) {
            diagnostics.push(
              `${source}: permissions.${key}[${index}] must be a tool pattern string`,
            );
          }
        }
      }
    }
  }

  return diagnostics;
}

type RuleAccumulator = {
  defaults: string[];
  includeDefaults: boolean;
  seen: boolean;
  entries: string[];
};

function createRuleAccumulator(defaults: string[]): RuleAccumulator {
  return { defaults, includeDefaults: true, seen: false, entries: [] };
}

function applyRuleSetting(accumulator: RuleAccumulator, value: unknown): void {
  const entries = stringArray(value);
  if (!entries) return;
  accumulator.seen = true;
  accumulator.includeDefaults = entries.includes("$defaults");
  for (const entry of entries) {
    if (entry !== "$defaults") accumulator.entries.push(entry);
  }
}

function finalizeRuleSetting(accumulator: RuleAccumulator): string[] {
  const base = accumulator.includeDefaults || !accumulator.seen
    ? accumulator.defaults
    : [];
  return [...new Set([...base, ...accumulator.entries])];
}

function applyAutoModeScalars(
  base: EffectiveConfig,
  settings: AutoModeSettings | undefined,
): EffectiveConfig {
  if (!settings) return base;
  return {
    ...base,
    enabled: settings.enabled ?? base.enabled,
    classifierModel: settings.classifierModel ?? base.classifierModel,
    maxTranscriptLines: settings.maxTranscriptLines ?? base.maxTranscriptLines,
  };
}

function appendPermissionPatterns(
  target: ToolPattern[],
  settings: SettingsFile | undefined,
  key: "deny" | "ask",
): void {
  const values = stringArray(settings?.permissions?.[key]);
  if (!values) return;
  for (const value of values) {
    const pattern = parseToolPattern(value);
    if (pattern) target.push(pattern);
  }
}

/**
 * Merge settings with Claude Code-style precedence using Pi-owned config files.
 *
 * Important details:
 * - shared project `.pi/automode.json` contributes `permissions.*` but not `autoMode`,
 *   so a checked-in repo cannot weaken classifier rules;
 * - global, project-local, and inline `autoMode` settings combine additively across scopes;
 * - omitting `$defaults` in any scope for a rule list means "replace built-ins" for that list.
 */
export function buildEffectiveConfigFromSources(
  sources: SettingsSources = {},
): EffectiveConfig {
  let config: EffectiveConfig = {
    enabled: true,
    maxTranscriptLines: DEFAULT_MAX_TRANSCRIPT_LINES,
    environment: [...DEFAULT_ENVIRONMENT],
    allow: [...DEFAULT_ALLOW],
    protectedPaths: [...DEFAULT_PROTECTED_PATHS],
    softDeny: [...DEFAULT_SOFT_DENY],
    hardDeny: [...DEFAULT_HARD_DENY],
    permissionDeny: [],
    permissionAsk: [],
  };

  const globalSettings = sources.globalSettings ?? [];
  const projectLocalSettings = sources.projectLocalSettings ?? [];
  const projectSharedSettings = sources.projectSharedSettings ?? [];
  const inlineSettings = sources.inlineSettings ?? [];

  const configurableSettings = [
    ...globalSettings,
    ...projectLocalSettings,
    ...inlineSettings,
  ];
  const environment = createRuleAccumulator(DEFAULT_ENVIRONMENT);
  const allow = createRuleAccumulator(DEFAULT_ALLOW);
  const protectedPaths = createRuleAccumulator(DEFAULT_PROTECTED_PATHS);
  const softDeny = createRuleAccumulator(DEFAULT_SOFT_DENY);
  const hardDeny = createRuleAccumulator(DEFAULT_HARD_DENY);

  for (const settings of configurableSettings) {
    config = applyAutoModeScalars(config, settings.autoMode);
    applyRuleSetting(environment, settings.autoMode?.environment);
    applyRuleSetting(allow, settings.autoMode?.allow);
    applyRuleSetting(protectedPaths, settings.autoMode?.protectedPaths);
    applyRuleSetting(
      softDeny,
      settings.autoMode?.soft_deny ?? settings.autoMode?.softDeny,
    );
    applyRuleSetting(
      hardDeny,
      settings.autoMode?.hard_deny ?? settings.autoMode?.hardDeny,
    );
  }

  config = {
    ...config,
    environment: finalizeRuleSetting(environment),
    allow: finalizeRuleSetting(allow),
    protectedPaths: finalizeRuleSetting(protectedPaths),
    softDeny: finalizeRuleSetting(softDeny),
    hardDeny: finalizeRuleSetting(hardDeny),
  };

  for (
    const settings of [
      ...globalSettings,
      ...projectSharedSettings,
      ...projectLocalSettings,
      ...inlineSettings,
    ]
  ) {
    appendPermissionPatterns(config.permissionDeny, settings, "deny");
    appendPermissionPatterns(config.permissionAsk, settings, "ask");
  }

  return config;
}

function loadedSettingsToSettings(
  files: Array<LoadedSettingsFile | undefined>,
): SettingsFile[] {
  return files.flatMap((file) => (file?.settings ? [file.settings] : []));
}

function loadedSettingsDiagnostics(
  files: Array<LoadedSettingsFile | undefined>,
): string[] {
  return files.flatMap((file) => file?.diagnostics ?? []);
}

/** Load config from disk and environment variables, including diagnostics for `/automode config`. */
export function loadEffectiveConfigWithDiagnostics(
  cwd: string,
): ConfigLoadResult {
  const inlineSettings: SettingsFile[] = [];
  const diagnostics: string[] = [];
  if (process.env.PI_AUTOMODE_SETTINGS_JSON) {
    try {
      const parsed = JSON.parse(
        process.env.PI_AUTOMODE_SETTINGS_JSON,
      ) as SettingsFile;
      inlineSettings.push(parsed);
      diagnostics.push(
        ...validateSettingsFile(parsed, "PI_AUTOMODE_SETTINGS_JSON"),
      );
    } catch (error) {
      diagnostics.push(
        `PI_AUTOMODE_SETTINGS_JSON: invalid JSON (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }

  const globalFiles = PI_GLOBAL_SETTINGS.map(readSettingsFile);
  const projectLocalFiles = PI_PROJECT_LOCAL_SETTINGS.map((file) =>
    readSettingsFile(resolve(cwd, file))
  );
  const projectSharedFiles = PI_PROJECT_SHARED_SETTINGS.map((file) =>
    readSettingsFile(resolve(cwd, file))
  );
  const fileDiagnostics = loadedSettingsDiagnostics([
    ...globalFiles,
    ...projectLocalFiles,
    ...projectSharedFiles,
  ]);

  return {
    config: buildEffectiveConfigFromSources({
      globalSettings: loadedSettingsToSettings(globalFiles),
      projectLocalSettings: loadedSettingsToSettings(projectLocalFiles),
      projectSharedSettings: loadedSettingsToSettings(projectSharedFiles),
      inlineSettings,
    }),
    diagnostics: [...fileDiagnostics, ...diagnostics],
  };
}

/** Load config from disk and environment variables. Exported for tests and diagnostics. */
export function loadEffectiveConfig(cwd: string): EffectiveConfig {
  return loadEffectiveConfigWithDiagnostics(cwd).config;
}
