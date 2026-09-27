import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesWildcardPattern } from "./permissions.ts";
import { safeJson, truncateMiddle } from "./utils.ts";

const MAX_USER_ENTRY_TOKENS = 1000;
const MAX_TOOL_ENTRY_TOKENS = 1000;
const MAX_RECENT_TOOL_ENTRIES = 40;
const CHARS_PER_APPROX_TOKEN = 4;

type TranscriptEntry = {
  index: number;
  order: number;
  kind: "user" | "tool" | "toolResult";
  text: string;
};

export type ClassifierTranscriptBudgets = {
  maxUserTokens: number;
  maxToolTokens: number;
  /** Registered tool names whose results may appear as classifier evidence. */
  trustedToolResults?: ReadonlySet<string>;
};

function flattenUserContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text?: string } =>
        !!block && typeof block === "object" && "type" in block,
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n");
}

function collectAssistantToolCalls(content: unknown): Array<{
  name: string;
  input: unknown;
}> {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (
        block,
      ): block is {
        type: string;
        name?: string;
        arguments?: unknown;
        input?: unknown;
      } => !!block && typeof block === "object" && "type" in block,
    )
    .filter((block) => block.type === "toolCall" || block.type === "tool_use")
    .map((block) => ({
      name: String(block.name ?? "tool"),
      input: "arguments" in block ? block.arguments : block.input,
    }));
}

export function approximateTokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_APPROX_TOKEN);
}

function truncateToTokenCap(
  text: string,
  maxTokens: number,
): { text: string; truncated: boolean } {
  if (approximateTokenCount(text) <= maxTokens) {
    return { text, truncated: false };
  }
  const maxCharacters = Math.max(1, maxTokens * CHARS_PER_APPROX_TOKEN);
  const omittedTokens = Math.max(
    1,
    approximateTokenCount(text) - maxTokens,
  );
  const marker = `<truncated approx_tokens="${omittedTokens}" />`;
  if (marker.length >= maxCharacters) {
    return { text: marker.slice(0, maxCharacters), truncated: true };
  }

  const retainedCharacters = maxCharacters - marker.length;
  const prefixCharacters = Math.ceil(retainedCharacters * 0.65);
  const suffixCharacters = retainedCharacters - prefixCharacters;
  return {
    text: `${text.slice(0, prefixCharacters)}${marker}${
      suffixCharacters > 0 ? text.slice(-suffixCharacters) : ""
    }`,
    truncated: true,
  };
}

function collectTranscriptEntries(
  ctx: ExtensionContext,
  trustedToolResults: ReadonlySet<string>,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
    buildContextEntries?: () => ReturnType<typeof ctx.sessionManager.getBranch>;
  };
  const contextEntries = sessionManager.buildContextEntries?.() ??
    sessionManager.getBranch();

  for (const [index, entry] of contextEntries.entries()) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown };
    if (message.role === "user") {
      const text = flattenUserContent(message.content).trim();
      if (text) entries.push({ index, order: 0, kind: "user", text });
      continue;
    }
    if (message.role === "toolResult") {
      // Tool results are untrusted by default. Results from tools listed in
      // `trustedToolResults` enter the evidence channel so that user-mediated
      // decisions, such as questionnaire answers, reach the classifier.
      const toolName = (message as { toolName?: unknown }).toolName;
      if (typeof toolName !== "string" || !trustedToolResults.has(toolName)) {
        continue;
      }
      const text = flattenUserContent(message.content).trim();
      if (text) {
        entries.push({
          index,
          order: 0,
          kind: "toolResult",
          text: `${toolName}: ${text}`,
        });
      }
      continue;
    }
    if (message.role !== "assistant") continue;

    for (const [order, toolCall] of collectAssistantToolCalls(
      message.content,
    ).entries()) {
      entries.push({
        index,
        order,
        kind: "tool",
        text: `${toolCall.name}: ${safeJson(toolCall.input, 8000)}`,
      });
    }
  }

  return entries;
}

function selectUserEntries(
  entries: TranscriptEntry[],
  maxTokens: number,
): { selected: TranscriptEntry[]; omitted: boolean } {
  const users = entries.filter((entry) => entry.kind === "user");
  if (users.length === 0) return { selected: [], omitted: false };

  const distinctAnchors = users.length > 1;
  const anchorBudget = distinctAnchors
    ? Math.max(1, Math.floor(maxTokens / 2))
    : maxTokens;
  const entryCap = Math.min(MAX_USER_ENTRY_TOKENS, anchorBudget);
  const rendered = users.map((entry) => {
    const truncated = truncateToTokenCap(`User: ${entry.text}`, entryCap);
    return { ...entry, text: truncated.text, truncated: truncated.truncated };
  });
  const selectedIndices = new Set<number>();
  let usedTokens = 0;

  const include = (index: number): void => {
    if (selectedIndices.has(index)) return;
    const entry = rendered[index];
    if (!entry) return;
    const tokens = approximateTokenCount(entry.text);
    if (usedTokens + tokens > maxTokens) return;
    selectedIndices.add(index);
    usedTokens += tokens;
  };

  // Prefer the latest user instruction when an extremely small configured
  // budget cannot retain both intent anchors.
  include(rendered.length - 1);
  include(0);
  for (let index = rendered.length - 2; index > 0; index -= 1) {
    include(index);
  }

  return {
    selected: rendered.filter((_entry, index) => selectedIndices.has(index)),
    omitted: selectedIndices.size < users.length || rendered.some((entry) =>
      entry.truncated
    ),
  };
}

function selectToolEntries(
  entries: TranscriptEntry[],
  maxTokens: number,
): { selected: TranscriptEntry[]; omitted: boolean } {
  const tools = entries.filter(
    (entry) => entry.kind === "tool" || entry.kind === "toolResult",
  );
  const selected: TranscriptEntry[] = [];
  let usedTokens = 0;

  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (selected.length >= MAX_RECENT_TOOL_ENTRIES) break;
    const entry = tools[index];
    if (!entry) continue;
    const prefix = entry.kind === "toolResult" ? "ToolResult " : "ToolCall ";
    const truncated = truncateToTokenCap(
      `${prefix}${entry.text}`,
      Math.min(MAX_TOOL_ENTRY_TOKENS, maxTokens),
    );
    const tokens = approximateTokenCount(truncated.text);
    if (usedTokens + tokens > maxTokens) continue;
    selected.push({ ...entry, text: truncated.text });
    usedTokens += tokens;
  }

  selected.reverse();
  return {
    selected,
    omitted: selected.length < tools.length || tools.some((entry) =>
      approximateTokenCount(
        `${entry.kind === "toolResult" ? "ToolResult " : "ToolCall "}${entry.text}`,
      ) > Math.min(MAX_TOOL_ENTRY_TOKENS, maxTokens)
    ),
  };
}

/** Build classifier evidence from user text and assistant tool-call payloads only. */
export function buildClassifierTranscript(
  ctx: ExtensionContext,
  budgets: ClassifierTranscriptBudgets,
): string {
  const entries = collectTranscriptEntries(
    ctx,
    budgets.trustedToolResults ?? new Set<string>(),
  );
  const users = selectUserEntries(entries, budgets.maxUserTokens);
  const tools = selectToolEntries(entries, budgets.maxToolTokens);
  const selected = [...users.selected, ...tools.selected].sort(
    (left, right) => left.index - right.index || left.order - right.order,
  );
  if (users.omitted || tools.omitted) {
    selected.push({
      index: Number.MAX_SAFE_INTEGER,
      order: 0,
      kind: "tool",
      text: "<transcript_entries_omitted />",
    });
  }
  return selected.map((entry) => entry.text).join("\n");
}

type RegisteredToolSource = {
  name: string;
  sourceInfo?: { path?: string; source?: string };
};

function isBuiltinToolSource(source: RegisteredToolSource): boolean {
  const info = source.sourceInfo;
  if (!info) return false;
  return info.source === "builtin" ||
    (typeof info.path === "string" && info.path.startsWith("<builtin:"));
}

/**
 * Resolve configured `trustedToolResults` entries against the currently
 * registered tools. A bare `name` entry trusts every registered tool with
 * that name: the user's explicit config listing is the trust declaration,
 * the same tier as a `permissions.allow` pattern. A `name@glob` entry is
 * optional precision: it applies only when the registered tool's canonical
 * source path matches the glob. Malformed entries and empty names are
 * ignored: resolution fails closed.
 */
export function resolveTrustedToolResults(
  entries: readonly string[],
  tools: readonly RegisteredToolSource[],
  canonicalize: (path: string) => string = (path) => path,
): Set<string> {
  const trusted = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.trim() === "") continue;
    const separator = entry.indexOf("@");
    const name = separator < 0 ? entry : entry.slice(0, separator);
    const glob = separator < 0 ? undefined : entry.slice(separator + 1);
    if (!name || separator === 0 || (glob !== undefined && glob === "")) {
      continue;
    }
    for (const tool of tools) {
      if (tool.name !== name) continue;
      if (glob === undefined || isBuiltinToolSource(tool)) {
        trusted.add(name);
        continue;
      }
      const path = canonicalize(tool.sourceInfo?.path ?? "");
      if (path && matchesWildcardPattern(glob, path)) {
        trusted.add(name);
      }
    }
  }
  return trusted;
}

export function loadedContextFromSystemPromptOptions(options: unknown): string {
  const contextFiles = (
    options as
      | { contextFiles?: Array<{ path?: string; content?: string }> }
      | undefined
  )?.contextFiles;
  if (!Array.isArray(contextFiles)) return "";
  return contextFiles
    .map(
      (file) =>
        `# ${file.path ?? "context"}\n${
          truncateMiddle(file.content ?? "", 4000)
        }`,
    )
    .join("\n\n");
}
