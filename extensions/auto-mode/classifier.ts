import { complete } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Model,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLASSIFIER_SYSTEM_PROMPT } from "./constants.ts";
import { parseModelSpec } from "./model.ts";
import { buildTranscript } from "./transcript.ts";
import type {
  ClassificationDecision,
  ClassifyAction,
  EffectiveConfig,
} from "./types.ts";

export function buildClassifierPrompt(config: EffectiveConfig): string {
  return CLASSIFIER_SYSTEM_PROMPT.replace(
    "<ENVIRONMENT>",
    config.environment.map((line) => `- ${line}`).join("\n"),
  )
    .replace(
      "<ALLOW_RULES>",
      config.allow.map((line) => `- ${line}`).join("\n"),
    )
    .replace(
      "<SOFT_DENY_RULES>",
      config.softDeny.map((line) => `- ${line}`).join("\n"),
    )
    .replace(
      "<HARD_DENY_RULES>",
      config.hardDeny.map((line) => `- ${line}`).join("\n"),
    );
}

async function resolveClassifier(
  ctx: ExtensionContext,
  config: EffectiveConfig,
): Promise<
  | { model: Model<any>; apiKey?: string; headers?: Record<string, string> }
  | undefined
> {
  const configured = config.classifierModel;
  const model = configured
    ? (() => {
      const parsed = parseModelSpec(configured);
      return parsed
        ? ctx.modelRegistry.find(parsed.provider, parsed.id)
        : undefined;
    })()
    : ctx.model;
  if (!model) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return undefined;
  return { model, apiKey: auth.apiKey, headers: auth.headers };
}

export type ClassifierCompletionFn = (
  model: Model<any>,
  options: { systemPrompt: string; messages: UserMessage[] },
  callOptions: {
    apiKey?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    maxTokens: number;
    temperature: number;
  },
) => Promise<AssistantMessage>;

export type RetryOptions = {
  maxAttempts?: number;
  maxTokens?: number;
  temperature?: number;
};

/** Parse the classifier's JSON-only response. Invalid output is handled fail-closed by the caller. */
export function parseClassifierDecision(
  message: AssistantMessage,
): ClassificationDecision | undefined {
  const text = message.content
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [fenced, text, text.match(/\{[\s\S]*\}/)?.[0]].filter(
    Boolean,
  ) as string[];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<ClassificationDecision>;
      if (
        (parsed.decision === "allow" || parsed.decision === "block") &&
        typeof parsed.reason === "string"
      ) {
        return {
          decision: parsed.decision,
          tier: parsed.tier ?? "none",
          reason: parsed.reason,
        };
      }
    } catch {
      // Try next candidate.
    }
  }
  return undefined;
}

/**
 * Call the classifier model and parse its decision, retrying when the model
 * returns malformed or truncated output. Small classifier models occasionally
 * ramble into the token cap (stopReason "length") or emit prose instead of
 * JSON; a single retry recovers most of these transient failures.
 *
 * Safety is preserved: an "allow" is only returned when a response actually
 * parses to a valid allow decision. If every attempt fails to parse, the
 * function fails closed with a block decision. Thrown errors (network/auth)
 * are not retried — they fail closed immediately, matching prior behavior.
 */
export async function classifyWithRetry(
  completeFn: ClassifierCompletionFn,
  classifier: {
    model: Model<any>;
    apiKey?: string;
    headers?: Record<string, string>;
  },
  prompt: { systemPrompt: string; messages: UserMessage[] },
  signal: AbortSignal | undefined,
  options: RetryOptions = {},
): Promise<ClassificationDecision> {
  const maxAttempts = options.maxAttempts ?? 2;
  const maxTokens = options.maxTokens ?? 1200;
  const temperature = options.temperature ?? 0;
  let lastReason =
    "Classifier response was not valid decision JSON; auto mode fails closed.";
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response: AssistantMessage;
    try {
      response = await completeFn(
        classifier.model,
        prompt,
        {
          apiKey: classifier.apiKey,
          headers: classifier.headers,
          signal,
          maxTokens,
          temperature,
        },
      );
    } catch (error) {
      return {
        decision: "block",
        tier: "none",
        reason: `Classifier failed; auto mode fails closed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    const decision = parseClassifierDecision(response);
    if (decision) return decision;
    lastReason =
      response.stopReason === "length"
        ? "Classifier response was truncated before producing valid decision JSON; auto mode fails closed."
        : "Classifier response was not valid decision JSON; auto mode fails closed.";
  }
  return { decision: "block", tier: "none", reason: lastReason };
}

export const defaultClassifyAction: ClassifyAction = async (
  ctx,
  config,
  action,
  loadedContext,
): Promise<ClassificationDecision> => {
  const classifier = await resolveClassifier(ctx, config);
  if (!classifier) {
    return {
      decision: "block",
      tier: "none",
      reason: "No classifier model/API key available; auto mode fails closed.",
    };
  }

  const userMessage: UserMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: `<loaded-project-instructions>\n${
          loadedContext || "(none)"
        }\n</loaded-project-instructions>\n\n<transcript>\n${
          buildTranscript(ctx, config.maxTranscriptLines) || "(none)"
        }\n</transcript>\n\nLatest action to classify:\n${action}`,
      },
    ],
    timestamp: Date.now(),
  };

  return classifyWithRetry(
    complete,
    classifier,
    { systemPrompt: buildClassifierPrompt(config), messages: [userMessage] },
    ctx.signal,
  );
};
