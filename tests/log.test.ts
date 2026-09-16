import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	buildEffectiveConfigFromSources,
	createLogger,
	createPiAutomode,
	newDecisionId,
	parseToolPattern,
	resolveLogPath,
	validateSettingsFile,
	type ClassifyAction,
	type EffectiveConfig,
} from "../extensions/auto-mode.ts";
import {
	baseConfig,
	createFakeCtx,
	createFakePi,
} from "./test-helpers.ts";

test("log config defaults to disabled with classifier I/O off", () => {
	const config = buildEffectiveConfigFromSources({});
	assert.deepEqual(config.log, { enabled: false, classifierIo: false });
});

test("log config merges field-by-field across configurable scopes", () => {
	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { log: { enabled: true } } }],
		projectLocalSettings: [{ autoMode: { log: { classifierIo: true } } }],
	});
	assert.equal(config.log.enabled, true);
	assert.equal(config.log.classifierIo, true);
});

test("shared project settings cannot set log config", () => {
	const config = buildEffectiveConfigFromSources({
		projectSharedSettings: [{ autoMode: { log: { enabled: true, classifierIo: true } } }],
	});
	assert.equal(config.log.enabled, false);
	assert.equal(config.log.classifierIo, false);
});

test("log config validation reports wrong types", () => {
	const diagnostics = validateSettingsFile({
		autoMode: { log: { enabled: "yes", classifierIo: 1 } },
	} as any, "test-config");
	assert.equal(diagnostics.some((d) => d.includes("autoMode.log.enabled must be a boolean")), true);
	assert.equal(diagnostics.some((d) => d.includes("autoMode.log.classifierIo must be a boolean")), true);

	const diagnostics2 = validateSettingsFile({
		autoMode: { log: "nope" },
	} as any, "test-config");
	assert.equal(diagnostics2.some((d) => d.includes("autoMode.log must be an object")), true);
});

test("resolveLogPath inserts -pi-automode before the extension", () => {
	assert.equal(
		resolveLogPath("/home/.pi/agent/sessions/slug/abc123.jsonl", "/dir", "id"),
		"/home/.pi/agent/sessions/slug/abc123-pi-automode.jsonl",
	);
});

test("resolveLogPath falls back to sessionDir/sessionId when no session file", () => {
	assert.equal(
		resolveLogPath(undefined, "/dir/slug", "abc123"),
		"/dir/slug/abc123-pi-automode.jsonl",
	);
});

test("resolveLogPath uses the encoded session cwd for in-memory sessions", () => {
	const logRoot = join(os.tmpdir(), "pi-automode-global-log-root");
	const sessionCwd = join(os.tmpdir(), "pi-automode-project-marker");
	const resolvedCwd = resolve(sessionCwd);
	const projectDir = `--${
		resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")
	}--`;
	for (const sessionDir of ["", "relative-session-dir"]) {
		assert.equal(
			resolveLogPath(
				undefined,
				sessionDir,
				"abc123",
				sessionCwd,
				logRoot,
				new Date("2026-08-11T12:00:00.000Z"),
			),
			join(logRoot, projectDir, "2026-08-11", "abc123-pi-automode.jsonl"),
		);
	}
});

test("resolveLogPath partitions in-memory logs by UTC date", () => {
	const args = [undefined, "", "abc123", "/tmp/project", "/tmp/logs"] as const;
	const beforeMidnight = resolveLogPath(
		...args,
		new Date("2026-08-11T23:59:59.999Z"),
	);
	const afterMidnight = resolveLogPath(
		...args,
		new Date("2026-08-12T00:00:00.000Z"),
	);
	assert.equal(basename(dirname(beforeMidnight)), "2026-08-11");
	assert.equal(basename(dirname(afterMidnight)), "2026-08-12");
	assert.notEqual(beforeMidnight, afterMidnight);
});

test("resolveLogPath confines invalid custom session ids", () => {
	const logRoot = resolve(os.tmpdir(), "pi-automode-confined-logs");
	for (const sessionId of ["../../escape", "..\\..\\escape", ".."]) {
		const logPath = resolveLogPath(
			undefined,
			"",
			sessionId,
			"/tmp/project",
			logRoot,
			new Date("2026-08-11T12:00:00.000Z"),
		);
		assert.equal(relative(logRoot, logPath).startsWith(".."), false);
		assert.match(
			basename(logPath),
			/^invalid-[a-f0-9]{16}-pi-automode\.jsonl$/,
		);
	}
});

test("newDecisionId returns distinct ids", () => {
	assert.notEqual(newDecisionId(), newDecisionId());
});

test("createLogger is a no-op when disabled", () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-log-"));
	try {
		const sessionFile = join(dir, "abc.jsonl");
		const logger = createLogger({ enabled: false, classifierIo: true, sessionFile, sessionDir: dir, sessionId: "abc" });
		logger.append({ type: "decision", ts: "t", decisionId: "d", cwd: "/tmp", tool: "bash", summary: "s", kind: "classifier", outcome: "block", reason: "r", reasoning: { mode: "server-default" } });
		assert.equal(existsSync(join(dir, "abc-pi-automode.jsonl")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createLogger writes in-memory logs under the application-owned root", () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-log-"));
	try {
		const sessionCwd = join(dir, "project");
		const logRoot = join(dir, "global-logs");
		const now = new Date("2026-08-11T12:00:00.000Z");
		mkdirSync(sessionCwd);
		const logger = createLogger({
			enabled: true,
			classifierIo: false,
			sessionDir: "",
			sessionCwd,
			sessionId: "abc",
			logRoot,
			now,
		});
		logger.append({ type: "decision", ts: "t", decisionId: "d1", cwd: sessionCwd, tool: "read", summary: "s", kind: "read-only", outcome: "allow", reason: "r", reasoning: { mode: "server-default" } });
		const logPath = resolveLogPath(undefined, "", "abc", sessionCwd, logRoot, now);
		assert.equal(existsSync(logPath), true);
		assert.equal(existsSync(join(sessionCwd, "abc-pi-automode.jsonl")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createLogger writes decision entries when enabled", () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-log-"));
	try {
		const sessionFile = join(dir, "abc.jsonl");
		const logger = createLogger({ enabled: true, classifierIo: false, sessionFile, sessionDir: dir, sessionId: "abc" });
		logger.append({ type: "decision", ts: "t", decisionId: "d1", cwd: "/tmp", tool: "bash", summary: "s", kind: "classifier", outcome: "block", reason: "r", reasoning: { mode: "server-default" } });
		const logPath = join(dir, "abc-pi-automode.jsonl");
		assert.equal(existsSync(logPath), true);
		const lines = readFileSync(logPath, "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		assert.deepEqual(JSON.parse(lines[0]), { type: "decision", ts: "t", decisionId: "d1", cwd: "/tmp", tool: "bash", summary: "s", kind: "classifier", outcome: "block", reason: "r", reasoning: { mode: "server-default" } });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createLogger skips classifier entries when classifierIo is false", () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-log-"));
	try {
		const sessionFile = join(dir, "abc.jsonl");
		const logger = createLogger({ enabled: true, classifierIo: false, sessionFile, sessionDir: dir, sessionId: "abc" });
		logger.append({ type: "classifier", ts: "t", decisionId: "d1", model: "m", reasoning: { mode: "server-default" }, prompt: { system: "s", context: "u", action: "a", fastInstruction: "0/1", detailedInstruction: "json" }, attempts: [], durationMs: 5, parsed: { decision: "allow", tier: "none", reason: "r" } });
		assert.equal(existsSync(join(dir, "abc-pi-automode.jsonl")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createLogger writes classifier entries when classifierIo is true", () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-log-"));
	try {
		const sessionFile = join(dir, "abc.jsonl");
		const logger = createLogger({ enabled: true, classifierIo: true, sessionFile, sessionDir: dir, sessionId: "abc" });
		logger.append({ type: "classifier", ts: "t", decisionId: "d1", model: "m", reasoning: { mode: "server-default" }, prompt: { system: "s", context: "u", action: "a", fastInstruction: "0/1", detailedInstruction: "json" }, attempts: [], durationMs: 5, parsed: { decision: "allow", tier: "none", reason: "r" } });
		const lines = readFileSync(join(dir, "abc-pi-automode.jsonl"), "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		assert.equal(JSON.parse(lines[0]).type, "classifier");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

async function setupLogTest(options: {
	config?: EffectiveConfig;
	classifier?: ClassifyAction;
} = {}) {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-log-"));
	const sessionFile = join(dir, "sess.jsonl");
	const classifier = options.classifier ?? (async () => ({ decision: "block", tier: "soft_deny", reason: "mock block" }));
	const fake = createFakePi();
	createPiAutomode({
		loadConfig: () => options.config ?? baseConfig({ log: { enabled: true, classifierIo: false } }),
		classifyAction: async () => classifier(),
	})(fake.pi);
	const ctx = createFakeCtx(fake.entries, { sessionFile });
	await fake.emit("session_start", { type: "session_start" }, ctx);
	return { dir, sessionFile, fake, ctx, logPath: join(dir, "sess-pi-automode.jsonl") };
}

test("tool_call writes no log file when logging is disabled", async () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-log-"));
	try {
		const sessionFile = join(dir, "sess.jsonl");
		const fake = createFakePi();
		createPiAutomode({
			loadConfig: () => baseConfig(),
			classifyAction: async () => ({ decision: "block", tier: "soft_deny", reason: "mock" }),
		})(fake.pi);
		const ctx = createFakeCtx(fake.entries, { sessionFile });
		await fake.emit("session_start", { type: "session_start" }, ctx);
		await fake.emit("tool_call", { toolName: "bash", input: { command: "npm publish" } }, ctx);
		assert.equal(existsSync(join(dir, "sess-pi-automode.jsonl")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tool_call and config use the in-memory session cwd log path", async () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-hook-log-"));
	try {
		const sessionCwd = join(dir, "effective-worktree");
		const logRoot = join(dir, "automode-logs");
		const sessionId = `in-memory-${basename(dir)}`;
		const now = new Date("2026-08-11T12:00:00.000Z");
		const legacyLaunchPath = join(process.cwd(), `${sessionId}-pi-automode.jsonl`);
		mkdirSync(sessionCwd);
		assert.equal(existsSync(legacyLaunchPath), false);

		const fake = createFakePi();
		createPiAutomode({
			loadConfig: () => baseConfig({
				log: { enabled: true, classifierIo: false },
			}),
			classifyAction: async () => ({
				decision: "block",
				tier: "soft_deny",
				reason: "unused",
			}),
			logRoot,
			now: () => now,
		})(fake.pi);
		const ctx = createFakeCtx(fake.entries, {
			cwd: sessionCwd,
			sessionDir: "",
			sessionId,
		});
		await fake.emit("session_start", { type: "session_start" }, ctx);
		await fake.emit("tool_call", {
			toolName: "read",
			input: { path: "README.md" },
		}, ctx);

		const logPath = resolveLogPath(
			undefined, "", sessionId, sessionCwd, logRoot, now,
		);
		const launchCwdPath = resolveLogPath(
			undefined, "", sessionId, process.cwd(), logRoot, now,
		);
		assert.notEqual(logPath, launchCwdPath);
		assert.equal(existsSync(logPath), true);
		assert.equal(existsSync(launchCwdPath), false);
		assert.equal(existsSync(legacyLaunchPath), false);
		assert.equal(existsSync(join(sessionCwd, `${sessionId}-pi-automode.jsonl`)), false);

		await fake.commands.get("automode")?.handler("config", ctx);
		const parsed = JSON.parse(ctx.notifications.at(-1)?.message ?? "{}");
		assert.equal(parsed.logFile, logPath);
	} finally {
		rmSync(join(process.cwd(), `in-memory-${basename(dir)}-pi-automode.jsonl`), { force: true });
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tool_call logs blocked classifier decisions to the session log file", async () => {
	const t = await setupLogTest({
		classifier: async () => ({ decision: "block", tier: "soft_deny", reason: "mock block" }),
	});
	try {
		await t.fake.emit("tool_call", { toolName: "bash", input: { command: "npm publish" } }, t.ctx);
		assert.equal(existsSync(t.logPath), true);
		const lines = readFileSync(t.logPath, "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		const entry = JSON.parse(lines[0]);
		assert.equal(entry.type, "decision");
		assert.equal(entry.outcome, "block");
		assert.equal(entry.kind, "classifier");
		assert.equal(entry.tool, "bash");
		assert.equal(entry.sessionId, "test-session");
		assert.deepEqual(entry.reasoning, { mode: "server-default" });
	} finally {
		rmSync(t.dir, { recursive: true, force: true });
	}
});

test("tool_call logs the classifier routed for the session provider", async () => {
	const t = await setupLogTest({
		config: baseConfig({
			classifierModel: "fallback/model",
			classifierModelByProvider: { test: "test/routed-classifier" },
			log: { enabled: true, classifierIo: false },
		}),
	});
	try {
		await t.fake.emit("tool_call", { toolName: "bash", input: { command: "npm publish" } }, t.ctx);
		const entry = JSON.parse(readFileSync(t.logPath, "utf8").trim());
		assert.equal(entry.classifierModel, "test/routed-classifier");
	} finally {
		rmSync(t.dir, { recursive: true, force: true });
	}
});

test("tool_call logs effective explicit reasoning when classifier authentication is unavailable", async () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-log-"));
	try {
		const sessionFile = join(dir, "sess.jsonl");
		const model = {
			provider: "test",
			id: "reasoner",
			reasoning: true,
			thinkingLevelMap: { xhigh: null, max: null },
		};
		const fake = createFakePi();
		createPiAutomode({
			loadConfig: () => baseConfig({
				classifierReasoningLevel: "max",
				log: { enabled: true, classifierIo: false },
			}),
		})(fake.pi);
		const ctx = createFakeCtx(fake.entries, {
			sessionFile,
			model,
			modelRegistry: {
				find: () => model,
				getApiKeyAndHeaders: async () => ({ ok: false, error: "missing credentials" }),
			},
		});
		await fake.emit("session_start", { type: "session_start" }, ctx);

		const result = await fake.emit("tool_call", {
			toolName: "bash",
			input: { command: "npm publish" },
		}, ctx) as { block?: boolean };
		assert.equal(result.block, true);

		const entry = JSON.parse(
			readFileSync(join(dir, "sess-pi-automode.jsonl"), "utf8").trim(),
		);
		assert.equal(entry.type, "decision");
		assert.equal(entry.kind, "classifier");
		assert.deepEqual(entry.reasoning, {
			mode: "explicit",
			requestedLevel: "max",
			effectiveLevel: "high",
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tool_call logs read-only allows with kind read-only", async () => {
	const t = await setupLogTest();
	try {
		await t.fake.emit("tool_call", { toolName: "read", input: { path: "README.md" } }, t.ctx);
		const entry = JSON.parse(readFileSync(t.logPath, "utf8").trim());
		assert.equal(entry.type, "decision");
		assert.equal(entry.outcome, "allow");
		assert.equal(entry.kind, "read-only");
		assert.equal(entry.tool, "read");
	} finally {
		rmSync(t.dir, { recursive: true, force: true });
	}
});

test("tool_call logs direct in-project writes as classifier decisions", async () => {
	const t = await setupLogTest({
		classifier: async () => ({ decision: "allow", tier: "allow", reason: "safe write" }),
	});
	try {
		await t.fake.emit("tool_call", {
			toolName: "write",
			input: { path: "src/index.ts", content: "x" },
		}, t.ctx);
		const entry = JSON.parse(readFileSync(t.logPath, "utf8").trim());
		assert.equal(entry.type, "decision");
		assert.equal(entry.outcome, "allow");
		assert.equal(entry.kind, "classifier");
		assert.equal(entry.tool, "write");
	} finally {
		rmSync(t.dir, { recursive: true, force: true });
	}
});

test("tool_call logs deterministic hard-deny blocks", async () => {
	const t = await setupLogTest();
	try {
		await t.fake.emit("tool_call", { toolName: "write", input: { path: ".pi/automode.local.json", content: "{}" } }, t.ctx);
		const entry = JSON.parse(readFileSync(t.logPath, "utf8").trim());
		assert.equal(entry.type, "decision");
		assert.equal(entry.outcome, "block");
		assert.equal(entry.kind, "deterministic-hard-deny");
	} finally {
		rmSync(t.dir, { recursive: true, force: true });
	}
});

test("tool_call logs ccusage-compatible classifier usage without classifier I/O", async () => {
	const t = await setupLogTest({
		config: baseConfig({
			classifierReasoningLevel: "max",
			log: { enabled: true, classifierIo: false },
		}),
		classifier: async () => ({
			decision: "allow",
			tier: "allow",
			reason: "ok",
			io: {
				model: "test/glm-5.2",
				reasoning: { mode: "explicit", requestedLevel: "max", effectiveLevel: "high" },
				prompt: { system: "s", context: "u", action: "a", fastInstruction: "0/1", detailedInstruction: "json" },
				attempts: [{
					stage: "fast",
					attempt: 1,
					response: {
						stopReason: "stop",
						text: '{"decision":"allow"}',
						model: "glm-5.2",
						timestamp: Date.parse("2026-07-10T12:00:00.000Z"),
						usage: { input: 11, output: 12, cacheRead: 13, cacheWrite: 14, totalTokens: 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					},
					durationMs: 1,
				}],
				durationMs: 1,
			},
		}),
	});
	try {
		await t.fake.emit("tool_call", { toolName: "bash", input: { command: "npm test" } }, t.ctx);
		const lines = readFileSync(t.logPath, "utf8").trim().split("\n").map(JSON.parse);
		assert.deepEqual(lines[0], {
			type: "message",
			timestamp: "2026-07-10T12:00:00.000Z",
			message: {
				role: "assistant",
				model: "glm-5.2",
				usage: { input: 11, output: 12, cacheRead: 13, cacheWrite: 14, totalTokens: 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
		});
		assert.equal(lines[1].type, "decision");
		assert.equal(lines[1].outcome, "allow");
		assert.equal(lines[1].kind, "classifier");
		assert.deepEqual(lines[1].reasoning, {
			mode: "explicit",
			requestedLevel: "max",
			effectiveLevel: "high",
		});
	} finally {
		rmSync(t.dir, { recursive: true, force: true });
	}
});

test("tool_call logs ccusage-compatible usage, classifier I/O, and decision", async () => {
	const t = await setupLogTest({
		config: baseConfig({ log: { enabled: true, classifierIo: true } }),
		classifier: async () => ({
			decision: "allow",
			tier: "allow",
			reason: "ok",
			io: {
				model: "test/classifier",
				reasoning: { mode: "explicit", requestedLevel: "max", effectiveLevel: "high" },
				prompt: {
					system: "sys",
					context: "usr",
					action: "EXACT_ACTION_MIDDLE_MARKER",
					fastInstruction: "0/1",
					detailedInstruction: "json",
				},
				attempts: [
					{
						stage: "fast",
						attempt: 1,
						response: {
							stopReason: "length",
							text: "not json",
							model: "classifier",
							timestamp: Date.parse("2026-07-10T12:00:00.000Z"),
							usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						},
						durationMs: 4,
					},
					{
						stage: "detailed",
						attempt: 2,
						response: {
							stopReason: "stop",
							text: '{"decision":"allow"}',
							model: "classifier",
							timestamp: Date.parse("2026-07-10T12:00:01.000Z"),
							usage: { input: 11, output: 12, cacheRead: 13, cacheWrite: 14, totalTokens: 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						},
						parsed: { decision: "allow", tier: "allow", reason: "ok" },
						durationMs: 4,
					},
				],
				durationMs: 5,
			},
		}),
	});
	try {
		await t.fake.emit("tool_call", { toolName: "bash", input: { command: "npm test" } }, t.ctx);
		const lines = readFileSync(t.logPath, "utf8").trim().split("\n").map(JSON.parse);
		assert.equal(lines.length, 4);
		assert.deepEqual(lines.slice(0, 2).map((line) => line.message), [
			{ role: "assistant", model: "classifier", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
			{ role: "assistant", model: "classifier", usage: { input: 11, output: 12, cacheRead: 13, cacheWrite: 14, totalTokens: 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
		]);
		const classifierEntry = lines[2];
		const decisionEntry = lines[3];
		assert.equal(classifierEntry.type, "classifier");
		assert.equal(decisionEntry.type, "decision");
		assert.equal(classifierEntry.decisionId, decisionEntry.decisionId);
		assert.equal(decisionEntry.outcome, "allow");
		assert.equal(decisionEntry.kind, "classifier");
		assert.equal(classifierEntry.model, "test/classifier");
		assert.equal(
			classifierEntry.prompt.action,
			"EXACT_ACTION_MIDDLE_MARKER",
		);
		assert.deepEqual(classifierEntry.reasoning, {
			mode: "explicit",
			requestedLevel: "max",
			effectiveLevel: "high",
		});
		assert.deepEqual(decisionEntry.reasoning, classifierEntry.reasoning);
	} finally {
		rmSync(t.dir, { recursive: true, force: true });
	}
});

test("/automode config reports the resolved permissions.allow rules", async () => {
	const patterns = ["bash(git status*)", "example-extension-tool"].map((raw) =>
		parseToolPattern(raw)!
	);
	const t = await setupLogTest({
		config: baseConfig({ permissionAllow: patterns }),
	});
	try {
		await t.fake.commands.get("automode")?.handler("config", t.ctx);
		const notify = t.ctx.notifications.at(-1);
		assert.ok(notify);
		const parsed = JSON.parse(notify.message);
		assert.deepEqual(
			parsed.config.permissionAllow.map((pattern: { raw: string }) => pattern.raw),
			patterns.map((pattern) => pattern.raw),
		);
	} finally {
		rmSync(t.dir, { recursive: true, force: true });
	}
});

test("/automode config names the current log file", async () => {
	const t = await setupLogTest({
		config: baseConfig({ log: { enabled: true, classifierIo: false } }),
	});
	try {
		await t.fake.commands.get("automode")?.handler("config", t.ctx);
		const notify = t.ctx.notifications.at(-1);
		assert.ok(notify);
		const parsed = JSON.parse(notify.message);
		assert.equal(parsed.logFile, t.logPath);
		assert.equal(parsed.config.log.enabled, true);
	} finally {
		rmSync(t.dir, { recursive: true, force: true });
	}
});
