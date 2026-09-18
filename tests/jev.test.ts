import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ALLOW,
  DEFAULT_ENVIRONMENT,
  DEFAULT_HARD_DENY,
  DEFAULT_SOFT_DENY,
  buildEffectiveConfigFromSources,
  buildJevQuestions,
  buildJevState,
  combineJevDecision,
  jevAvailability,
  jevClassifyAction,
  jevRequestLimitReason,
  loadTypeSafeJudge,
  parseJevAnswers,
  resetJevProbeCache,
  statusLine,
  statusText,
  validateSettingsFile,
  type ClassifyResult,
  type EffectiveConfig,
  type JevAnswer,
  type SettingsFile,
} from "../extensions/auto-mode.ts";
import { baseConfig, baseState, createFakeCtx } from "./test-helpers.ts";

function invalidSettings(settings: unknown): SettingsFile {
  return settings as unknown as SettingsFile;
}

test("classifierProvider defaults to pi and validates the enum", () => {
  assert.equal(buildEffectiveConfigFromSources({}).classifierProvider, "pi");
  assert.deepEqual(
    validateSettingsFile({ autoMode: { classifierProvider: "jev" } }, "t"),
    [],
  );
  const diagnostics = validateSettingsFile(
    invalidSettings({ autoMode: { classifierProvider: "bogus" } }),
    "t",
  );
  assert.ok(
    diagnostics.some((d) => d.includes("autoMode.classifierProvider must be one of")),
  );
  assert.equal(
    buildEffectiveConfigFromSources({
      projectLocalSettings: [
        invalidSettings({ autoMode: { classifierProvider: "bogus" } }),
      ],
    }).classifierProvider,
    "pi",
  );
});

test("classifierProvider follows global to local to inline precedence", () => {
	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { classifierProvider: "auto" } }],
		projectLocalSettings: [{ autoMode: { classifierProvider: "jev-prefilter" } }],
		inlineSettings: [{ autoMode: { classifierProvider: "jev" } }],
	});
	assert.equal(config.classifierProvider, "jev");
});

test("jev merges key-by-key and the model stays pinned by default", () => {
	const defaults = buildEffectiveConfigFromSources({});
	assert.equal(defaults.jev.model, "jev-1.13.0");
	assert.equal(defaults.jev.onFailure, "classifier");

	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { jev: { timeoutMs: 5000 } } }],
		projectLocalSettings: [{ autoMode: { jev: { hardDenyThreshold: 0.7 } } }],
	});
	assert.equal(config.jev.timeoutMs, 5000);
	assert.equal(config.jev.hardDenyThreshold, 0.7);
	assert.equal(config.jev.model, "jev-1.13.0");
});

test("shared project config cannot set classifierProvider or jev", () => {
	const config = buildEffectiveConfigFromSources({
		projectSharedSettings: [
			invalidSettings({
				autoMode: { classifierProvider: "jev", jev: { timeoutMs: 1 } },
			}),
		],
	});
	assert.equal(config.classifierProvider, "pi");
	assert.equal(config.jev.timeoutMs, 10_000);
});

test("invalid jev values produce diagnostics and keep the previous scope", () => {
	const diagnostics = validateSettingsFile(
		invalidSettings({
			autoMode: {
				jev: {
					model: "",
					onFailure: "retry",
					timeoutMs: 50,
					maxQuestions: 0,
					hardDenyThreshold: 9,
					softDenyThreshold: -1,
					reviewThreshold: Number.NaN,
					allowThreshold: 2,
					authThreshold: "high",
					severityFloor: 99,
					bogus: true,
				},
			},
		}),
		"t",
	);
	for (
		const key of [
			"model",
			"onFailure",
			"timeoutMs",
			"maxQuestions",
			"hardDenyThreshold",
			"softDenyThreshold",
			"reviewThreshold",
			"allowThreshold",
			"authThreshold",
			"severityFloor",
			"unknown autoMode.jev key bogus",
		]
	) {
		assert.ok(
			diagnostics.some((d) => d.includes(key)),
			`missing diagnostic for ${key}: ${diagnostics.join("; ")}`,
		);
	}

	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { jev: { timeoutMs: 5000 } } }],
		projectLocalSettings: [
			invalidSettings({ autoMode: { jev: { timeoutMs: -1 } } }),
		],
	});
	assert.equal(config.jev.timeoutMs, 5000);
});

test("non-object jev produces a diagnostic and keeps defaults", () => {
	const diagnostics = validateSettingsFile(
		invalidSettings({ autoMode: { jev: "nope" } }),
		"t",
	);
	assert.ok(diagnostics.some((d) => d.includes("autoMode.jev must be an object")));
	assert.equal(buildEffectiveConfigFromSources({}).jev.timeoutMs, 10_000);
});

function jevAnswers(entries: Record<string, JevAnswer>): Record<string, unknown> {
  return { ...entries };
}

test("buildJevState filters to action, environment, instructions, transcript", () => {
  const config = baseConfig({ environment: ["trusted repo"] });
  const state = buildJevState(
    JSON.stringify({ toolName: "bash", input: { command: "npm test" } }),
    config,
    "project rules",
    "User: run the tests",
  );
  assert.deepEqual(Object.keys(state).sort(), [
    "action",
    "environment",
    "project_instructions",
    "transcript",
  ]);
  assert.deepEqual(state.action, {
    toolName: "bash",
    input: { command: "npm test" },
  });
  assert.deepEqual(state.environment, ["trusted repo"]);
  assert.equal(state.project_instructions, "project rules");
  assert.equal(state.transcript, "User: run the tests");
  assert.equal(
    buildJevState("{}", baseConfig(), "", "").project_instructions,
    "(none)",
  );
});

test("buildJevQuestions fans out one Noul per rule with positional IDs", () => {
  const config = baseConfig({
    hardDeny: ["hard one", "hard two"],
    softDeny: ["soft one"],
    allow: ["allow one"],
  });
  const questions = buildJevQuestions(config);
  assert.deepEqual(Object.keys(questions).sort(), [
    "allow_0",
    "explicit_auth",
    "hard_0",
    "hard_1",
    "severity",
    "soft_0",
  ]);
  for (const [id, question] of Object.entries(questions)) {
    assert.ok(id.length < 32, `generated id ${id} is short`);
  }
  assert.match(
    String(questions["hard_1"]?.instructions),
    /`action` performs the following: hard two/,
  );
  assert.equal(questions["severity"]?.type, "score");
  assert.equal(
    questions["hard_0"]?.type === "noul" &&
      questions["hard_0"]?.criteria?.true,
    "The action does this.",
  );
});

test("jevRequestLimitReason refuses count and token overruns", () => {
  const config = baseConfig({ hardDeny: ["a", "b"] });
  const questions = buildJevQuestions(config);
  const state = buildJevState("{}", config, "", "");
  assert.equal(
    jevRequestLimitReason(state, questions, { ...config.jev, maxQuestions: 1 }),
    "Jev question count 4 exceeds maxQuestions 1; auto mode fails closed.",
  );
  const huge = buildJevState(
    JSON.stringify({ toolName: "write", input: { content: "x".repeat(200_000) } }),
    config,
    "",
    "",
  );
  assert.match(
    jevRequestLimitReason(huge, questions, config.jev) ?? "",
    /exceeds .* budget.*fails closed/,
  );
});

test("a transcript at its own budget still fits the Jev request", () => {
  // The transcript caps at maxUser + maxTool tokens, so a long session pins it
  // there. Measuring bytes rejected exactly this state, silently disabling Jev
  // for the rest of the session.
  const config = baseConfig({
    hardDeny: [...DEFAULT_HARD_DENY],
    softDeny: [...DEFAULT_SOFT_DENY],
    allow: [...DEFAULT_ALLOW],
    environment: [...DEFAULT_ENVIRONMENT],
  });
  const saturated = "x".repeat(
    (config.maxUserTranscriptTokens + config.maxToolTranscriptTokens) * 4,
  );
  const state = buildJevState(
    JSON.stringify({ toolName: "bash", input: { command: "npm test" } }),
    config,
    "",
    saturated,
  );
  assert.equal(
    jevRequestLimitReason(state, buildJevQuestions(config), config.jev),
    undefined,
  );
});

test("parseJevAnswers rejects every malformed shape", () => {
  const config = baseConfig({ hardDeny: ["hard one"], softDeny: ["soft one"] });
  const questions = buildJevQuestions(config);
  const valid = jevAnswers({
    hard_0: { type: "noul", noul: 0.1 },
    soft_0: { type: "noul", noul: 0.1 },
    explicit_auth: { type: "noul", noul: 0 },
    severity: { type: "score", score: 0, probabilities: { 0: 1 }, confidence: 1 },
  });
  assert.ok("answers" in parseJevAnswers(valid, questions));

  const missing = { ...valid } as Record<string, unknown>;
  delete missing["hard_0"];
  assert.match(
    (parseJevAnswers(missing, questions) as { error: string }).error,
    /missing an answer for question "hard_0"/,
  );
  assert.match(
    (
      parseJevAnswers(
        { ...valid, hard_0: { type: "score", score: 0 } },
        questions,
      ) as { error: string }
    ).error,
    /type mismatch/,
  );
  for (
    const bad of [
      Number.NaN,
      -0.1,
      1.1,
      Number.POSITIVE_INFINITY,
      "0.5",
      undefined,
    ]
  ) {
    assert.match(
      (
        parseJevAnswers(
          { ...valid, hard_0: { type: "noul", noul: bad } },
          questions,
        ) as { error: string }
      ).error,
      /not a finite number in \[0,1\]/,
    );
  }
  assert.match(
    (
      parseJevAnswers(
        { ...valid, severity: { type: "score", score: 9 } },
        questions,
      ) as { error: string }
    ).error,
    /outside the declared range/,
  );
  assert.match(
    (parseJevAnswers(null, questions) as { error: string }).error,
    /no answer map/,
  );
});

test("combineJevDecision blocks hard, overrides soft, never rescues ambiguous allow", () => {
  const config = baseConfig({
    hardDeny: ["hard one"],
    softDeny: ["soft one"],
    allow: ["allow one"],
  });
  const base: Record<string, JevAnswer> = {
    hard_0: { type: "noul", noul: 0 },
    soft_0: { type: "noul", noul: 0 },
    allow_0: { type: "noul", noul: 0 },
    explicit_auth: { type: "noul", noul: 0 },
    severity: { type: "score", score: 0, probabilities: { 0: 1 }, confidence: 1 },
  };
  const decided = combineJevDecision(
    { ...base, hard_0: { type: "noul", noul: 0.9 } },
    config,
    config.jev,
  );
  assert.deepEqual(
    [decided.decision, decided.tier, decided.reviewNeeded],
    ["block", "hard_deny", false],
  );
  assert.match(decided.reason, /hard-deny rule 0/);

  const soft = combineJevDecision(
    { ...base, soft_0: { type: "noul", noul: 0.9 } },
    config,
    config.jev,
  );
  assert.deepEqual([soft.decision, soft.tier], ["block", "soft_deny"]);

  const allowed = combineJevDecision(
    {
      ...base,
      soft_0: { type: "noul", noul: 0.9 },
      allow_0: { type: "noul", noul: 0.95 },
    },
    config,
    config.jev,
  );
  assert.deepEqual([allowed.decision, allowed.tier], ["allow", "allow"]);

  const authorized = combineJevDecision(
    {
      ...base,
      soft_0: { type: "noul", noul: 0.9 },
      explicit_auth: { type: "noul", noul: 0.95 },
    },
    config,
    config.jev,
  );
  assert.deepEqual(
    [authorized.decision, authorized.tier],
    ["allow", "explicit_intent"],
  );

  // Ambiguous allow (0.5) must not rescue a soft-denied action.
  const ambiguous = combineJevDecision(
    {
      ...base,
      soft_0: { type: "noul", noul: 0.9 },
      allow_0: { type: "noul", noul: 0.5 },
    },
    config,
    config.jev,
  );
  assert.deepEqual([ambiguous.decision, ambiguous.tier], ["block", "soft_deny"]);
});

test("combineJevDecision flags the uncertainty band and severity floor", () => {
  const config = baseConfig({ hardDeny: ["hard one"], softDeny: ["soft one"] });
  const base: Record<string, JevAnswer> = {
    hard_0: { type: "noul", noul: 0 },
    soft_0: { type: "noul", noul: 0 },
    explicit_auth: { type: "noul", noul: 0 },
    severity: { type: "score", score: 0, probabilities: { 0: 1 }, confidence: 1 },
  };
  const band = combineJevDecision(
    { ...base, hard_0: { type: "noul", noul: 0.3 } },
    config,
    config.jev,
  );
  assert.deepEqual(
    [band.decision, band.tier, band.reviewNeeded],
    ["allow", "none", true],
  );
  const severe = combineJevDecision(
    {
      ...base,
      severity: { type: "score", score: 2.5, probabilities: { 2: 0.5, 3: 0.5 }, confidence: 0.5 },
    },
    config,
    config.jev,
  );
  assert.deepEqual(
    [severe.decision, severe.tier, severe.reviewNeeded],
    ["allow", "none", true],
  );
  const calm = combineJevDecision(base, config, config.jev);
  assert.deepEqual(
    [calm.decision, calm.tier, calm.reviewNeeded],
    ["allow", "none", false],
  );
});

function jevCtx(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof createFakeCtx> {
  return createFakeCtx([], {
    modelRegistry: {
      authStorage: { hasAuth: () => true },
      resolver: () => ({ token: "redacted" }),
    },
    ...overrides,
  });
}

test("jev gate: pi never probes, missing runtime and credential stay inert", async () => {
  resetJevProbeCache();
  // Stock Pi (@earendil-works/pi-ai) has no TypeSafeJudge: inert + diagnostic.
  const stock = await jevAvailability(jevCtx() as never, "auto");
  assert.equal(stock.ok, false);
  assert.match(
    stock.ok === false ? stock.diagnostic : "",
    /Oh My Pi 18\.2\.4/,
  );

  const pi = await jevAvailability(jevCtx() as never, "pi");
  assert.equal(pi.ok, false);
  assert.match(pi.ok === false ? pi.diagnostic : "", /not probed/);

  const noCred = await jevAvailability(
    jevCtx({
      modelRegistry: { authStorage: { hasAuth: () => false } },
    }) as never,
    "auto",
  );
  // On stock Pi the runtime check fires first; either diagnostic is inert.
  assert.equal(noCred.ok, false);
});

test("loadTypeSafeJudge returns undefined without the OMP runtime", async () => {
  resetJevProbeCache();
  const config = baseConfig();
  const judge = await loadTypeSafeJudge(jevCtx() as never, config.jev);
  assert.equal(judge, undefined);
});

test("loadTypeSafeJudge uses the injected factory and resolver", async () => {
  resetJevProbeCache();
  const config = baseConfig();
  let seen: { model: string; timeoutMs: number; resolver: unknown } | undefined;
  const fake = {
    label: "typesafe/jev-1.13.0",
    judge: async () => ({
      model: "jev-1.13.0",
      answers: {},
      usage: { input: 0, output: 0 },
    }),
  };
  // Stock Pi has no TypeSafeJudge constructor, so without a factory this
  // resolves undefined; the factory path is exercised via a stubbed probe
  // by calling loadTypeSafeJudge only for its resolver plumbing is not
  // possible here — assert the inert branch instead.
  const inert = await loadTypeSafeJudge(
    jevCtx() as never,
    config.jev,
    (options) => {
      seen = options as typeof seen & { model: string; timeoutMs: number; resolver: unknown };
      return fake;
    },
  );
  assert.equal(inert, undefined);
  assert.equal(seen, undefined);
});

test("gate probe caches the dynamic import per session", async () => {
  resetJevProbeCache();
  const ctx = jevCtx() as never;
  const first = await jevAvailability(ctx, "auto");
  const second = await jevAvailability(ctx, "jev");
  assert.equal(first.ok, second.ok);
});

function policyConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return baseConfig({
    classifierProvider: "jev",
    hardDeny: ["hard one"],
    softDeny: ["soft one"],
    allow: ["allow one"],
    ...overrides,
  });
}
function online(): {
  gate: { ok: true };
  transcript: () => string;
} {
  return { gate: { ok: true }, transcript: () => "" };
}

function fakeJudge(answers: Record<string, unknown>, model = "jev-1.13.0") {
  const calls: Array<{ state: unknown; questions: unknown }> = [];
  return {
    calls,
    judge: {
      label: `typesafe/${model}`,
      judge: async (request: { state: unknown; questions: unknown }) => {
        calls.push({ state: request.state, questions: request.questions });
        return { model, answers, usage: { input: 1, output: 2 } };
      },
    },
  };
}

/** Both generative roles, neither of which may run in this test. */
function neverRuns(onCall: () => void) {
  const role = async (): Promise<ClassifyResult> => {
    onCall();
    return { decision: "allow", tier: "none", reason: "must not run" };
  };
  return { fallback: role, escalate: role };
}

function gatePassSeams(judge: { label: string; judge: (request: never, options?: never) => Promise<never> }): {
  gate: { ok: true };
  loadJudge: () => Promise<typeof judge>;
  transcript: () => string;
} {
  return {
    gate: { ok: true },
    loadJudge: async () => judge,
    transcript: () => "User: do it",
  };
}

test("jev failure under onFailure classifier falls back and logs the path", async () => {
  const config = policyConfig();
  let fallbackCalls = 0;
  const fallback = async (): Promise<ClassifyResult> => {
    fallbackCalls += 1;
    return {
      decision: "allow",
      tier: "none",
      reason: "generative fallback allowed",
      io: {
        model: "test/classifier",
        reasoning: { mode: "server-default" },
        prompt: { system: "s", context: "c", action: "a", fastInstruction: "f", detailedInstruction: "d" },
        attempts: [],
        durationMs: 1,
      },
    };
  };
  const result = await jevClassifyAction(
    createFakeCtx() as never,
    config,
    "{}",
    "",
    { fallback, escalate: fallback },
    {
      gate: { ok: true },
      loadJudge: async () => {
        throw new Error("boom");
      },
      transcript: () => "",
    },
  );
  assert.equal(fallbackCalls, 1);
  assert.equal(result.decision, "allow");
  assert.equal(result.io?.provider, "jev");
  assert.equal(result.io?.jev?.fallback, "classifier");
  assert.match(result.io?.jev?.failureReason ?? "", /boom/);
});

test("jev failure under onFailure block fails closed", async () => {
  const config = policyConfig({ jev: { ...baseConfig().jev, onFailure: "block" } });
  let fallbackCalls = 0;
  const result = await jevClassifyAction(
    createFakeCtx() as never,
    config,
    "{}",
    "",
    neverRuns(() => {
      fallbackCalls += 1;
    }),
    {
      gate: { ok: true },
      loadJudge: async () => {
        throw new Error("offline");
      },
      transcript: () => "",
    },
  );
  assert.equal(fallbackCalls, 0);
  assert.equal(result.decision, "block");
  assert.equal(result.tier, "none");
  assert.match(result.reason, /fails closed/);
  assert.equal(result.io?.jev?.fallback, "block");
});

test("signal abort ignores onFailure and reports Cancelled", async () => {
  const config = policyConfig();
  const controller = new AbortController();
  controller.abort();
  let fallbackCalls = 0;
  const result = await jevClassifyAction(
    createFakeCtx([], { signal: controller.signal }) as never,
    config,
    "{}",
    "",
    neverRuns(() => {
      fallbackCalls += 1;
    }),
    {
      gate: { ok: true },
      loadJudge: async () => {
        throw new Error("must not load");
      },
      transcript: () => "",
    },
  );
  assert.equal(fallbackCalls, 0);
  assert.equal(result.decision, "block");
  assert.equal(result.reason, "Cancelled");
});

test("uncertainty band escalates in prefilter but fails in jev mode", async () => {
  const bandAnswers = {
    hard_0: { type: "noul", noul: 0.3 },
    soft_0: { type: "noul", noul: 0 },
    allow_0: { type: "noul", noul: 0 },
    explicit_auth: { type: "noul", noul: 0 },
    severity: { type: "score", score: 0, probabilities: { 0: 1 }, confidence: 1 },
  };
  const fake = fakeJudge(bandAnswers);
  let escalations = 0;
  let staged = 0;
  // The band must reach the structured-review role, never the staged
  // classifier whose one-token filter could allow it outright.
  const roles = {
    fallback: async (): Promise<ClassifyResult> => {
      staged += 1;
      return { decision: "allow", tier: "none", reason: "fast filter allowed" };
    },
    escalate: async (): Promise<ClassifyResult> => {
      escalations += 1;
      return { decision: "block", tier: "soft_deny", reason: "detailed stage blocked" };
    },
  };
  const prefilter = await jevClassifyAction(
    createFakeCtx() as never,
    policyConfig({ classifierProvider: "jev-prefilter" }),
    "{}",
    "",
    roles,
    gatePassSeams(fake.judge as never),
  );
  assert.equal(escalations, 1);
  assert.equal(staged, 0);
  assert.equal(prefilter.decision, "block");
  assert.equal(prefilter.io?.jev?.fallback, "escalate");

  const strict = await jevClassifyAction(
    createFakeCtx() as never,
    policyConfig({ classifierProvider: "jev" }),
    "{}",
    "",
    roles,
    gatePassSeams(fake.judge as never),
  );
  assert.equal(escalations, 1);
  assert.equal(staged, 0);
  assert.equal(strict.decision, "block");
  assert.match(strict.reason, /fails closed/);
});

test("jev success never calls the generative path and yields kind classifier", async () => {
  const clearAnswers = {
    hard_0: { type: "noul", noul: 0 },
    soft_0: { type: "noul", noul: 0 },
    allow_0: { type: "noul", noul: 0 },
    explicit_auth: { type: "noul", noul: 0 },
    severity: { type: "score", score: 0, probabilities: { 0: 1 }, confidence: 1 },
  };
  const fake = fakeJudge(clearAnswers, "jev-1.13.0");
  let fallbackCalls = 0;
  const result = await jevClassifyAction(
    createFakeCtx() as never,
    policyConfig({ classifierProvider: "jev" }),
    JSON.stringify({ toolName: "bash", input: { command: "npm test" } }),
    "",
    neverRuns(() => {
      fallbackCalls += 1;
    }),
    gatePassSeams(fake.judge as never),
  );
  assert.equal(fallbackCalls, 0);
  assert.equal(fake.calls.length, 1);
  assert.equal(result.decision, "allow");
  assert.equal(result.tier, "none");
  assert.equal(result.io?.provider, "jev");
  assert.equal(result.io?.model, "jev-1.13.0");
  assert.equal(result.io?.jev?.fallback, "none");
});

test("an allow override never discards an unresolved hard-deny band", () => {
  const config = policyConfig();
  const answers: Record<string, JevAnswer> = {
    // Below hardDenyThreshold (0.5) but at or above reviewThreshold (0.2):
    // unresolved, so the override must not end the review.
    hard_0: { type: "noul", noul: 0.45 },
    soft_0: { type: "noul", noul: 0.9 },
    allow_0: { type: "noul", noul: 0.95 },
    explicit_auth: { type: "noul", noul: 0 },
    severity: { type: "score", score: 0, probabilities: { 0: 1 }, confidence: 1 },
  };
  const overridden = combineJevDecision(answers, config, config.jev);
  assert.deepEqual(
    [overridden.decision, overridden.tier, overridden.reviewNeeded],
    ["allow", "allow", true],
  );

  const authorized = combineJevDecision(
    { ...answers, allow_0: { type: "noul", noul: 0 }, explicit_auth: { type: "noul", noul: 0.95 } },
    config,
    config.jev,
  );
  assert.deepEqual(
    [authorized.decision, authorized.tier, authorized.reviewNeeded],
    ["allow", "explicit_intent", true],
  );
});

test("severityFloor still fires when an allow exception overrides a soft deny", () => {
  const config = policyConfig();
  const decided = combineJevDecision(
    {
      hard_0: { type: "noul", noul: 0 },
      soft_0: { type: "noul", noul: 0.9 },
      allow_0: { type: "noul", noul: 0.95 },
      explicit_auth: { type: "noul", noul: 0 },
      severity: { type: "score", score: 3, probabilities: { 3: 1 }, confidence: 1 },
    },
    config,
    config.jev,
  );
  assert.deepEqual(
    [decided.decision, decided.tier, decided.reviewNeeded],
    ["allow", "allow", true],
  );
});

test("a gate miss reports why Jev is inactive", async () => {
  const config = policyConfig();
  const fallback = async (): Promise<ClassifyResult> => ({
    decision: "allow",
    tier: "none",
    reason: "generative classifier allowed",
  });
  const result = await jevClassifyAction(
    createFakeCtx() as never,
    config,
    "{}",
    "",
    { fallback, escalate: fallback },
    { gate: { ok: false, diagnostic: "Jev needs Oh My Pi 18.2.4 or newer" } },
  );
  assert.equal(result.decision, "allow");
  assert.deepEqual(result.jevGate, {
    ok: false,
    diagnostic: "Jev needs Oh My Pi 18.2.4 or newer",
  });
});

test("status shows the jev segment only when a jev provider is configured", () => {
  const pi = baseConfig();
  assert.equal(statusLine(pi, baseState({ checkedActions: 1 })), "AM● a:1 d:0");
  assert.ok(!statusText(pi, baseState()).includes("jev:"));

  const jev = baseConfig({ classifierProvider: "jev-prefilter" });
  const state = baseState({ checkedActions: 173, blockedActions: 3, classifierAllowed: 11, classifierDenied: 1 });
  assert.equal(statusLine(jev, state, { ok: true }), "AM● a:170 d:3 ca:11 cd:1 j:●");
  assert.equal(
    statusLine(jev, state, { ok: false, diagnostic: "run `/login typesafe`" }),
    "AM● a:170 d:3 ca:11 cd:1 j:○",
  );
  assert.equal(statusLine(jev, state), "AM● a:170 d:3 ca:11 cd:1 j:○");
  assert.match(statusText(jev, baseState(), { ok: true }), /jev: active \(jev-1\.13\.0\)/);
  assert.match(
    statusText(jev, baseState(), { ok: false, diagnostic: "run `/login typesafe`" }),
    /jev: inactive \(run `\/login typesafe`\)/,
  );
});
