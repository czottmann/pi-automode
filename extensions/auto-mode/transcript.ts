import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { safeJson, truncateMiddle } from "./utils.ts";

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

function flattenAssistantText(content: unknown): string {
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

function collectAssistantToolCalls(content: unknown): string[] {
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
    .map(
      (block) =>
        `${String(block.name ?? "tool")} ${safeJson("arguments" in block ? block.arguments : block.input, 1200)}`,
    );
}

export function buildTranscript(ctx: ExtensionContext, maxLines: number): string {
  const lines: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown };
    if (message.role === "user") {
      const text = flattenUserContent(message.content).trim();
      if (text) lines.push(`User: ${truncateMiddle(text, 2000)}`);
    } else if (message.role === "assistant") {
      const text = flattenAssistantText(message.content).trim();
      if (text) lines.push(`Assistant: ${truncateMiddle(text, 2000)}`);
      for (const toolCall of collectAssistantToolCalls(message.content))
        lines.push(`AssistantAction: ${toolCall}`);
    }
  }
  return lines.slice(-maxLines).join("\n");
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
        `# ${file.path ?? "context"}\n${truncateMiddle(file.content ?? "", 4000)}`,
    )
    .join("\n\n");
}
