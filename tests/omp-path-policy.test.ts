import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deterministicHardDeny, parseToolPattern } from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, setupHookTest, type ToolCallHarness } from "./test-helpers.ts";

function patch(...sections: string[]): string {
	return `*** Begin Patch\n${sections.join("\n")}\n*** End Patch\n`;
}

function remove(path: string): string {
	return `[${path}#1A2B]\nREM`;
}

async function call(harness: ToolCallHarness, input: Record<string, unknown>) {
	return await harness.emit("tool_call", { toolName: "edit", input }, harness.ctx) as { block?: boolean; reason?: string } | undefined;
}

test("OMP hard-denies any hashline source or move destination before classification", async () => {
	for (const input of [
		{ input: patch(remove("src/safe.ts"), remove("~/.zshrc")) },
		{ input: patch("[src/safe.ts#1A2B]\nMV ~/.ssh/authorized_keys") },
	]) {
		const harness = await setupHookTest();
		const result = await call(harness, input);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /hard-denied/);
		assert.equal(harness.classifierCalls, 0);
	}
});

test("OMP deniedPaths applies to the second source and move destination", async () => {
	for (const input of [
		{ input: patch(remove("src/a.ts"), remove("secrets/token")) },
		{ input: patch("[src/a.ts#1A2B]\nMV secrets/token") },
	]) {
		const harness = await setupHookTest({ config: baseConfig({ deniedPaths: ["**/secrets/*"] }) });
		assert.equal((await call(harness, input))?.block, true);
		assert.equal(harness.classifierCalls, 0);
	}
});

test("OMP normalized source metadata permits safe edits but cannot conceal other targets", async () => {
	const harness = await setupHookTest({ config: baseConfig({ allowInsideWorkingDirectory: true, deniedPaths: ["**/secrets/*"] }) });
	assert.equal(await call(harness, { input: patch(remove("src/a.ts")), path: "src/a.ts", paths: ["src/a.ts"] }), undefined);
	assert.equal(await call(harness, { input: patch(remove("src/a.ts"), remove("src/b.ts")), paths: ["src/a.ts", "src/b.ts"] }), undefined);
	assert.equal(harness.classifierCalls, 0);
	assert.equal((await call(harness, { input: patch(remove("src/a.ts"), remove("secrets/token")), path: "src/a.ts", paths: ["src/a.ts"] }))?.block, true);
	assert.equal((await call(harness, { input: patch("[src/a.ts#1A2B]\nMV secrets/token"), path: "src/a.ts", paths: ["src/a.ts"] }))?.block, true);
	assert.equal((await call(harness, { input: patch(remove("src/a.ts")), paths: ["decoy.ts"] }))?.block, true);
	assert.equal(harness.classifierCalls, 0);
});

test("OMP conflicting compatibility path and malformed trailing syntax fail closed", async () => {
	for (const input of [
		{ path: "src/safe.ts", input: patch(remove("src/other.ts")) },
		{ path: "src/safe.ts", input: patch(remove("src/safe.ts"), "[src/other.ts#3C4D]\nINVALID") },
		{ path: "src/safe.ts", input: "not a patch" },
		{ path: "src/safe.ts", input: patch(remove("ssh://host/etc/config")) },
	]) {
		const harness = await setupHookTest({ config: baseConfig({ allowInsideWorkingDirectory: true, permissionAllow: [parseToolPattern("Edit")] }) });
		const result = await call(harness, input);
		assert.equal(result?.block, true);
		assert.equal(harness.classifierCalls, 0);
	}
});

test("OMP inside-CWD fast allow requires every source and destination inside", async () => {
	const harness = await setupHookTest({ config: baseConfig({ allowInsideWorkingDirectory: true }) });
	assert.equal(await call(harness, { input: patch(remove("src/a.ts"), remove("src/b.ts")) }), undefined);
	assert.equal(harness.classifierCalls, 0);
	assert.equal(await call(harness, { input: patch(remove("src/a.ts"), remove("../outside.ts")) }), undefined);
	assert.equal(harness.classifierCalls, 1);
	assert.equal(await call(harness, { input: patch("[src/a.ts#1A2B]\nMV ../destination.ts") }), undefined);
	assert.equal(harness.classifierCalls, 2);
});

test("OMP permission deny checks all targets and allow cannot cover an unchecked target", async () => {
	const denied = await setupHookTest({ config: baseConfig({ permissionDeny: [parseToolPattern("Edit(secrets/*)")] }) });
	assert.equal((await call(denied, { input: patch(remove("src/a.ts"), remove("secrets/token")) }))?.block, true);
	assert.equal(denied.classifierCalls, 0);
	const allowed = await setupHookTest({ config: baseConfig({ permissionAllow: [parseToolPattern("Edit(src/*)")] }) });
	assert.equal(await call(allowed, { input: patch(remove("src/a.ts"), remove("src/b.ts")) }), undefined);
	assert.equal(allowed.classifierCalls, 0);
	assert.equal(await call(allowed, { input: patch(remove("src/a.ts"), remove("other/b.ts")) }), undefined);
	assert.equal(allowed.classifierCalls, 1);
});

test("OMP protected destination cannot use inside-CWD or permission allow", async () => {
	for (const config of [baseConfig({ allowInsideWorkingDirectory: true }), baseConfig({ permissionAllow: [parseToolPattern("Edit")] })]) {
		const harness = await setupHookTest({ config, classifier: async () => ({ decision: "block", tier: "hard_deny", reason: "protected destination" }) });
		const result = await call(harness, { input: patch("[src/a.ts#1A2B]\nMV .git/config") });
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /protected destination/);
		assert.equal(harness.classifierCalls, 1);
	}
});

test("OMP target symlinks and ancestors of new destinations cannot bypass deniedPaths", async (t) => {
	const base = mkdtempSync(join(os.tmpdir(), "automode-omp-policy-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(base, "secret"));
	symlinkSync(join(base, "secret"), join(base, "alias"));
	const harness = await setupHookTest({ ctx: createFakeCtx([], { cwd: base }), config: baseConfig({ deniedPaths: [`${base}/secret/*`], allowInsideWorkingDirectory: true }) });
	assert.equal((await call(harness, { input: patch(remove("src/a.ts"), remove("alias/token")) }))?.block, true);
	assert.equal((await call(harness, { input: patch("[src/a.ts#1A2B]\nMV alias/new/deep/token") }))?.block, true);
	assert.equal(harness.classifierCalls, 0);
});

test("OMP safety controls retain Pi protections and cover local and global OMP settings", () => {
	for (const path of ["~/.pi/agent/settings.json", "~/.omp/agent/settings.json", ".omp/settings.json", ".omp/extensions/guard.ts", "~/.omp/agent/extensions/guard.ts"]) {
		assert.match(deterministicHardDeny("edit", { input: patch(remove(path)) }, "/tmp/project") ?? "", /safety-control/);
		assert.match(deterministicHardDeny("write", { path, content: "{}" }, "/tmp/project") ?? "", /safety-control/);
	}
});

test("OMP execution aliases cannot hide profile targets", () => {
	for (const path of ["@~/.zshrc", ":~/.zshrc", "~.zshrc", "~//.zshrc"]) {
		assert.match(deterministicHardDeny("edit", { input: patch(remove(path)) }, "/tmp/project") ?? "", /profile/);
	}
});

test("overlapping scalar schemas cannot hide OMP control paths behind host aliases", () => {
	assert.match(deterministicHardDeny("write", { path: "~.omp/agent/settings.json", content: "{}" }, "/tmp/project") ?? "", /safety-control/);
	assert.match(deterministicHardDeny("edit", { path: ":~/.omp/agent/settings.json", oldText: "old", newText: "new" }, "/tmp/project") ?? "", /safety-control/);
});

test("OMP configured agent roots and lexical control symlinks remain hard denied", (t) => {
	const base = mkdtempSync(join(os.tmpdir(), "omp-controls-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(base, "custom-agent");
	try {
		assert.match(deterministicHardDeny("edit", { input: patch(remove(join(base, "custom-agent/settings.json"))) }, base) ?? "", /safety-control/);
		mkdirSync(join(base, ".omp"));
		mkdirSync(join(base, "ordinary"));
		symlinkSync(join(base, "ordinary"), join(base, ".omp/extensions"));
		assert.match(deterministicHardDeny("edit", { input: patch(remove(".omp/extensions/new.ts")) }, base) ?? "", /safety-control/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("OMP control protection also covers shell redirection and interpreter writes", () => {
	for (const command of ["printf '{}' > ~/.omp/agent/settings.json", "python3 -c 'open(\".omp/settings.json\", \"w\").write(\"{}\")'"]) {
		assert.match(deterministicHardDeny("bash", { command }, "/tmp/project") ?? "", /safety-control/);
	}
});
