import { isAbsolute, resolve } from "node:path";
import {
  analyzeBash,
  type BashAnalysis,
  type BashCommandAnalysis,
  type BashRedirectAnalysis,
} from "./bash.ts";
import type { ToolPattern } from "./types.ts";
import {
  expandHomePattern,
  extractToolPaths,
  normalizePathForMatch,
  resolveInputPath,
  resolvePathForPolicy,
} from "./paths.ts";

export const MAX_WILDCARD_PATTERN_LENGTH = 4096;
export const MAX_WILDCARD_INPUT_LENGTH = 1024 * 1024;

const bashPatternAnalyses = new WeakMap<ToolPattern, BashAnalysis>();

/** Preserve the previous non-Unicode RegExp `/i` case-equivalence rules. */
function canonicalizeCase(value: string): string {
  let canonical = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    const uppercase = character.toUpperCase();
    if (
      uppercase.length !== 1 ||
      (character.charCodeAt(0) >= 128 && uppercase.charCodeAt(0) < 128)
    ) {
      canonical += character;
    } else {
      canonical += uppercase;
    }
  }
  return canonical;
}

function normalizeToolName(name: string): string {
  const lower = name.trim().replace(/^@/, "").toLowerCase();
  const aliases: Record<string, string> = {
    bash: "bash",
    read: "read",
    edit: "edit",
    write: "write",
    grep: "grep",
    find: "find",
    ls: "ls",
  };
  return aliases[lower] ?? lower;
}

/**
 * Parse Pi permission entries such as `bash(git push *)`.
 *
 * Capitalized names such as `Bash(...)` are accepted as a convenience, but Pi's
 * actual tool names are lowercase. Scoped entries stay scoped: we do not flatten
 * `bash(git status *)` into a blanket `bash` permission.
 */
export function parseToolPattern(value: unknown): ToolPattern | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw) return undefined;

  const match = raw.match(/^@?([A-Za-z0-9_-]+)(?:\((.*)\))?$/s);
  if (!match) return { raw };
  const toolName = normalizeToolName(match[1] ?? "");
  const argumentPattern = match[2];
  const bashPatternAnalysis = toolName === "bash" && argumentPattern
    ? analyzeBash(argumentPattern)
    : undefined;
  const pattern: ToolPattern = { raw, toolName, argumentPattern };
  if (bashPatternAnalysis) bashPatternAnalyses.set(pattern, bashPatternAnalysis);
  return pattern;
}

/** Return whether a parsed permission entry is malformed. */
export function isMalformedToolPattern(pattern: ToolPattern): boolean {
  if (!pattern.toolName) return true;
  if (pattern.argumentPattern === undefined) return false;
  if (pattern.argumentPattern.trim() === "") return true;
  return pattern.toolName === "bash" &&
    (bashPatternAnalyses.get(pattern)?.errors.length ??
        analyzeBash(pattern.argumentPattern).errors.length) > 0;
}

function literalPrefixTable(value: string): number[] {
  const table = new Array<number>(value.length).fill(0);
  let prefixLength = 0;
  for (let index = 1; index < value.length; index += 1) {
    while (
      prefixLength > 0 && value[index] !== value[prefixLength]
    ) {
      prefixLength = table[prefixLength - 1] ?? 0;
    }
    if (value[index] === value[prefixLength]) prefixLength += 1;
    table[index] = prefixLength;
  }
  return table;
}

function findLiteral(
  value: string,
  literal: string,
  start: number,
  end: number,
): number {
  const prefixTable = literalPrefixTable(literal);
  let matched = 0;
  for (let index = start; index < end; index += 1) {
    while (matched > 0 && value[index] !== literal[matched]) {
      matched = prefixTable[matched - 1] ?? 0;
    }
    if (value[index] === literal[matched]) matched += 1;
    if (matched === literal.length) return index - literal.length + 1;
  }
  return -1;
}

export type WildcardOverflowPolicy = "match" | "no-match";

/**
 * Match a case-insensitive `*` wildcard pattern in linear time.
 *
 * `*` matches zero or more characters, including newlines and path separators.
 * Denial callers use `match` for over-limit values so they fail closed. Allow
 * callers use `no-match` so an oversized input cannot broaden an allow rule.
 */
export function matchesWildcardPattern(
  pattern: string,
  value: string,
  overflowPolicy: WildcardOverflowPolicy = "match",
): boolean {
  if (
    pattern.length > MAX_WILDCARD_PATTERN_LENGTH ||
    value.length > MAX_WILDCARD_INPUT_LENGTH
  ) {
    return overflowPolicy === "match";
  }

  const normalizedPattern = canonicalizeCase(pattern);
  const normalizedValue = canonicalizeCase(value);
  if (!normalizedPattern.includes("*")) {
    return normalizedPattern === normalizedValue;
  }

  const startsWithWildcard = normalizedPattern.startsWith("*");
  const endsWithWildcard = normalizedPattern.endsWith("*");
  const literals = normalizedPattern.split("*").filter(Boolean);
  if (literals.length === 0) return true;

  let literalIndex = 0;
  let valueIndex = 0;
  let lastLiteralIndex = literals.length;

  if (!startsWithWildcard) {
    const prefix = literals[0] ?? "";
    if (!normalizedValue.startsWith(prefix)) return false;
    valueIndex = prefix.length;
    literalIndex = 1;
  }

  let searchEnd = normalizedValue.length;
  if (!endsWithWildcard) {
    const suffix = literals[literals.length - 1] ?? "";
    searchEnd -= suffix.length;
    if (
      searchEnd < valueIndex ||
      !normalizedValue.endsWith(suffix)
    ) {
      return false;
    }
    lastLiteralIndex -= 1;
  }

  for (; literalIndex < lastLiteralIndex; literalIndex += 1) {
    const literal = literals[literalIndex] ?? "";
    const found = findLiteral(
      normalizedValue,
      literal,
      valueIndex,
      searchEnd,
    );
    if (found < 0) return false;
    valueIndex = found + literal.length;
  }

  return true;
}

export function normalizePermissionPathForMatch(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? path.replace(/\\/g, "/") : path;
}

/** Match an extracted target directly; host aliases were expanded at extraction. */
function pathArgumentsForMatch(
  resolved: string,
  cwd: string,
  overflowPolicy: WildcardOverflowPolicy,
): string[] {
  const canonical = resolvePathForPolicy(resolved);
  const candidates = canonical
    ? [canonical, normalizePathForMatch(canonical, cwd)]
    : [];
  if (overflowPolicy === "match") {
    candidates.push(resolved, normalizePathForMatch(resolved, cwd));
  }
  return [...new Set(
    candidates.map((candidate) => normalizePermissionPathForMatch(candidate)),
  )];
}

function getPrimaryArguments(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  if (toolName === "bash" && typeof input.command === "string") {
    return [input.command];
  }
  if (toolName === "grep" && typeof input.pattern === "string") {
    return [input.pattern];
  }
  return [JSON.stringify(input)];
}

function isPermissionPathTool(toolName: string): boolean {
  return toolName === "read" ||
    toolName === "write" ||
    toolName === "edit" ||
    toolName === "find" ||
    toolName === "ls";
}

export function appendPermissionPathPatternSuffix(
  scope: string,
  suffix: string,
): string {
  const normalizedScope = withoutTrailingSlash(
    normalizePermissionPathForMatch(scope),
  );
  return normalizedScope.endsWith("/")
    ? `${normalizedScope}${suffix}`
    : `${normalizedScope}/${suffix}`;
}

function permissionPathPatternVariants(
  pattern: string,
  cwd: string,
): string[] {
  const expanded = normalizePermissionPathForMatch(expandHomePattern(pattern));
  const wildcardIndex = expanded.indexOf("*");
  if (wildcardIndex === -1) {
    const resolved = resolveInputPath(cwd, expanded);
    const canonical = resolvePathForPolicy(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
    return [...new Set(
      [expanded, resolved, canonical]
        .filter((value): value is string => !!value)
        .map((value) => normalizePermissionPathForMatch(value)),
    )];
  }

  const fixedPrefix = expanded.slice(0, wildcardIndex);
  const lastSlash = fixedPrefix.lastIndexOf("/");
  if (lastSlash < 0) return [expanded];
  const fixedScope = fixedPrefix.slice(0, lastSlash) || "/";
  const resolvedScope = resolveInputPath(cwd, fixedScope);
  if (!resolvedScope) return [expanded];
  const canonicalScope = resolvePathForPolicy(isAbsolute(fixedScope) ? fixedScope : resolve(cwd, fixedScope));
  const suffix = expanded.slice(lastSlash).replace(/^\/+/, "");
  return [...new Set([
    expanded,
    appendPermissionPathPatternSuffix(resolvedScope, suffix),
    ...(canonicalScope
      ? [appendPermissionPathPatternSuffix(canonicalScope, suffix)]
      : []),
  ])];
}

function matchesPermissionPathArguments(
  pattern: ToolPattern,
  toolName: string,
  candidates: string[],
  cwd: string,
  overflowPolicy: WildcardOverflowPolicy,
): boolean {
  if (!pattern.toolName) return overflowPolicy === "match";
  if (pattern.toolName !== normalizeToolName(toolName)) return false;
  // Empty allow candidates mean canonicalization failed, even for a bare rule.
  if (candidates.length === 0) return false;
  if (pattern.argumentPattern === undefined) return true;
  if (pattern.argumentPattern.trim() === "") return overflowPolicy === "match";
  return permissionPathPatternVariants(pattern.argumentPattern, cwd).some(
    (argumentPattern) => candidates.some((candidate) =>
      matchesWildcardPattern(argumentPattern, candidate, overflowPolicy)
    ),
  );
}

/**
 * Whether a resolved absolute path matches a configured path-denial pattern.
 * Patterns support `~`/`$HOME` expansion and `*` globs, where `*` matches any
 * characters, including `/`. Matching is case-insensitive and
 * conservative-safe: over-matching only blocks more.
 */
export function matchesDeniedPath(
  resolvedPath: string,
  deniedPaths: string[],
): boolean {
  const normalized = resolvedPath.replace(/\\/g, "/").normalize("NFC");
  return deniedPaths.some((pattern) =>
    deniedPatternVariants(pattern).some((variant) =>
      matchesWildcardPattern(variant.normalize("NFC"), normalized)
    )
  );
}

function deniedPatternVariants(pattern: string): string[] {
  const expanded = expandHomePattern(pattern).replace(/\\/g, "/");
  const wildcardIndex = expanded.indexOf("*");
  if (wildcardIndex === -1) {
    const canonical = resolvePathForPolicy(expanded)?.replace(/\\/g, "/");
    return canonical && canonical !== expanded
      ? [expanded, canonical]
      : [expanded];
  }

  const fixedPrefix = expanded.slice(0, wildcardIndex);
  const lastSlash = fixedPrefix.lastIndexOf("/");
  if (lastSlash < 0) return [expanded];
  const fixedScope = fixedPrefix.slice(0, lastSlash) || "/";
  const canonicalScope = resolvePathForPolicy(fixedScope)?.replace(/\\/g, "/");
  if (!canonicalScope || canonicalScope === fixedScope) return [expanded];
  const suffix = expanded.slice(lastSlash).replace(/^\/+/, "");
  const canonicalPattern = canonicalScope === "/"
    ? `/${suffix}`
    : `${withoutTrailingSlash(canonicalScope)}/${suffix}`;
  return canonicalPattern === expanded
    ? [expanded]
    : [expanded, canonicalPattern];
}

function withoutTrailingSlash(path: string): string {
  if (path === "/" || /^[A-Za-z]:\/$/.test(path)) return path;
  return path.replace(/\/+$/, "");
}

function wildcardCanMatchDescendant(root: string, pattern: string): boolean {
  const normalizedRoot = withoutTrailingSlash(
    canonicalizeCase(root.replace(/\\/g, "/").normalize("NFC")),
  );
  const prefix = normalizedRoot === "/" || /^[A-Za-z]:\/$/.test(normalizedRoot)
    ? normalizedRoot
    : `${normalizedRoot}/`;
  const normalizedPattern = canonicalizeCase(pattern.normalize("NFC"));
  const wildcardIndex = normalizedPattern.indexOf("*");
  if (wildcardIndex < 0) {
    return normalizedPattern.length > prefix.length &&
      normalizedPattern.startsWith(prefix);
  }

  const fixedPrefix = normalizedPattern.slice(0, wildcardIndex);
  return prefix.startsWith(fixedPrefix) || fixedPrefix.startsWith(prefix);
}

/**
 * Whether a recursive search scope can contain a path matched by `deniedPaths`.
 *
 * The check asks whether the wildcard pattern can match any path beginning
 * with the search-root prefix. It does not scan the search tree.
 */
export function recursiveSearchMayReachDeniedPath(
  resolvedRoot: string,
  deniedPaths: string[],
): boolean {
  if (resolvedRoot.length > MAX_WILDCARD_INPUT_LENGTH) {
    return deniedPaths.length > 0;
  }
  return deniedPaths.some((pattern) => {
    if (pattern.length > MAX_WILDCARD_PATTERN_LENGTH) return true;
    return deniedPatternVariants(pattern).some((expanded) =>
      wildcardCanMatchDescendant(resolvedRoot, expanded)
    );
  });
}

function normalizedBashArgumentPattern(pattern: ToolPattern): string {
  const patternAnalysis = bashPatternAnalyses.get(pattern);
  if (
    patternAnalysis &&
    patternAnalysis.errors.length === 0 &&
    patternAnalysis.redirects.length === 0 &&
    isStructurallyPlainSingleCommand(patternAnalysis)
  ) {
    return patternAnalysis.commands[0]?.text ?? pattern.argumentPattern ?? "";
  }
  return pattern.argumentPattern ?? "";
}

function matchesBashArgumentPattern(
  argumentPattern: string,
  candidate: string,
  overflowPolicy: WildcardOverflowPolicy,
): boolean {
  if (matchesWildcardPattern(argumentPattern, candidate, overflowPolicy)) {
    return true;
  }
  if (overflowPolicy !== "match" || !argumentPattern.endsWith(" *")) {
    return false;
  }
  return matchesWildcardPattern(
    argumentPattern.slice(0, -2),
    candidate,
    overflowPolicy,
  );
}

/** Match a scoped permission rule against a concrete tool call. */
export function matchesToolPattern(
  pattern: ToolPattern,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  overflowPolicy: WildcardOverflowPolicy = "match",
  bashAnalysis?: BashAnalysis,
): boolean {
  if (!pattern.toolName) return overflowPolicy === "match";
  if (pattern.toolName !== normalizeToolName(toolName)) return false;
  if (isPermissionPathTool(toolName)) {
    const targets = extractToolPaths(toolName, input, cwd);
    if (targets.error || targets.paths.length === 0) return overflowPolicy === "match";
    const quantifier = overflowPolicy === "match" ? "some" : "every";
    return targets.paths[quantifier]((path) => matchesPermissionPathArguments(
      pattern,
      toolName,
      pathArgumentsForMatch(path, cwd, overflowPolicy),
      cwd,
      overflowPolicy,
    ));
  }
  if (pattern.argumentPattern === undefined) return true;
  if (pattern.argumentPattern.trim() === "") {
    return overflowPolicy === "match";
  }
  if (
    toolName === "bash" &&
    (bashPatternAnalyses.get(pattern)?.errors.length ?? 0) > 0
  ) {
    return overflowPolicy === "match";
  }
  if (toolName === "bash" && bashAnalysis) {
    if (bashAnalysis.errors.length > 0) return overflowPolicy === "match";
    const candidates = overflowPolicy === "match"
      ? [bashAnalysis.source, ...bashAnalysis.commands.map((command) => command.text)]
      : [bashAnalysis.source];
    const argumentPattern = normalizedBashArgumentPattern(pattern);
    return candidates.some((candidate) =>
      matchesBashArgumentPattern(argumentPattern, candidate, overflowPolicy)
    );
  }
  const primaryArguments = getPrimaryArguments(toolName, input);
  return primaryArguments.some((primary) =>
    matchesWildcardPattern(pattern.argumentPattern ?? "", primary, overflowPolicy)
  );
}

/** Return the normalized Bash command that matched a scoped permission rule. */
export function matchingBashCommandText(
  pattern: ToolPattern,
  bashAnalysis: BashAnalysis | undefined,
  overflowPolicy: WildcardOverflowPolicy = "match",
): string | undefined {
  if (!bashAnalysis || pattern.toolName !== "bash") return undefined;
  if (bashAnalysis.errors.length > 0) return undefined;
  if (!pattern.argumentPattern) return undefined;
  const argumentPattern = normalizedBashArgumentPattern(pattern);
  const command = bashAnalysis.commands.find((candidate) =>
    matchesBashArgumentPattern(argumentPattern, candidate.text, overflowPolicy)
  );
  if (command) return command.text;
  return matchesBashArgumentPattern(argumentPattern, bashAnalysis.source, overflowPolicy)
    ? bashAnalysis.source
    : undefined;
}

function redirectListsMatch(
  patternRedirects: BashRedirectAnalysis[],
  inputRedirects: BashRedirectAnalysis[],
): boolean {
  if (patternRedirects.length !== inputRedirects.length) return false;
  return patternRedirects.every((pattern, index) => {
    const input = inputRedirects[index];
    if (!input || pattern.heredoc || input.heredoc || input.targetDynamic) {
      return false;
    }
    if (
      pattern.operator !== input.operator ||
      pattern.fileDescriptor !== input.fileDescriptor ||
      pattern.variableName !== input.variableName
    ) {
      return false;
    }
    if (pattern.target === undefined) return input.target === undefined;
    if (input.target === undefined) return false;
    return matchesWildcardPattern(pattern.target, input.target, "no-match");
  });
}

function containsUnquotedBracketExpression(text: string, start: number): boolean {
  let index = start + 1;
  if (text[index] === "!" || text[index] === "^") index += 1;
  let hasMember = false;
  if (text[index] === "]") {
    hasMember = true;
    index += 1;
  }
  let quote: "'" | '"' | "$'" | undefined;
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (quote === "$'") {
        if (character === "\\") {
          if (index + 1 < text.length) {
            hasMember = true;
            index += 1;
          }
        } else if (character === "'") quote = undefined;
        else hasMember = true;
      } else {
        if (character === quote) quote = undefined;
        else if (quote === '"' && character === "\\") index += 1;
        else hasMember = true;
      }
      continue;
    }
    if (character === "\\") {
      if (index + 1 < text.length) {
        hasMember = true;
        index += 1;
      }
      continue;
    }
    if (character === "$" && text[index + 1] === "'") {
      quote = "$'";
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "]") return hasMember;
    hasMember = true;
  }
  return false;
}

function hasUnquotedPathnameExpansion(text: string): boolean {
  let quote: "'" | '"' | "$'" | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (quote === "$'") {
        if (character === "\\") index += 1;
        else if (character === "'") quote = undefined;
      } else {
        if (character === quote) quote = undefined;
        else if (quote === '"' && character === "\\") index += 1;
      }
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "$" && text[index + 1] === "'") {
      quote = "$'";
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "*" || character === "?") return true;
    if (
      character === "[" &&
      containsUnquotedBracketExpression(text, index)
    ) {
      return true;
    }
  }
  return false;
}

function commandMatchesAllowPattern(
  patternCommand: BashCommandAnalysis,
  inputCommand: BashCommandAnalysis,
): boolean {
  return matchesWildcardPattern(
    patternCommand.text,
    inputCommand.text,
    "no-match",
  ) && redirectListsMatch(patternCommand.redirects, inputCommand.redirects);
}

function structuresMatch(pattern: BashAnalysis, input: BashAnalysis): boolean {
  return pattern.structure.length === input.structure.length &&
    pattern.structure.every((token, index) => token === input.structure[index]);
}

function allRedirectsAreCommandRedirects(analysis: BashAnalysis): boolean {
  return analysis.redirects.length === analysis.commands.reduce(
    (count, command) => count + command.redirects.length,
    0,
  );
}

function isStructurallyPlainSingleCommand(analysis: BashAnalysis): boolean {
  if (analysis.commands.length !== 1) return false;
  if (analysis.structure.length !== 3 + analysis.redirects.length) return false;
  if (analysis.structure[0] !== "script:1") return false;
  if (analysis.structure[1] !== "node:Statement:foreground:0") return false;
  if (!/^node:Command:\d+:\d+$/.test(analysis.structure[2] ?? "")) {
    return false;
  }
  return analysis.structure.slice(3).every((token) =>
    token.startsWith("redirect:")
  );
}

function supportsPerCommandAllowPatterns(analysis: BashAnalysis): boolean {
  return analysis.structure.every((token) =>
    token.startsWith("script:") ||
    token.startsWith("node:Statement:foreground:") ||
    token.startsWith("node:Command:") ||
    token.startsWith("node:AndOr:") ||
    token.startsWith("node:Pipeline:plain:plain:") ||
    token.startsWith("redirect:")
  );
}

/** Whether permission allow rules cover the complete tool call. */
export function matchesAllowedToolPatterns(
  patterns: ToolPattern[],
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  bashAnalysis?: BashAnalysis,
): boolean {
  if (isPermissionPathTool(toolName)) {
    const targets = extractToolPaths(toolName, input, cwd);
    return !targets.error && targets.paths.length > 0 &&
      targets.paths.every((path) => {
        const candidates = pathArgumentsForMatch(path, cwd, "no-match");
        return candidates.length > 0 && patterns.some((pattern) =>
          matchesPermissionPathArguments(pattern, toolName, candidates, cwd, "no-match")
        );
      });
  }
  if (toolName !== "bash" || !bashAnalysis) {
    return patterns.some((pattern) =>
      matchesToolPattern(pattern, toolName, input, cwd, "no-match")
    );
  }
  if (
    bashAnalysis.errors.length > 0 ||
    bashAnalysis.commands.length === 0 ||
    !bashAnalysis.allowStructureSafe
  ) {
    return false;
  }
  if (
    bashAnalysis.commands.some((command) =>
      command.dynamic ||
      command.dynamicName ||
      command.dynamicShellScript ||
      command.argTexts.some(hasUnquotedPathnameExpansion)
    )
  ) {
    return false;
  }

  for (const pattern of patterns) {
    if (pattern.toolName !== "bash") continue;
    const patternAnalysis = bashPatternAnalyses.get(pattern);
    if (
      !patternAnalysis ||
      patternAnalysis.errors.length > 0 ||
      !patternAnalysis.allowStructureSafe ||
      isStructurallyPlainSingleCommand(patternAnalysis) ||
      patternAnalysis.commands.length !== bashAnalysis.commands.length ||
      !structuresMatch(patternAnalysis, bashAnalysis) ||
      !redirectListsMatch(patternAnalysis.redirects, bashAnalysis.redirects)
    ) {
      continue;
    }
    if (
      patternAnalysis.commands.every((patternCommand, index) => {
        const inputCommand = bashAnalysis.commands[index];
        return !!inputCommand &&
          commandMatchesAllowPattern(patternCommand, inputCommand);
      })
    ) {
      return true;
    }
  }

  const hasBareBashPattern = patterns.some((pattern) =>
    pattern.toolName === "bash" && pattern.argumentPattern === undefined
  );
  if (
    !hasBareBashPattern &&
    !supportsPerCommandAllowPatterns(bashAnalysis)
  ) {
    return false;
  }
  if (!allRedirectsAreCommandRedirects(bashAnalysis)) return false;
  return bashAnalysis.commands.every((command) =>
    patterns.some((pattern) => {
      if (pattern.toolName !== "bash") return false;
      if (pattern.argumentPattern === undefined) {
        return command.redirects.length === 0;
      }
      const patternAnalysis = bashPatternAnalyses.get(pattern);
      if (
        !patternAnalysis ||
        patternAnalysis.errors.length > 0 ||
        !isStructurallyPlainSingleCommand(patternAnalysis)
      ) {
        return false;
      }
      const patternCommand = patternAnalysis.commands[0];
      return !!patternCommand &&
        commandMatchesAllowPattern(patternCommand, command);
    })
  );
}
