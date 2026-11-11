import { safeJson } from "./utils.ts";

const MAX_OUTCOME_ENTRY_TOKENS = 1000;
const MAX_RECENT_OUTCOMES = 40;
const CHARS_PER_APPROX_TOKEN = 4;
const OMITTED_MIDDLE = "\n… [middle omitted] …\n";

type RecordValue = Record<string, unknown>;
type OutcomeEntry = { index: number; order: number; text: string };
type Call = { index: number; name: string; input: unknown };

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function collectText(
  content: unknown[],
  maxCharacters: number,
  fromEnd = false,
): { text: string; incomplete: boolean; clipped: boolean } {
  let text = "";
  let hasText = false;
  let incomplete = false;
  const step = fromEnd ? -1 : 1;
  for (let index = fromEnd ? content.length - 1 : 0;
    index >= 0 && index < content.length; index += step) {
    if (text.length >= maxCharacters) return { text, incomplete: true, clipped: true };
    const block = record(content[index]);
    const part = block?.type === "text" ? block.text : undefined;
    if (typeof part !== "string") {
      incomplete = true;
      continue;
    }
    const separator = hasText ? "\n" : "";
    const available = maxCharacters - text.length;
    // Slice before concatenation to bound temporary strings.
    text = fromEnd
      ? (part.slice(-available) + separator).slice(-available) + text
      : text + (separator + part.slice(0, available)).slice(0, available);
    hasText = true;
    if (separator.length + part.length > available) return { text, incomplete: true, clipped: true };
  }
  return { text, incomplete, clipped: false };
}

function shortenOutcomeText(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  if (maxCharacters <= OMITTED_MIDDLE.length) return "";
  const available = maxCharacters - OMITTED_MIDDLE.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return text.slice(0, head) + OMITTED_MIDDLE + (tail > 0 ? text.slice(-tail) : "");
}

/** Read the beginning and end without joining the full output. */
function outcomeText(content: unknown, maxCharacters: number): { text: string; incomplete: boolean } {
  if (!Array.isArray(content)) return { text: "", incomplete: true };
  const prefix = collectText(content, maxCharacters);
  if (!prefix.clipped) return prefix;
  if (maxCharacters <= OMITTED_MIDDLE.length) return { text: "", incomplete: true };
  const available = maxCharacters - OMITTED_MIDDLE.length;
  const tail = collectText(content, Math.floor(available / 2), true);
  return {
    text: prefix.text.slice(0, Math.ceil(available / 2)) + OMITTED_MIDDLE + tail.text,
    incomplete: true,
  };
}

/** Shorten field values so the envelope remains valid JSON. */
function renderOutcome(
  toolName: string,
  toolCallId: string,
  isError: boolean,
  input: unknown,
  content: unknown,
  maxTokens: number,
): { text: string; truncated: boolean } | undefined {
  const maxCharacters = maxTokens * CHARS_PER_APPROX_TOKEN - 1;
  // Check metadata before reading result text.
  if (toolName.length + toolCallId.length > maxCharacters) return undefined;
  const envelope = {
    toolName,
    toolCallId,
    isError,
    input: "",
    content: "",
    truncated: true,
  };
  const render = (): string => `ToolResult ${JSON.stringify(envelope)}`;
  if (render().length > maxCharacters) return undefined;
  // Keep the question with its answer if the call transcript is truncated.
  const inputText = safeJson(input, Math.min(8000, maxCharacters));
  const excerpt = outcomeText(content, maxCharacters);
  envelope.input = inputText.slice(0, maxCharacters);
  envelope.content = excerpt.text;
  // safeJson may also truncate arguments.
  envelope.truncated = excerpt.incomplete || inputText.length > maxCharacters ||
    inputText.includes("… […] …") || inputText.includes('"$truncatedArray"');
  let text = render();
  while (text.length > maxCharacters) {
    const key = envelope.input.length >= envelope.content.length
      ? "input"
      : "content";
    if (envelope[key].length === 0) return undefined;
    // Preserve both ends when reducing the content budget.
    const limit = Math.floor(envelope[key].length / 2);
    envelope[key] = key === "content"
      ? shortenOutcomeText(envelope.content, limit)
      : envelope.input.slice(0, limit);
    envelope.truncated = true;
    text = render();
  }
  return { text, truncated: envelope.truncated };
}

/** Select paired tool results within the outcome budget. */
export function selectOutcomeEntries(
  contextEntries: ReadonlyArray<{ type: string; message?: unknown }>,
  maxTokens: number,
  includedTools?: readonly string[],
): { selected: OutcomeEntry[]; omitted: boolean } {
  const toolNames = includedTools === undefined ? undefined : new Set(includedTools);
  const calls = new Map<string, Call | null>();
  const resultCounts = new Map<string, number>();
  for (const [index, entry] of contextEntries.entries()) {
    if (entry.type !== "message") continue;
    const message = record(entry.message);
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      const id = message.toolCallId;
      resultCounts.set(id, (resultCounts.get(id) ?? 0) + 1);
    }
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const call = record(block);
      if (!call || (call.type !== "toolCall" && call.type !== "tool_use") ||
        typeof call.id !== "string" || typeof call.name !== "string") continue;
      // Mark duplicate call IDs as ambiguous.
      calls.set(call.id, calls.has(call.id) ? null : {
        index,
        name: call.name,
        input: "arguments" in call ? call.arguments : call.input,
      });
    }
  }

  const selected: OutcomeEntry[] = [];
  let usedTokens = 0;
  let omitted = false;
  for (let index = contextEntries.length - 1; index >= 0; index -= 1) {
    const entry = contextEntries[index];
    if (entry?.type !== "message") continue;
    const message = record(entry.message);
    if (message?.role !== "toolResult") continue;
    if (toolNames && (typeof message.toolName !== "string" || !toolNames.has(message.toolName))) {
      omitted = true;
      continue;
    }
    const id = message.toolCallId;
    const call = typeof id === "string" ? calls.get(id) : undefined;
    if (typeof id !== "string" || !call || call.index >= index ||
      resultCounts.get(id) !== 1 || message.toolName !== call.name ||
      typeof message.isError !== "boolean" || selected.length >= MAX_RECENT_OUTCOMES) {
      omitted = true;
      continue;
    }
    if (usedTokens >= maxTokens) {
      omitted = true;
      break;
    }
    const rendered = renderOutcome(
      call.name, id, message.isError, call.input, message.content,
      Math.min(MAX_OUTCOME_ENTRY_TOKENS, maxTokens - usedTokens),
    );
    if (!rendered) {
      omitted = true;
      continue;
    }
    const tokens = Math.ceil((rendered.text.length + 1) / CHARS_PER_APPROX_TOKEN);
    if (usedTokens + tokens > maxTokens) {
      omitted = true;
      continue;
    }
    selected.push({ index, order: 0, text: rendered.text });
    usedTokens += tokens;
    omitted ||= rendered.truncated;
  }
  return { selected: selected.reverse(), omitted };
}
