import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
	matchesAllowedToolPatterns,
	matchesToolPattern,
	parseToolPattern,
	type ToolPattern,
} from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, setupHookTest } from "./test-helpers.ts";

interface PermissionTargetCase {
	toolName: string;
	input: Record<string, unknown>;
	deniedPath: string;
	cwd: string;
}

interface ToolCallResult {
	block?: boolean;
	reason?: string;
}

async function assertScopedDenyAndAsk(target: PermissionTargetCase): Promise<void> {
	const scoped = parseToolPattern(`${target.toolName}(${target.deniedPath})`);
	const allow = parseToolPattern(`${target.toolName}(*)`);
	assert.ok(scoped);
	assert.ok(allow);
	assert.equal(matchesToolPattern(scoped, target.toolName, target.input, target.cwd), true);
	assert.equal(matchesToolPattern(scoped, target.toolName, { path: "safe.txt" }, target.cwd), false);

	for (const permission of ["permissionDeny", "permissionAsk"] as const) {
		let prompts = 0;
		const ctx = createFakeCtx([], { cwd: target.cwd });
		ctx.ui.confirm = async () => {
			prompts += 1;
			return false;
		};
		const harness = await setupHookTest({
			config: baseConfig({ [permission]: [scoped], permissionAllow: [allow] }),
			ctx,
		});
		const result = await harness.emit("tool_call", {
			toolName: target.toolName,
			input: target.input,
		}, harness.ctx) as ToolCallResult | undefined;
		assert.equal(result?.block, true, `${permission}: ${JSON.stringify(target.input)}`);
		assert.match(result?.reason ?? "", permission === "permissionDeny"
			? /permissions\.deny/
			: /Declined permissions\.ask/);
		assert.equal(prompts, permission === "permissionAsk" ? 1 : 0);
		assert.equal(harness.classifierCalls, 0);
	}
}

// Native path-utils.expandTilde treats ~name as HOME/name; normalizeAtPrefix
// preserves @relative. Pi treats these as cwd/~name and cwd/relative instead.
test("OMP scoped permission native aliases deny and ask every effective target", async (t) => {
	const cwd = mkdtempSync(join(os.tmpdir(), "automode-permission-alias-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const name = basename(cwd);
	for (const toolName of ["read", "write", "edit", "find", "ls"]) {
		for (const [path, deniedPath] of [
			[`~${name}/blocked.txt`, join(os.homedir(), name, "blocked.txt")],
			["@blocked.txt", join(cwd, "@blocked.txt")],
		]) {
			await assertScopedDenyAndAsk({ toolName, input: { path }, deniedPath, cwd });
		}
	}
});

// Native write unwrapHashlineHeaderPath accepts [path] and [path#XXXX],
// including trailing whitespace, before routing and filesystem resolution.
test("OMP scoped permission bracket write deny and ask the unwrapped target", async (t) => {
	const cwd = mkdtempSync(join(os.tmpdir(), "automode-permission-write-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	for (const path of ["[blocked.txt]", "[blocked.txt#1A2B]", "[blocked.txt#1a2b] \t"]) {
		await assertScopedDenyAndAsk({
			toolName: "write",
			input: { path, content: "blocked" },
			deniedPath: join(cwd, "blocked.txt"),
			cwd,
		});
	}
});

// Native read splitDelimitedPathEntry prefers an existing literal, then
// recovers semicolon lists. Create both parts so this is actual native fan-out.
test("OMP scoped permission multi-target read deny and ask match any target", async (t) => {
	const cwd = mkdtempSync(join(os.tmpdir(), "automode-permission-read-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeFileSync(join(cwd, "safe.txt"), "safe");
	writeFileSync(join(cwd, "blocked.txt"), "blocked");
	await assertScopedDenyAndAsk({
		toolName: "read",
		input: { path: "safe.txt;blocked.txt" },
		deniedPath: join(cwd, "blocked.txt"),
		cwd,
	});
});

test("OMP scoped permission multi-target read allow requires complete union coverage", async (t) => {
	const cwd = mkdtempSync(join(os.tmpdir(), "automode-permission-coverage-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	mkdirSync(join(cwd, "safe"));
	writeFileSync(join(cwd, "safe", "a.txt"), "a");
	writeFileSync(join(cwd, "safe", "b.txt"), "b");
	const input = { path: "safe/a.txt;safe/b.txt" };
	const partial = parseToolPattern("read(safe/a.txt*)");
	const complete = parseToolPattern("read(safe/*)");
	assert.ok(partial);
	assert.ok(complete);
	assert.equal(matchesToolPattern(partial, "read", input, cwd, "no-match"), false);
	assert.equal(matchesAllowedToolPatterns([partial], "read", input, cwd), false);
	assert.equal(matchesToolPattern(complete, "read", input, cwd, "no-match"), true);
	assert.equal(matchesAllowedToolPatterns([complete], "read", input, cwd), true);

	const splitCoverage: ToolPattern[] = [];
	for (const path of ["safe/a.txt", "safe/b.txt", input.path]) {
		const pattern = parseToolPattern(`read(${path})`);
		assert.ok(pattern);
		splitCoverage.push(pattern);
	}
	assert.equal(matchesAllowedToolPatterns(splitCoverage, "read", input, cwd), true);

	for (const [permissionAllow, expectedCalls] of [[ [partial], 1 ], [ [complete], 0 ]] as const) {
		const harness = await setupHookTest({
			config: baseConfig({ classifyReadOnlyTools: true, permissionAllow: [...permissionAllow] }),
			ctx: createFakeCtx([], { cwd }),
		});
		assert.equal(await harness.emit("tool_call", { toolName: "read", input }, harness.ctx), undefined);
		assert.equal(harness.classifierCalls, expectedCalls);
	}
});

test("OMP scoped permission alias allow covers Pi and native targets rather than either alone", (t) => {
	const cwd = mkdtempSync(join(os.tmpdir(), "automode-permission-union-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const pi = parseToolPattern(`write(${join(cwd, "blocked.txt")})`);
	const native = parseToolPattern(`write(${join(cwd, "@blocked.txt")})`);
	assert.ok(pi);
	assert.ok(native);
	const input = { path: "@blocked.txt", content: "data" };
	assert.equal(matchesAllowedToolPatterns([pi], "write", input, cwd), false);
	assert.equal(matchesAllowedToolPatterns([native], "write", input, cwd), false);
	assert.equal(matchesAllowedToolPatterns([pi, native], "write", input, cwd), true);
});

test("OMP scoped permission bare allows reject ambiguous extraction and unsafe canonical targets", (t) => {
	const cwd = mkdtempSync(join(os.tmpdir(), "automode-permission-unsafe-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	for (const toolName of ["read", "write", "edit", "find", "ls"]) {
		const bare = parseToolPattern(toolName);
		assert.ok(bare);
		for (const input of [{ path: {} }, { path: "safe.txt\u0000blocked" }]) {
			assert.equal(matchesToolPattern(bare, toolName, input, cwd, "no-match"), false);
			assert.equal(matchesAllowedToolPatterns([bare], toolName, input, cwd), false);
		}
	}
	if (process.platform === "win32") return;
	symlinkSync("loop-b", join(cwd, "loop-a"));
	symlinkSync("loop-a", join(cwd, "loop-b"));
	for (const toolName of ["read", "write", "edit", "find", "ls"]) {
		const bare = parseToolPattern(toolName);
		assert.ok(bare);
		assert.equal(matchesToolPattern(bare, toolName, { path: "loop-a/new.txt" }, cwd, "no-match"), false);
		assert.equal(matchesAllowedToolPatterns([bare], toolName, { path: "loop-a/new.txt" }, cwd), false);
	}
});

test("OMP scoped permission resolved paths are not expanded a second time", { skip: process.platform === "win32" }, (t) => {
	const base = mkdtempSync(join(os.tmpdir(), "automode-permission-resolved-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const cwd = join(base, "native\u202froot");
	const piCwd = join(base, "native root");
	mkdirSync(cwd);
	mkdirSync(piCwd);
	const native = parseToolPattern(`edit(${join(cwd, "file.txt")})`);
	const pi = parseToolPattern(`edit(${join(piCwd, "file.txt")})`);
	assert.ok(native);
	assert.ok(pi);
	const input = { input: "*** Begin Patch\n[file.txt#1A2B]\nREM\n*** End Patch\n" };
	// OMP resolves against the literal cwd. Re-normalizing this absolute target
	// as raw input would change the cwd's narrow space and select the Pi sibling.
	assert.equal(matchesToolPattern(native, "edit", input, cwd), true);
	assert.equal(matchesAllowedToolPatterns([pi], "edit", input, cwd), false);
	assert.equal(matchesAllowedToolPatterns([native], "edit", input, cwd), true);
});

test("OMP scoped permission allows require canonical coverage instead of symlink spelling", { skip: process.platform === "win32" }, (t) => {
	const cwd = mkdtempSync(join(os.tmpdir(), "automode-permission-canonical-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	mkdirSync(join(cwd, "safe"));
	mkdirSync(join(cwd, "outside"));
	symlinkSync(join(cwd, "outside"), join(cwd, "safe", "link"));
	for (const toolName of ["read", "write", "edit", "find", "ls"]) {
		const lexical = parseToolPattern(`${toolName}(safe/*)`);
		const canonical = parseToolPattern(`${toolName}(outside/*)`);
		assert.ok(lexical);
		assert.ok(canonical);
		const input = { path: "safe/link/file.txt" };
		assert.equal(matchesToolPattern(lexical, toolName, input, cwd), true);
		assert.equal(matchesAllowedToolPatterns([lexical], toolName, input, cwd), false);
		assert.equal(matchesAllowedToolPatterns([canonical], toolName, input, cwd), true);
	}
});

test("OMP scoped permission Pi controls preserve scalar paths and grep pattern scope", (t) => {
	const cwd = mkdtempSync(join(os.tmpdir(), "automode-permission-pi-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	mkdirSync(join(cwd, "safe"));
	for (const toolName of ["read", "write", "edit", "find", "ls"]) {
		const scoped = parseToolPattern(`${toolName}(safe/*)`);
		const bare = parseToolPattern(toolName);
		assert.ok(scoped);
		assert.ok(bare);
		for (const path of ["safe/file.txt", join(cwd, "safe", "file.txt")]) {
			assert.equal(matchesToolPattern(scoped, toolName, { path }, cwd), true);
			assert.equal(matchesAllowedToolPatterns([scoped], toolName, { path }, cwd), true);
			assert.equal(matchesAllowedToolPatterns([bare], toolName, { path }, cwd), true);
		}
		assert.equal(matchesToolPattern(scoped, toolName, { path: "other/file.txt" }, cwd), false);
		assert.equal(matchesAllowedToolPatterns([scoped], toolName, { path: "other/file.txt" }, cwd), false);
	}
	const grep = parseToolPattern("grep(secret*)");
	assert.ok(grep);
	for (const policy of ["match", "no-match"] as const) {
		assert.equal(matchesToolPattern(grep, "grep", { pattern: "secret.*", path: "safe" }, cwd, policy), true);
		assert.equal(matchesToolPattern(grep, "grep", { pattern: "public", path: "secret.txt" }, cwd, policy), false);
	}
});
