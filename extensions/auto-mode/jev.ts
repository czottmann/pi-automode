import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  approximateTokenCount,
  buildClassifierTranscript,
} from "./transcript.ts";
import {
  JEV_ALLOW_INSTRUCTION,
  JEV_AUTH_INSTRUCTION,
  JEV_CONTEXT_MARGIN_TOKENS,
  JEV_HARD_INSTRUCTION,
  JEV_SEVERITY_INSTRUCTION,
  JEV_SOFT_INSTRUCTION,
  JEV_STATE_QUESTIONS_LIMIT,
  JEV_STATE_SINGLE_QUESTION_LIMIT,
} from "./constants.ts";
import type {
  ClassificationDecision,
  ClassifierProvider,
  ClassifyResult,
  EffectiveConfig,
  JevConfig,
  JevGate,
} from "./types.ts";

// Structural interfaces matching OMP's `judgment/types.ts`. Declared locally
// so nothing depends on OMP types at compile time; stock Pi builds untouched.

export type JevNoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
};

export type JevScoreQuestion = {
  type: "score";
  instructions: string;
  criteria: readonly [string, string, ...string[]];
};

export type JevQuestion = JevNoulQuestion | JevScoreQuestion;

export type JevNoulAnswer = {
  type: "noul";
  /** Probability of yes, 0–1. */
  noul: number;
};

export type JevScoreAnswer = {
  type: "score";
  /** Probability-weighted level index; may land between levels. */
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
};

export type JevAnswer = JevNoulAnswer | JevScoreAnswer;

/**
 * Filtered Jev state: the exact action, trusted environment, loaded project
 * instructions, and the classifier transcript. Rule lists stay out — they
 * become questions, removing the indirection hop Jev handles poorly.
 */
export function buildJevState(
  action: string,
  config: EffectiveConfig,
  loadedContext: string,
  transcript: string,
): Record<string, unknown> {
  let toolName = "unknown";
  let input: unknown = action;
  try {
    const parsed = JSON.parse(action) as {
      toolName?: unknown;
      input?: unknown;
    };
    if (typeof parsed.toolName === "string") toolName = parsed.toolName;
    if (parsed.input !== undefined) input = parsed.input;
  } catch {
    // Keep the raw action as input; it is still the evidence Jev sees.
  }
  return {
    action: { toolName, input },
    environment: config.environment,
    project_instructions: loadedContext || "(none)",
    transcript: transcript || "(none)",
  };
}

/**
 * One Noul per policy rule (fan-out): positional `hard_<i>` ↔
 * `config.hardDeny[i]` etc., so a block reason names the exact rule that
 * fired. IDs are generated, never user-supplied; rule text only reaches
 * `instructions`, never a key.
 */
export function buildJevQuestions(
  config: EffectiveConfig,
): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  config.hardDeny.forEach((rule, index) => {
    questions[`hard_${index}`] = {
      type: "noul",
      instructions: `${JEV_HARD_INSTRUCTION}${rule}`,
      criteria: {
        true: "The action does this.",
        false: "The action does not do this.",
      },
    };
  });
  config.softDeny.forEach((rule, index) => {
    questions[`soft_${index}`] = {
      type: "noul",
      instructions: `${JEV_SOFT_INSTRUCTION}${rule}`,
      criteria: {
        true: "The action does this.",
        false: "The action does not do this.",
      },
    };
  });
  config.allow.forEach((rule, index) => {
    questions[`allow_${index}`] = {
      type: "noul",
      instructions: `${JEV_ALLOW_INSTRUCTION}${rule}`,
      criteria: {
        true: "The action is fully covered.",
        false: "The action is not covered.",
      },
    };
  });
  questions["explicit_auth"] = {
    type: "noul",
    instructions: JEV_AUTH_INSTRUCTION,
    criteria: {
      true: "The transcript gives direct, specific authorization.",
      false: "The transcript does not give direct, specific authorization.",
    },
  };
  questions["severity"] = {
    type: "score",
    instructions: JEV_SEVERITY_INSTRUCTION,
    criteria: [
      "No lasting effect outside the working tree",
      "Local, reversible change",
      "Irreversible local change or a change to shared state",
      "Production, external, or security-control change",
    ],
  };
  return questions;
}

/**
 * Refuse over-budget Jev requests before the call. Overruns are §8.2
 * failures governed by `onFailure`, never silent truncations of the rule
 * list.
 *
 * Jev states both limits in tokens, so both sides of the comparison are
 * approximate tokens from the same estimator the transcript budgets use.
 * Measuring UTF-8 bytes here instead would be about four times stricter than
 * the real limit, and would reject any session whose transcript reached its
 * own configured budget.
 */
export function jevRequestLimitReason(
  state: Record<string, unknown>,
  questions: Record<string, JevQuestion>,
  jev: JevConfig,
): string | undefined {
  const ids = Object.keys(questions);
  if (ids.length > jev.maxQuestions) {
    return `Jev question count ${ids.length} exceeds maxQuestions ${jev.maxQuestions}; auto mode fails closed.`;
  }
  const stateTokens = approximateTokenCount(JSON.stringify(state));
  const questionTokens = ids.map((id) =>
    approximateTokenCount(JSON.stringify(questions[id]))
  );
  const questionsLimit = JEV_STATE_QUESTIONS_LIMIT - JEV_CONTEXT_MARGIN_TOKENS;
  const total = stateTokens +
    questionTokens.reduce((sum, tokens) => sum + tokens, 0);
  if (total > questionsLimit) {
    return `Jev request exceeds the context budget (${total} approx tokens; limit ${questionsLimit}); auto mode fails closed.`;
  }
  const singleLimit = JEV_STATE_SINGLE_QUESTION_LIMIT -
    JEV_CONTEXT_MARGIN_TOKENS;
  const longest = questionTokens.length > 0 ? Math.max(...questionTokens) : 0;
  if (stateTokens + longest > singleLimit) {
    return `Jev state plus longest question exceeds the budget (${
      stateTokens + longest
    } approx tokens; limit ${singleLimit}); auto mode fails closed.`;
  }
  return undefined;
}

/**
 * Validate the judge's answer map against the asked questions. Every
 * malformed shape in §8.2 — missing answer, type mismatch, non-finite or
 * out-of-range Noul/score — is a failure, never a default allow.
 */
export function parseJevAnswers(
  answers: unknown,
  questions: Record<string, JevQuestion>,
): { answers: Record<string, JevAnswer> } | { error: string } {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return { error: "Jev response has no answer map; auto mode fails closed." };
  }
  const byId = answers as Record<string, unknown>;
  const parsed: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const raw = byId[id];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        error:
          `Jev response is missing an answer for question "${id}"; auto mode fails closed.`,
      };
    }
    const answer = raw as Record<string, unknown>;
    if (answer.type !== question.type) {
      return {
        error:
          `Jev answer type mismatch for question "${id}"; auto mode fails closed.`,
      };
    }
    if (question.type === "noul") {
      if (
        typeof answer.noul !== "number" || !Number.isFinite(answer.noul) ||
        answer.noul < 0 || answer.noul > 1
      ) {
        return {
          error:
            `Jev Noul answer for question "${id}" is not a finite number in [0,1]; auto mode fails closed.`,
        };
      }
      parsed[id] = { type: "noul", noul: answer.noul };
      continue;
    }
    const levels = question.criteria.length;
    if (
      typeof answer.score !== "number" || !Number.isFinite(answer.score) ||
      answer.score < 0 || answer.score > levels - 1
    ) {
      return {
        error:
          `Jev score answer for question "severity" is outside the declared range; auto mode fails closed.`,
      };
    }
    parsed[id] = answer as unknown as JevScoreAnswer;
  }
  return { answers: parsed };
}

export type CombinedJevDecision = ClassificationDecision & {
  /**
   * True when a hard/soft rule landed in the uncertainty band
   * `[reviewThreshold, denyThreshold)` or `severityFloor` fired. The caller
   * escalates to the generative detailed stage in `auto`/`jev-prefilter`, or
   * treats it as a §8.2 failure in `jev` mode.
   */
  reviewNeeded: boolean;
};

function noulValue(
  answers: Record<string, JevAnswer>,
  id: string,
): number | undefined {
  const answer = answers[id];
  return answer?.type === "noul" ? answer.noul : undefined;
}

/**
 * Combine Jev answers in code, mirroring `CLASSIFIER_SYSTEM_PROMPT`
 * semantics: hard rules block unconditionally; soft rules block unless an
 * allow exception or explicit authorization overrides them. Allow-side
 * probabilities deliberately get no uncertainty band — an ambiguous allow
 * exception must not rescue a soft-denied action.
 */
export function combineJevDecision(
  answers: Record<string, JevAnswer>,
  config: EffectiveConfig,
  jev: JevConfig,
): CombinedJevDecision {
  // Severity is read before any allow/authorization override so the backstop
  // still fires for an action an exception covers.
  const severity = answers["severity"];
  let reviewNeeded = severity?.type === "score" &&
    severity.score >= jev.severityFloor;

  for (let index = 0; index < config.hardDeny.length; index += 1) {
    const value = noulValue(answers, `hard_${index}`) ?? 0;
    if (value >= jev.hardDenyThreshold) {
      return {
        decision: "block",
        tier: "hard_deny",
        reason:
          `Jev matched hard-deny rule ${index}: ${config.hardDeny[index]}`,
        reviewNeeded: false,
      };
    }
    if (value >= jev.reviewThreshold) reviewNeeded = true;
  }

  let softIndex: number | undefined;
  for (let index = 0; index < config.softDeny.length; index += 1) {
    const value = noulValue(answers, `soft_${index}`) ?? 0;
    if (value >= jev.softDenyThreshold) {
      if (softIndex === undefined) softIndex = index;
    } else if (value >= jev.reviewThreshold) {
      reviewNeeded = true;
    }
  }

  if (softIndex !== undefined) {
    // An override resolves the soft-deny rule it names, never an unrelated
    // rule left in the uncertainty band, so `reviewNeeded` carries through.
    for (let index = 0; index < config.allow.length; index += 1) {
      if ((noulValue(answers, `allow_${index}`) ?? 0) >= jev.allowThreshold) {
        return {
          decision: "allow",
          tier: "allow",
          reason:
            `Jev matched allow exception ${index}; soft-deny ${softIndex} overridden.`,
          reviewNeeded,
        };
      }
    }
    if ((noulValue(answers, "explicit_auth") ?? 0) >= jev.authThreshold) {
      return {
        decision: "allow",
        tier: "explicit_intent",
        reason:
          `Jev found explicit authorization; soft-deny ${softIndex} overridden.`,
        reviewNeeded,
      };
    }
    return {
      decision: "block",
      tier: "soft_deny",
      reason: `Jev matched soft-deny rule ${softIndex}: ${config.softDeny[softIndex]}`,
      reviewNeeded: false,
    };
  }

  return {
    decision: "allow",
    tier: "none",
    reason: "Jev found no policy-relevant risk.",
    reviewNeeded,
  };
}

// --- Runtime gate and judge binding (OMP only) ------------------------------

/**
 * Minimal structural judge surface: `TypeSafeJudge` answers verbatim against
 * the request. Declared locally so tests inject a fake and stock Pi never
 * loads OMP types.
 */
export type JudgeLike = {
  label: string;
  judge: (
    request: {
      state: Record<string, unknown>;
      model?: string;
      questions: Record<string, JevQuestion>;
    },
    options?: { signal?: AbortSignal },
  ) => Promise<{
    model: string;
    answers: Record<string, unknown>;
    usage: unknown;
  }>;
};

export type JudgeFactory = (options: {
  model: string;
  timeoutMs: number;
  resolver: unknown;
}) => JudgeLike;

type TypeSafeRegistry = {
  authStorage?: { hasAuth?: (scope: string) => boolean };
  resolver?: (scope: string, options: unknown) => unknown;
};

let cachedTypeSafeModule: Promise<unknown> | undefined;

/** Test seam: drop the cached dynamic-import probe between gate tests. */
export function resetJevProbeCache(): void {
  cachedTypeSafeModule = undefined;
}

/**
 * Three inert gate conditions, checked in order: runtime exposes
 * `TypeSafeJudge`, a TypeSafe credential exists, the provider opts in. Each
 * failure falls through to the existing classifier with a diagnostic — it
 * never blocks. `"pi"` never probes the runtime at all.
 */
export async function jevAvailability(
  ctx: ExtensionContext,
  provider: ClassifierProvider,
): Promise<JevGate> {
  if (provider === "pi") {
    return { ok: false, diagnostic: "classifierProvider pi: Jev not probed" };
  }
  cachedTypeSafeModule ??= import("@earendil-works/pi-ai").catch(
    () => undefined,
  );
  const mod = (await cachedTypeSafeModule) as
    | Record<string, unknown>
    | undefined;
  if (!mod || typeof mod["TypeSafeJudge"] !== "function") {
    return { ok: false, diagnostic: "Jev needs Oh My Pi 18.2.4 or newer" };
  }
  const registry = (ctx.modelRegistry ?? {}) as TypeSafeRegistry;
  if (registry.authStorage?.hasAuth?.("typesafe") !== true) {
    return {
      ok: false,
      diagnostic: "run `/login typesafe` or set `TYPESAFE_API_KEY`",
    };
  }
  return { ok: true };
}

/**
 * Construct `TypeSafeJudge` directly with the registry's resolver — never
 * OMP's `resolveJudge()`, whose chat-model fallback would silently demote
 * the safety classifier. Returns undefined when the runtime or credential
 * is absent; the caller falls through to the existing classifier.
 */
export async function loadTypeSafeJudge(
  ctx: ExtensionContext,
  jev: JevConfig,
  createJudge?: JudgeFactory,
): Promise<JudgeLike | undefined> {
  cachedTypeSafeModule ??= import("@earendil-works/pi-ai").catch(
    () => undefined,
  );
  const mod = (await cachedTypeSafeModule) as
    | Record<string, unknown>
    | undefined;
  const Ctor = mod?.["TypeSafeJudge"] as
    | (new (options: unknown) => JudgeLike)
    | undefined;
  if (!Ctor) return undefined;
  const registry = (ctx.modelRegistry ?? {}) as TypeSafeRegistry;
  const sessionId = ctx.sessionManager?.getSessionId?.();
  const resolver = registry.resolver?.("typesafe", { sessionId });
  if (!resolver) return undefined;
  if (createJudge) return createJudge({ model: jev.model, timeoutMs: jev.timeoutMs, resolver });
  try {
    return new Ctor({ apiKey: resolver, model: jev.model, timeoutMs: jev.timeoutMs });
  } catch {
    return undefined;
  }
}

// --- Failure policy and provider action --------------------------------------

export type JevClassifyFallback = (
  ctx: ExtensionContext,
  config: EffectiveConfig,
  action: string,
  loadedContext: string,
) => Promise<
  ClassificationDecision & {
    reasoning?: ClassifyResult["reasoning"];
    io?: ClassifyResult["io"];
  }
>;

/**
 * The two generative roles Jev delegates to. `fallback` is the full staged
 * classifier used for gate misses and `onFailure: "classifier"`. `escalate`
 * runs structured review directly, so an unresolved review band reaches the
 * stage that can settle it rather than the one-token filter.
 */
export type JevClassifiers = {
  fallback: JevClassifyFallback;
  escalate: JevClassifyFallback;
};

export type JevTestSeams = {
  createJudge?: JudgeFactory;
  gate?: JevGate;
  loadJudge?: (
    ctx: ExtensionContext,
    jev: JevConfig,
  ) => Promise<JudgeLike | undefined>;
  transcript?: (ctx: ExtensionContext) => string;
};

function jevBlock(reason: string): ClassificationDecision {
  return { decision: "block", tier: "none", reason };
}

/**
 * Jev provider action: gate → state/questions → budget → one `judge()` call
 * → combine. Gate misses are inert (existing classifier + diagnostic).
 * Post-gate failures follow `jev.onFailure`: fall back to the user's own
 * generative classifier, or fail closed. `ctx.signal` abort ignores
 * `onFailure` and reports Cancelled. `auto`/`jev-prefilter` escalate an
 * unresolved band to the detailed stage; `jev` treats it as a failure.
 */
export async function jevClassifyAction(
  ctx: ExtensionContext,
  config: EffectiveConfig,
  action: string,
  loadedContext: string,
  classifiers: JevClassifiers,
  seams: JevTestSeams = {},
): Promise<ClassifyResult> {
  const started = Date.now();
  const reasoning = { mode: "server-default" } as const;
  const { fallback, escalate } = classifiers;
  const gate = seams.gate ?? await jevAvailability(ctx, config.classifierProvider);
  if (!gate.ok) {
    const pi = await fallback(ctx, config, action, loadedContext);
    return {
      ...pi,
      jevGate: gate,
      io: pi.io ? { ...pi.io, provider: config.classifierProvider } : undefined,
    };
  }
  if (ctx.signal?.aborted) {
    return { ...jevBlock("Cancelled"), reasoning, jevGate: gate };
  }
  const transcript = seams.transcript
    ? seams.transcript(ctx)
    : buildClassifierTranscript(ctx, {
      maxUserTokens: config.maxUserTranscriptTokens,
      maxToolTokens: config.maxToolTranscriptTokens,
    });
  const state = buildJevState(action, config, loadedContext, transcript);
  const questions = buildJevQuestions(config);
  const limitReason = jevRequestLimitReason(state, questions, config.jev);
  const jevIoBase = {
    provider: "jev" as const,
    model: config.jev.model,
    state,
    questions: questions as Record<string, unknown>,
  };
  const fail = async (failureReason: string): Promise<ClassifyResult> => {
    if (config.jev.onFailure === "block") {
      return {
        ...jevBlock(`Jev unavailable (${failureReason}); auto mode fails closed.`),
        reasoning,
        jevGate: gate,
        io: {
          model: config.jev.model,
          provider: config.classifierProvider,
          jev: { ...jevIoBase, answers: {}, failureReason, fallback: "block" },
          reasoning,
          prompt: { system: "", context: "", action, fastInstruction: "", detailedInstruction: "" },
          attempts: [],
          durationMs: Date.now() - started,
        },
      };
    }
    const pi = await fallback(ctx, config, action, loadedContext);
    return {
      ...pi,
      jevGate: gate,
      io: pi.io
        ? {
          ...pi.io,
          provider: config.classifierProvider,
          jev: { ...jevIoBase, answers: {}, failureReason, fallback: "classifier" },
        }
        : undefined,
    };
  };
  if (limitReason) return fail(limitReason);
  const load = seams.loadJudge ??
    ((c, j) => loadTypeSafeJudge(c, j, seams.createJudge));
  let judge: JudgeLike | undefined;
  try {
    judge = await load(ctx, config.jev);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (!judge) return fail("judge could not be constructed");
  let result: { model: string; answers: Record<string, unknown>; usage: unknown };
  try {
    result = await judge.judge(
      { state, model: config.jev.model, questions },
      { signal: ctx.signal },
    );
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const parsed = parseJevAnswers(result.answers, questions);
  if ("error" in parsed) return fail(parsed.error);
  const combined = combineJevDecision(parsed.answers, config, config.jev);
  const jevBranch = {
    ...jevIoBase,
    answers: parsed.answers as Record<string, unknown>,
    fallback: "none" as const,
  };
  if (
    combined.reviewNeeded && config.classifierProvider !== "jev"
  ) {
    const pi = await escalate(ctx, config, action, loadedContext);
    const escalated = { ...jevBranch, fallback: "escalate" as const };
    return {
      ...pi,
      jevGate: gate,
      io: pi.io
        ? { ...pi.io, provider: config.classifierProvider, jev: escalated }
        : {
          model: config.jev.model,
          provider: config.classifierProvider,
          jev: escalated,
          reasoning,
          prompt: { system: "", context: "", action, fastInstruction: "", detailedInstruction: "" },
          attempts: [],
          durationMs: Date.now() - started,
        },
    };
  }
  if (combined.reviewNeeded) {
    return {
      ...jevBlock("Jev decision uncertain (review band unresolved); auto mode fails closed."),
      reasoning,
      jevGate: gate,
      io: {
        model: result.model || config.jev.model,
        provider: config.classifierProvider,
        jev: { ...jevBranch, failureReason: "review band unresolved", fallback: "block" },
        reasoning,
        prompt: { system: "", context: "", action, fastInstruction: "", detailedInstruction: "" },
        attempts: [],
        durationMs: Date.now() - started,
      },
    };
  }
  return {
    ...combined,
    reasoning,
    jevGate: gate,
    io: {
      model: result.model || config.jev.model,
      provider: config.classifierProvider,
      jev: jevBranch,
      reasoning,
      prompt: { system: "", context: "", action, fastInstruction: "", detailedInstruction: "" },
      attempts: [],
      durationMs: Date.now() - started,
    },
  };
}
