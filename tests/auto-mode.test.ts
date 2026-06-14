import test from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	DEFAULT_ALLOW,
	DEFAULT_SOFT_DENY,
	buildEffectiveConfigFromSources,
	createPiAutomode,
	deterministicHardDeny,
	validateSettingsFile,
	matchesToolPattern,
	parseClassifierDecision,
	parseToolPattern,
	type ClassificationDecision,
	type EffectiveConfig,
} from "../extensions/auto-mode.ts";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

function createFakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler }>();
	const entries: any[] = [];

	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data: structuredClone(data) });
		},
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command);
		},
	} as any;

	return {
		pi,
		entries,
		commands,
		async emit(event: string, payload: any, ctx: any) {
			let lastResult: unknown;
			for (const handler of handlers.get(event) ?? []) {
				lastResult = await handler(payload, ctx);
				if ((lastResult as { block?: boolean } | undefined)?.block) return lastResult;
			}
			return lastResult;
		},
	};
}

function createFakeCtx(entries: any[] = [], overrides: Record<string, unknown> = {}) {
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const widgets: Array<{ key: string; content: string[] | undefined }> = [];

	return {
		cwd: "/tmp/project",
		mode: "tui",
		hasUI: true,
		signal: undefined,
		model: { provider: "test", id: "classifier" },
		modelRegistry: {
			find() {
				return { provider: "test", id: "classifier" };
			},
			async getApiKeyAndHeaders() {
				return { ok: true, apiKey: "test-key" };
			},
		},
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => [],
		},
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
			setStatus(key: string, text: string | undefined) {
				statuses.push({ key, text });
			},
			setWidget(key: string, content: string[] | undefined) {
				widgets.push({ key, content });
			},
			async confirm() {
				return true;
			},
			theme: {
				fg(_color: string, text: string) {
					return text;
				},
				bold(text: string) {
					return text;
				},
			},
		},
		isProjectTrusted: () => true,
		getSystemPrompt: () => "",
		...overrides,
	};
}

function baseConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
	return {
		enabled: true,
		maxTranscriptLines: 80,
		environment: [],
		allow: [],
		softDeny: [],
		hardDeny: [],
		permissionDeny: [],
		permissionAsk: [],
		...overrides,
	};
}

async function setupHookTest(options: {
	config?: EffectiveConfig;
	classifier?: () => Promise<ClassificationDecision>;
	ctx?: ReturnType<typeof createFakeCtx>;
} = {}) {
	const fake = createFakePi();
	let classifierCalls = 0;
	const classifier = options.classifier ?? (async () => ({ decision: "allow", tier: "none", reason: "test allow" }));
	createPiAutomode({
		loadConfig: () => options.config ?? baseConfig(),
		classifyAction: async () => {
			classifierCalls += 1;
			return classifier();
		},
	})(fake.pi);
	const ctx = options.ctx ?? createFakeCtx(fake.entries);
	await fake.emit("session_start", { type: "session_start" }, ctx);
	return { ...fake, ctx, get classifierCalls() { return classifierCalls; } };
}

test("project shared Pi settings can add permissions but cannot weaken autoMode", () => {
	const config = buildEffectiveConfigFromSources({
		projectSharedSettings: [
			{
				autoMode: {
					allow: ["checked-in repo tries to allow everything"],
					hard_deny: ["checked-in repo tries to replace hard denies"],
				},
				permissions: {
					deny: ["bash(git push --force*)"],
				},
			},
		],
	});

	assert.equal(config.allow.includes("checked-in repo tries to allow everything"), false);
	assert.equal(config.hardDeny.includes("checked-in repo tries to replace hard denies"), false);
	assert.equal(config.permissionDeny.length, 1);
	assert.equal(config.permissionDeny[0]?.raw, "bash(git push --force*)");
});

test("rule lists replace defaults only for their own section when $defaults is omitted", () => {
	const config = buildEffectiveConfigFromSources({
		projectLocalSettings: [
			{
				autoMode: {
					allow: ["local only"],
				},
			},
		],
	});

	assert.deepEqual(config.allow, ["local only"]);
	assert.deepEqual(config.softDeny, DEFAULT_SOFT_DENY);
});

test("rule lists combine across configurable scopes when $defaults is present", () => {
	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { allow: ["$defaults", "global allow"] } }],
		projectLocalSettings: [{ autoMode: { allow: ["$defaults", "local allow"] } }],
	});

	assert.equal(DEFAULT_ALLOW.every((rule) => config.allow.includes(rule)), true);
	assert.equal(config.allow.includes("global allow"), true);
	assert.equal(config.allow.includes("local allow"), true);
});

test("permission patterns keep argument scope instead of flattening to a tool allow", () => {
	const pattern = parseToolPattern("bash(git status*)");
	assert.ok(pattern);
	assert.equal(matchesToolPattern(pattern, "bash", { command: "git status --short" }, process.cwd()), true);
	assert.equal(matchesToolPattern(pattern, "bash", { command: "git push --force" }, process.cwd()), false);

	const capitalized = parseToolPattern("Bash(git status*)");
	assert.ok(capitalized);
	assert.equal(matchesToolPattern(capitalized, "bash", { command: "git status --short" }, process.cwd()), true);
});

test("deterministic hard deny catches safety-control edits", () => {
	const cwd = "/tmp/project";
	assert.match(
		deterministicHardDeny("write", { path: ".pi/automode.local.json" }, cwd) ?? "",
		/safety-control/,
	);
	assert.match(
		deterministicHardDeny("bash", { command: "echo test >> ~/.zshrc" }, cwd) ?? "",
		/shell profile/,
	);
});

test("deterministic hard deny catches TLS weakening and authorized_keys writes", () => {
	assert.match(
		deterministicHardDeny("bash", { command: "git config --global http.sslVerify false" }, process.cwd()) ?? "",
		/TLS/,
	);
	assert.match(
		deterministicHardDeny("bash", { command: "cat key.pub >> ~/.ssh/authorized_keys" }, process.cwd()) ?? "",
		/authorized_keys/,
	);
});

test("shell parsing catches risky suffixes, redirects, and quoted HOME targets", () => {
	assert.match(
		deterministicHardDeny("bash", { command: "echo safe && git config --global http.sslVerify false" }, process.cwd()) ?? "",
		/TLS/,
	);
	assert.match(
		deterministicHardDeny("bash", { command: "printf test > ~/.zshrc" }, process.cwd()) ?? "",
		/shell profile/,
	);
	assert.match(
		deterministicHardDeny("bash", { command: 'echo key > "$HOME/.ssh/authorized_keys"' }, process.cwd()) ?? "",
		/authorized_keys/,
	);
	assert.match(
		deterministicHardDeny("bash", { command: "echo nope | tee .pi/automode.local.json" }, "/tmp/project") ?? "",
		/safety-control/,
	);
});

test("config validation reports unknown keys, wrong types, and missing defaults", () => {
	const diagnostics = validateSettingsFile({
		unknown: true,
		autoMode: {
			enabled: "yes",
			allow: ["custom allow"],
			hard_deny: [42],
			mystery: [],
		} as any,
		permissions: {
			deny: "Bash(*)",
			maybe: [],
		} as any,
	} as any, "test-config");

	assert.equal(diagnostics.some((line) => line.includes("unknown top-level key unknown")), true);
	assert.equal(diagnostics.some((line) => line.includes("autoMode.enabled must be a boolean")), true);
	assert.equal(diagnostics.some((line) => line.includes('autoMode.allow omits "$defaults"')), true);
	assert.equal(diagnostics.some((line) => line.includes("autoMode.hard_deny[0]")), true);
	assert.equal(diagnostics.some((line) => line.includes("unknown permissions key maybe")), true);
	assert.equal(diagnostics.some((line) => line.includes("permissions.deny must be an array")), true);
});

test("classifier JSON parser accepts valid decisions and rejects invalid output", () => {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: '{"decision":"block","tier":"hard_deny","reason":"secret exfiltration"}' }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} satisfies AssistantMessage;

	assert.deepEqual(parseClassifierDecision(message), {
		decision: "block",
		tier: "hard_deny",
		reason: "secret exfiltration",
	});

	assert.equal(
		parseClassifierDecision({ ...message, content: [{ type: "text", text: "ALLOW because I said so" }] }),
		undefined,
	);
});

test("tool_call hook blocks permissions.deny before deterministic checks and classifier", async () => {
	const pattern = parseToolPattern("bash(git push --force*)");
	assert.ok(pattern);
	const harness = await setupHookTest({
		config: baseConfig({ permissionDeny: [pattern] }),
	});

	const result = await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "git push --force origin main" },
	}, harness.ctx) as { block?: boolean; reason?: string };

	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /permissions\.deny/);
	assert.equal(harness.classifierCalls, 0);
});

test("tool_call hook runs deterministic hard-deny before classifier", async () => {
	const harness = await setupHookTest();

	const result = await harness.emit("tool_call", {
		toolName: "write",
		input: { path: ".pi/automode.local.json", content: "{}" },
	}, harness.ctx) as { block?: boolean; reason?: string };

	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /safety-control/);
	assert.equal(harness.classifierCalls, 0);
});

test("tool_call hook allows safe read-only tools without classifier", async () => {
	const harness = await setupHookTest();

	const result = await harness.emit("tool_call", {
		toolName: "read",
		input: { path: "README.md" },
	}, harness.ctx);

	assert.equal(result, undefined);
	assert.equal(harness.classifierCalls, 0);
});

test("tool_call hook uses classifier mock for non-read-only actions", async () => {
	const harness = await setupHookTest({
		classifier: async () => ({ decision: "block", tier: "soft_deny", reason: "mock block" }),
	});

	const result = await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "npm publish" },
	}, harness.ctx) as { block?: boolean; reason?: string };

	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /mock block/);
	assert.equal(harness.classifierCalls, 1);
});

test("tool_call hook allows classifier-approved non-read-only actions", async () => {
	const harness = await setupHookTest({
		classifier: async () => ({ decision: "allow", tier: "allow", reason: "mock allow" }),
	});

	const result = await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "npm test" },
	}, harness.ctx);

	assert.equal(result, undefined);
	assert.equal(harness.classifierCalls, 1);
});

test("tool_call hook blocks classifier-needed actions when no classifier is available", async () => {
	const fake = createFakePi();
	createPiAutomode({ loadConfig: () => baseConfig() })(fake.pi);
	const ctx = createFakeCtx(fake.entries, { model: undefined });
	await fake.emit("session_start", { type: "session_start" }, ctx);

	const result = await fake.emit("tool_call", {
		toolName: "bash",
		input: { command: "npm publish" },
	}, ctx) as { block?: boolean; reason?: string };

	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /No classifier model/);
});
