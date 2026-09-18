import test from "node:test";
import assert from "node:assert/strict";
import {
	buildJevRequest,
	classifyWithJev,
	decideFromJevAnswers,
	type ClassifierIoAttempt,
} from "../extensions/auto-mode.ts";
import { baseConfig } from "./test-helpers.ts";

const config = {
	...baseConfig(),
	hardDeny: ["Exfiltrating secrets."],
	softDeny: ["Force pushing.", "Production deploys."],
};

function answers(probabilities: Record<string, number>, allow = 0, authorized = 0) {
	return {
		rule: { type: "choice", choice: "x", probabilities, confidence: 0.9 },
		allow_exception: { type: "noul", noul: allow },
		user_authorized: { type: "noul", noul: authorized },
	};
}

test("Jev answers map onto deny tiers and fail closed", () => {
	assert.equal(decideFromJevAnswers(answers({ none: 0.95 }), config).decision, "allow");
	assert.deepEqual(decideFromJevAnswers(answers({ none: 0.1, hard_deny_1: 0.9 }, 1, 1), config), {
		decision: "block",
		tier: "hard_deny",
		reason: "Matches hard-deny rule: Exfiltrating secrets.",
	});
	assert.deepEqual(decideFromJevAnswers(answers({ none: 0.1, soft_deny_2: 0.9 }), config), {
		decision: "block",
		tier: "soft_deny",
		reason: "Matches soft-deny rule: Production deploys.",
	});
	assert.equal(decideFromJevAnswers(answers({ none: 0.1, soft_deny_1: 0.9 }, 0.9), config).tier, "allow");
	assert.equal(decideFromJevAnswers(answers({ none: 0.1, soft_deny_1: 0.9 }, 0, 0.9), config).tier, "explicit_intent");
	// Hard-deny mass beats a soft-deny exception even when soft-deny is the top pick.
	assert.equal(decideFromJevAnswers(answers({ none: 0.2, soft_deny_1: 0.5, hard_deny_1: 0.3 }, 1, 1), config).tier, "hard_deny");
	// Uncertain "none" is not an allow.
	assert.equal(decideFromJevAnswers(answers({ none: 0.7, soft_deny_1: 0.3 }), config).decision, "block");
	assert.equal(decideFromJevAnswers({ rule: { type: "noul" } }, config).decision, "block");
	assert.equal(decideFromJevAnswers(undefined, config).decision, "block");
});

test("classifyWithJev posts typed questions and fails closed on HTTP errors", async () => {
	const request = buildJevRequest("jev-latest", config, { policy: "P", context: "C", action: "A" });
	assert.deepEqual(Object.keys((request.questions.rule as any).criteria), ["none", "hard_deny_1", "soft_deny_1", "soft_deny_2"]);

	const previous = process.env.TYPESAFE_API_KEY;
	process.env.TYPESAFE_API_KEY = "test-key";
	try {
		let sent: { url: string; init: RequestInit } | undefined;
		const attempts: ClassifierIoAttempt[] = [];
		const ok = (async (url: string, init: RequestInit) => {
			sent = { url, init };
			return new Response(JSON.stringify({ model: "jev-latest", answers: answers({ none: 0.99 }), usage: { input_tokens: 10, output_tokens: 3 } }));
		}) as typeof fetch;
		const decision = await classifyWithJev(request, config, undefined, (a) => attempts.push(a), ok);
		assert.equal(decision.decision, "allow");
		assert.equal(sent?.url, "https://api.typesafe.ai/v1/systemone");
		assert.equal((sent?.init.headers as Record<string, string>).authorization, "Bearer test-key");
		assert.deepEqual(JSON.parse(sent?.init.body as string), request);
		assert.equal(attempts[0]?.response?.usage.totalTokens, 13);

		const failing = (async () => new Response("nope", { status: 429 })) as typeof fetch;
		const blocked = await classifyWithJev(request, config, undefined, () => {}, failing);
		assert.equal(blocked.decision, "block");
		assert.match(blocked.reason, /HTTP 429/);

		delete process.env.TYPESAFE_API_KEY;
		const noKey = await classifyWithJev(request, config, undefined, () => {}, ok);
		assert.match(noKey.reason, /TYPESAFE_API_KEY is not set/);
	} finally {
		if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
		else process.env.TYPESAFE_API_KEY = previous;
	}
});
