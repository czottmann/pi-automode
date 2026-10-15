import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	deterministicHardDeny,
	extractToolPaths,
	matchesAllowedToolPatterns,
	matchesToolPattern,
	parseToolPattern,
} from "../extensions/auto-mode.ts";
import { extractEditPaths } from "../extensions/auto-mode/edit-targets.ts";
import { baseConfig, createFakeCtx, setupHookTest } from "./test-helpers.ts";

function fixture(t: test.TestContext): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "automode-pi-prepared-edit-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src/app.ts"), "first\nsecond\n");
	return root;
}

const replacements = [
	{ oldText: "first", newText: "updated first" },
	{ oldText: "second", newText: "updated second" },
];

const invalidPreparedInputs: Record<string, unknown>[] = [
	{ path: "src/app.ts", edits: undefined },
	{ path: "src/app.ts", edits: null },
	{ path: "src/app.ts", edits: [] },
	{ path: "src/app.ts", edits: [{}] },
	{ path: "src/app.ts", edits: JSON.stringify(replacements) },
	{ path: "src/app.ts", edits: replacements[0] },
	{ path: "src/app.ts", edits: [null] },
	{ path: "src/app.ts", edits: [42] },
	{ path: "src/app.ts", edits: [[replacements[0]]] },
	{ path: "src/app.ts", edits: [{ oldText: "first" }] },
	{ path: "src/app.ts", edits: [{ newText: "updated" }] },
	{ path: "src/app.ts", edits: [{ oldText: 42, newText: "updated" }] },
	{ path: "src/app.ts", edits: [{ oldText: "first", newText: null }] },
	{ path: "src/app.ts", edits: [replacements[0], {}] },
	{ path: "src/app.ts", edits: [replacements[0], { oldText: "second" }] },
	{ path: "src/app.ts", edits: [replacements[0], { rename: ".omp/settings.json" }] },
	{ path: "src/app.ts", edits: [{ rename: ".omp/settings.json" }, replacements[0]] },
	{ path: "src/app.ts", edits: [replacements[0], { old_string: "second", new_string: "updated" }] },
	{ path: "src/app.ts", edits: [{ ...replacements[0], path: ".pi/agent/settings.json" }] },
	{ path: "src/app.ts", edits: [{ ...replacements[0], rename: ".omp/settings.json" }] },
	{ path: "src/app.ts", edits: [{ ...replacements[0], old_string: "first", new_string: "updated" }] },
	{ path: "src/app.ts", edits: [{ ...replacements[0], op: "update", diff: "hidden patch" }] },
	{ path: "src/app.ts", edits: [{ ...replacements[0], replace_all: true }] },
	{ path: "src/app.ts", edits: replacements, oldText: "first", newText: "updated" },
	{ path: "src/app.ts", edits: replacements, old_string: "first", new_string: "updated" },
	{ path: "src/app.ts", edits: replacements, replace_all: true },
	{ path: "src/app.ts", edits: replacements, paths: [".omp/settings.json"] },
	{ path: "src/app.ts", edits: replacements, input: "[.omp/settings.json#ABCD]\nREM\n" },
	{ path: "src/app.ts", edits: replacements, patch: "hidden patch" },
	{ edits: replacements },
];

test("Pi prepared replacements extract exactly one Pi source path", (t) => {
	const root = fixture(t);
	for (const edits of [[replacements[0]], replacements, [{ oldText: "", newText: "" }]]) {
		assert.deepEqual(extractEditPaths({ path: "src/app.ts", edits }), {
			paths: ["src/app.ts"], format: "pi",
		});
		assert.deepEqual(extractToolPaths("edit", { path: "src/app.ts", edits }, root).paths, [join(root, "src/app.ts")]);
	}
	assert.deepEqual(extractEditPaths({ path: "file:///tmp/app.ts", edits: replacements }), {
		paths: ["file:///tmp/app.ts"], format: "pi",
	});
	assert.deepEqual(extractEditPaths({ path: "src/app.ts", oldText: "first", newText: "updated" }), {
		paths: ["src/app.ts"], format: "pi",
	});
});

test("Pi prepared invalid, incomplete and mixed edits expose no partial targets", () => {
	for (const input of invalidPreparedInputs) {
		const result = extractEditPaths(input);
		assert.ok(result.error, JSON.stringify(input));
		assert.deepEqual(result.paths, [], JSON.stringify(input));
	}
	for (const path of [undefined, null, 42, "", " ", "src/\u0000app.ts", "agent://session", "https://example.com/app.ts"]) {
		const result = extractEditPaths({ path, edits: replacements });
		assert.ok(result.error);
		assert.deepEqual(result.paths, []);
	}
});

test("Pi prepared source paths retain scoped permission matching", (t) => {
	const root = fixture(t);
	const scoped = parseToolPattern("edit(src/*)");
	assert.ok(scoped);
	const input = { path: "src/app.ts", edits: replacements };
	assert.equal(matchesToolPattern(scoped, "edit", input, root), true);
	assert.equal(matchesAllowedToolPatterns([scoped], "edit", input, root), true);
	assert.equal(matchesToolPattern(scoped, "edit", { path: "outside.txt", edits: replacements }, root), false);
	for (const invalid of invalidPreparedInputs) {
		assert.equal(matchesAllowedToolPatterns([scoped], "edit", invalid, root), false, JSON.stringify(invalid));
	}
});

test("Pi prepared safe edits use the inside-working-directory allow tier", async (t) => {
	const root = fixture(t);
	const ctx = createFakeCtx([], { cwd: root });
	const harness = await setupHookTest({
		ctx,
		config: baseConfig({ allowInsideWorkingDirectory: true }),
		classifier: async () => { throw new Error("A safe prepared edit must not call the classifier"); },
	});
	for (const edits of [[replacements[0]], replacements]) {
		assert.equal(await harness.emit("tool_call", { toolName: "edit", input: { path: "src/app.ts", edits } }, ctx), undefined);
	}
	assert.equal(harness.classifierCalls, 0);
});

test("Pi prepared safety-control targets remain hard denied before broad edit allows", async (t) => {
	const root = fixture(t);
	const previousRoot = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, ".pi/agent");
	t.after(() => { if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousRoot; });
	const broad = parseToolPattern("edit(*)");
	assert.ok(broad);
	const ctx = createFakeCtx([], { cwd: root });
	const harness = await setupHookTest({ ctx, config: baseConfig({
		allowInsideWorkingDirectory: true, permissionAllow: [broad],
	}) });
	for (const path of [".pi/agent/settings.json", ".omp/settings.json"]) {
		const input = { path, edits: replacements };
		assert.match(deterministicHardDeny("edit", input, root) ?? "", /safety-control/);
		const result = await harness.emit("tool_call", { toolName: "edit", input }, ctx) as { block?: boolean; reason?: string };
		assert.equal(result.block, true);
		assert.match(result.reason ?? "", /safety-control/);
	}
	assert.equal(harness.classifierCalls, 0);
});

test("Pi prepared deniedPaths override the safeedit and permissions allow tiers", async (t) => {
	const root = fixture(t);
	const broad = parseToolPattern("edit(*)");
	assert.ok(broad);
	const ctx = createFakeCtx([], { cwd: root });
	const harness = await setupHookTest({ ctx, config: baseConfig({
		allowInsideWorkingDirectory: true,
		permissionAllow: [broad],
		deniedPaths: [join(root, "src/app.ts")],
	}) });
	const result = await harness.emit("tool_call", {
		toolName: "edit", input: { path: "src/app.ts", edits: replacements },
	}, ctx) as { block?: boolean; reason?: string };
	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /Path denied by policy/);
	assert.equal(harness.classifierCalls, 0);
});

test("Pi prepared invalid arrays cannot use a safe compatibility path or any allow tier", async (t) => {
	const root = fixture(t);
	const broad = parseToolPattern("edit(*)");
	assert.ok(broad);
	const ctx = createFakeCtx([], { cwd: root });
	let prompts = 0;
	ctx.ui.confirm = async () => { prompts++; return true; };
	const harness = await setupHookTest({ ctx, config: baseConfig({
		allowInsideWorkingDirectory: true, permissionAllow: [broad],
	}) });
	for (const input of invalidPreparedInputs) {
		const result = await harness.emit("tool_call", { toolName: "edit", input }, ctx) as { block?: boolean; reason?: string };
		assert.equal(result.block, true, JSON.stringify(input));
		assert.match(result.reason ?? "", /could not be inspected safely/, JSON.stringify(input));
	}
	assert.equal(prompts, 0);
	assert.equal(harness.classifierCalls, 0);
});

test("Pi prepared support preserves complete OMP replacement and move targets", (t) => {
	const root = fixture(t);
	assert.deepEqual(extractEditPaths({ path: "src/app.ts", edits: [
		{ old_string: "first", new_string: "updated first" },
		{ old_string: "second", new_string: "updated second", replace_all: false },
	] }), { paths: ["src/app.ts"], format: "omp" });
	const input = { path: "src/app.ts", edits: [
		{ op: "update", diff: "@@\n-first\n+updated\n", rename: "src/moved.ts" },
		{ op: "create", diff: "new file", rename: ".omp/settings.json" },
	] };
	assert.deepEqual(extractEditPaths(input), {
		paths: ["src/app.ts", "src/moved.ts", ".omp/settings.json"], format: "omp",
	});
	assert.match(deterministicHardDeny("edit", input, root) ?? "", /safety-control/);
	const hashline = { input: "[src/app.ts#ABCD]\nMV .omp/settings.json\n", path: "src/app.ts" };
	assert.deepEqual(extractEditPaths(hashline), {
		paths: ["src/app.ts", ".omp/settings.json"], format: "omp",
	});
	assert.match(deterministicHardDeny("edit", hashline, root) ?? "", /safety-control/);
});
