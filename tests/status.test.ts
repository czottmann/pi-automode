import test from "node:test";
import assert from "node:assert/strict";
import {
	parseToolPattern,
	restoreState,
	statusLine,
	statusText,
} from "../extensions/auto-mode.ts";
import {
	baseConfig,
	baseState,
	createFakeCtx,
} from "./test-helpers.ts";

test("statusText reports the permissions.allow rule count", () => {
	const pattern = parseToolPattern("noop");
	assert.ok(pattern);
	const text = statusText(baseConfig({ permissionAllow: [pattern] }), baseState());
	assert.match(text, /permissions\.allow rules: 1/);
});

test("statusText reports server-default classifier reasoning", () => {
	const text = statusText(baseConfig(), baseState());
	assert.match(text, /^classifier reasoning: server default$/m);
});

test("statusText reports the configured classifier reasoning level", () => {
	const text = statusText(
		baseConfig({ classifierReasoningLevel: "high" }),
		baseState(),
	);
	assert.match(text, /^classifier reasoning: high$/m);
});

test("statusText reports cumulative classifier cost", () => {
	const text = statusText(baseConfig(), baseState({ classifierCost: 0.123456 }));
	assert.match(text, /^classifier cost: \$0\.1235$/m);
});

test("restoreState defaults classifier cost for older persisted entries", () => {
	const state = restoreState(createFakeCtx([{
		type: "custom",
		customType: "pi-automode-state",
		data: {
			checkedActions: 1,
			blockedActions: 0,
			classifierAllowed: 1,
			classifierDenied: 0,
			recentDenials: [],
		},
	}]));
	assert.equal(state.classifierCost, 0);
});

test("statusLine: enabled with no classifier calls omits the ca/cd segment", () => {
	const config = baseConfig();
	const state = baseState({ checkedActions: 6, blockedActions: 1 });
	assert.equal(statusLine(config, state), "AM ● a:5 d:1");
});

test("statusLine: enabled with classifier calls appends ca/cd segment", () => {
	const config = baseConfig();
	const state = baseState({ checkedActions: 6, blockedActions: 1, classifierAllowed: 2, classifierDenied: 1 });
	assert.equal(statusLine(config, state), "AM ● a:5 d:1 ca:2 cd:1 c:$0.0000");
});

test("statusLine: disabled shows empty circle with frozen counts", () => {
	const config = baseConfig({ enabled: false });
	const state = baseState({ checkedActions: 18, blockedActions: 3, classifierAllowed: 7, classifierDenied: 5 });
	assert.equal(statusLine(config, state), "AM ○ a:15 d:3 ca:7 cd:5 c:$0.0000");
});

test("statusLine: enabledOverride:false overrides an enabled config", () => {
	const config = baseConfig({ enabled: true });
	const state = baseState({ enabledOverride: false, checkedActions: 4, blockedActions: 1 });
	assert.equal(statusLine(config, state), "AM ○ a:3 d:1");
});

test("statusLine: allowed is derived from checked minus blocked", () => {
	const config = baseConfig();
	const state = baseState({ checkedActions: 10, blockedActions: 3, classifierAllowed: 1, classifierDenied: 1 });
	assert.equal(statusLine(config, state), "AM ● a:7 d:3 ca:1 cd:1 c:$0.0000");
});

test("statusLine: zero counts render a:0 d:0 with no ca/cd segment", () => {
	const config = baseConfig();
	assert.equal(statusLine(config, baseState()), "AM ● a:0 d:0");
});

test("statusLine: classifier segment shows when only allows have happened", () => {
	const config = baseConfig();
	const state = baseState({ checkedActions: 4, blockedActions: 0, classifierAllowed: 3, classifierDenied: 0 });
	assert.equal(statusLine(config, state), "AM ● a:4 d:0 ca:3 cd:0 c:$0.0000");
});

test("statusLine: classifier segment shows when only denials have happened", () => {
	const config = baseConfig();
	const state = baseState({ checkedActions: 2, blockedActions: 2, classifierAllowed: 0, classifierDenied: 2 });
	assert.equal(statusLine(config, state), "AM ● a:0 d:2 ca:0 cd:2 c:$0.0000");
});

// --- observability logging -------------------------------------------------
