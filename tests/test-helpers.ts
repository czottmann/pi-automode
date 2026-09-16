import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_LOG_CONFIG,
	DEFAULT_PROTECTED_PATHS,
	analyzeBash,
	createPiAutomode,
	type AutoModeState,
	type ClassificationDecision,
	type EffectiveConfig,
} from "../extensions/auto-mode.ts";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

const EXTENSION_SOURCE = realpathSync(
	join(dirname(fileURLToPath(import.meta.url)), "../extensions/auto-mode.ts"),
);

export function createFakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler }>();
	const tools = new Map<string, {
		execute: (...args: any[]) => any;
		sourceInfo: { path: string };
	}>();
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
		registerTool(tool: {
			name: string;
			execute: (...args: any[]) => any;
			sourceInfo?: { path: string };
		}) {
			if (tools.has(tool.name)) return;
			tools.set(tool.name, {
				execute: tool.execute,
				sourceInfo: tool.sourceInfo ?? { path: EXTENSION_SOURCE },
			});
		},
		getAllTools() {
			return [...tools].map(([name, tool]) => ({
				name,
				description: "test tool",
				parameters: {},
				promptGuidelines: [],
				sourceInfo: {
					path: tool.sourceInfo.path,
					source: "test",
					scope: "temporary",
					origin: "package",
				},
			}));
		},
	} as any;

	return {
		pi,
		entries,
		commands,
		tools,
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

export function createFakeCtx(entries: any[] = [], overrides: Record<string, unknown> = {}) {
	const { sessionFile, sessionDir, sessionId, ...rest } = overrides;
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
			getBranch: () => entries,
			buildContextEntries: () => entries,
			getSessionFile: () => sessionFile as string | undefined,
			getSessionDir: () => typeof sessionDir === "string"
				? sessionDir
				: sessionFile
					? dirname(sessionFile as string)
					: "/tmp",
			getSessionId: () => typeof sessionId === "string" ? sessionId : "test-session",
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
		statuses,
		notifications,
		isProjectTrusted: () => true,
		getSystemPrompt: () => "",
		...rest,
	};
}

export function baseConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
	return {
		enabled: true,
		classifierModelByProvider: {},
		classifyReadOnlyTools: false,
		allowInsideWorkingDirectory: false,
		deniedPaths: [],
		fastClassifierMaxTokens: 512,
		classifierTimeoutMs: 20_000,
		maxUserTranscriptTokens: 4000,
		maxToolTranscriptTokens: 4000,
		environment: [],
		allow: [],
		protectedPaths: [...DEFAULT_PROTECTED_PATHS],
		softDeny: [],
		hardDeny: [],
		permissionDeny: [],
		permissionAsk: [],
		permissionAllow: [],
		log: { ...DEFAULT_LOG_CONFIG },
		...overrides,
	};
}

export function baseState(overrides: Partial<AutoModeState> = {}): AutoModeState {
	return {
		checkedActions: 0,
		blockedActions: 0,
		classifierAllowed: 0,
		classifierDenied: 0,
		recentDenials: [],
		...overrides,
	};
}

export async function setupHookTest(options: {
	config?: EffectiveConfig;
	classifier?: () => Promise<ClassificationDecision>;
	ctx?: ReturnType<typeof createFakeCtx>;
	analyze?: typeof analyzeBash;
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
		analyzeBash: options.analyze,
	})(fake.pi);
	const ctx = options.ctx ?? createFakeCtx(fake.entries);
	await fake.emit("session_start", { type: "session_start" }, ctx);
	return { ...fake, ctx, get classifierCalls() { return classifierCalls; } };
}
