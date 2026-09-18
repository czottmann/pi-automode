import type { ClassificationDecision, ClassifierIoAttempt, EffectiveConfig } from "./types.ts";

/** `classifierModel: "typesafe/jev-latest"` routes classification to TypeSafe's System One API. */
export const JEV_PROVIDER = "typesafe";
export const JEV_API_KEY_ENV = "TYPESAFE_API_KEY";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MAX_CHOICE_OPTIONS = 255;
// ponytail: one fixed risk tolerance; make it a config key once real traffic shows where it should sit.
const JEV_RISK_TOLERANCE = 0.2;

type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string };

export type JevRequest = {
  model: string;
  state: Record<string, string>;
  questions: Record<string, JevQuestion>;
};

/**
 * One System One call replaces both LLM stages: the configured deny rules are
 * the Choice categories, and two Noul questions cover soft-deny exceptions.
 */
export function buildJevRequest(
  model: string,
  config: EffectiveConfig,
  prompt: { policy: string; context: string; action: string },
): JevRequest {
  const criteria: Record<string, string> = {
    none: "The action matches none of the HARD_DENY or SOFT_DENY rules.",
  };
  config.hardDeny.forEach((rule, i) => (criteria[`hard_deny_${i + 1}`] = rule));
  config.softDeny.forEach((rule, i) => (criteria[`soft_deny_${i + 1}`] = rule));
  return {
    model,
    state: {
      policy: prompt.policy,
      context: prompt.context,
      untrusted_action: prompt.action,
    },
    questions: {
      rule: {
        type: "choice",
        instructions:
          "Which deny rule from the policy does the agent's current tool action (untrusted_action) match? Choose none only when no HARD_DENY or SOFT_DENY rule matches.",
        criteria,
      },
      allow_exception: {
        type: "noul",
        instructions:
          "An ALLOW exception from the policy clearly covers the agent's current tool action.",
      },
      user_authorized: {
        type: "noul",
        instructions:
          "The retained user transcript contains direct, specific user authorization for exactly this risky action, and no later user message narrows or revokes it. General requests such as \"clean up the repo\" do not count.",
      },
    },
  };
}

const block = (reason: string): ClassificationDecision => ({
  decision: "block",
  tier: "none",
  reason: `Jev classifier failed; auto mode fails closed: ${reason}`,
});

function noul(answer: unknown): number | undefined {
  const value = (answer as { type?: unknown; noul?: unknown } | undefined);
  return value?.type === "noul" && typeof value.noul === "number"
    ? value.noul
    : undefined;
}

/** Map Jev's typed answers onto the hard-deny / soft-deny / allow semantics. Malformed answers fail closed. */
export function decideFromJevAnswers(
  answers: unknown,
  config: EffectiveConfig,
): ClassificationDecision {
  const record = (answers ?? {}) as Record<string, unknown>;
  const rule = record.rule as
    | { type?: unknown; probabilities?: unknown }
    | undefined;
  const allowException = noul(record.allow_exception);
  const userAuthorized = noul(record.user_authorized);
  if (
    rule?.type !== "choice" || !rule.probabilities ||
    typeof rule.probabilities !== "object" ||
    allowException === undefined || userAuthorized === undefined
  ) {
    return block("response did not contain the expected typed answers.");
  }
  const probabilities = rule.probabilities as Record<string, unknown>;
  const p = (key: string) =>
    typeof probabilities[key] === "number" ? probabilities[key] as number : 0;

  if (p("none") >= 1 - JEV_RISK_TOLERANCE) {
    return { decision: "allow", tier: "none", reason: "Jev matched no deny rule." };
  }

  const topRule = (rules: string[], prefix: string) =>
    rules
      .map((text, i) => ({ text, p: p(`${prefix}_${i + 1}`) }))
      .reduce<{ text: string; p: number } | undefined>(
        (best, r) => (!best || r.p > best.p ? r : best),
        undefined,
      );
  const hard = topRule(config.hardDeny, "hard_deny");
  const soft = topRule(config.softDeny, "soft_deny");
  const hardMass = config.hardDeny.reduce((sum, _r, i) => sum + p(`hard_deny_${i + 1}`), 0);

  // Exceptions never override hard-deny, so any real hard-deny mass keeps the block.
  if (hard && (hardMass >= JEV_RISK_TOLERANCE || !soft || hard.p >= soft.p)) {
    return { decision: "block", tier: "hard_deny", reason: `Matches hard-deny rule: ${hard.text}` };
  }
  if (!soft) return block("no deny rules configured but the action was not clearly allowed.");
  if (allowException >= 1 - JEV_RISK_TOLERANCE) {
    return { decision: "allow", tier: "allow", reason: `ALLOW exception covers soft-deny rule: ${soft.text}` };
  }
  if (userAuthorized >= 1 - JEV_RISK_TOLERANCE) {
    return { decision: "allow", tier: "explicit_intent", reason: `User authorized soft-deny action: ${soft.text}` };
  }
  return { decision: "block", tier: "soft_deny", reason: `Matches soft-deny rule: ${soft.text}` };
}

/** Call TypeSafe's System One API once and decide locally from the typed answers. */
export async function classifyWithJev(
  request: JevRequest,
  config: EffectiveConfig,
  signal: AbortSignal | undefined,
  onAttempt: (attempt: ClassifierIoAttempt) => void,
  fetchFn: typeof fetch = fetch,
): Promise<ClassificationDecision> {
  const apiKey = process.env[JEV_API_KEY_ENV];
  if (!apiKey) return block(`${JEV_API_KEY_ENV} is not set.`);
  if (Object.keys((request.questions.rule as { criteria: object }).criteria).length > JEV_MAX_CHOICE_OPTIONS) {
    return block(`more than ${JEV_MAX_CHOICE_OPTIONS - 1} deny rules configured.`);
  }

  const started = Date.now();
  const timeout = AbortSignal.timeout(config.classifierTimeoutMs);
  let body: { model?: string; answers?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
  try {
    const response = await fetchFn(JEV_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    body = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onAttempt({ stage: "detailed", attempt: 1, error: message, durationMs: Date.now() - started });
    return block(message);
  }

  const decision = decideFromJevAnswers(body.answers, config);
  const input = body.usage?.input_tokens ?? 0;
  const output = body.usage?.output_tokens ?? 0;
  onAttempt({
    stage: "detailed",
    attempt: 1,
    response: {
      stopReason: "stop",
      text: JSON.stringify(body.answers ?? null),
      model: body.model ?? request.model,
      timestamp: Date.now(),
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    parsed: decision,
    durationMs: Date.now() - started,
  });
  return decision;
}
