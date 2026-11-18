import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { deterministicHardDeny, parseToolPattern } from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, setupHookTest } from "./test-helpers.ts";

type Fixture = { root: string; agentDir: string; cwd: string };

async function withAgentFixture(run: (fixture: Fixture) => void | Promise<void>) {
	const root = mkdtempSync(join(os.tmpdir(), "pi-control-links-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	mkdirSync(agentDir);
	mkdirSync(cwd);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await run({ root, agentDir, cwd });
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
}

function assertControlDenied(path: string, cwd: string) {
	for (const toolName of ["write", "edit"]) {
		assert.match(
			deterministicHardDeny(toolName, { path, content: "{}" }, cwd) ?? "",
			/safety-control/,
			`${toolName}: ${path}`,
		);
	}
	assert.match(
		deterministicHardDeny("bash", {
			command: `printf test > ${JSON.stringify(path)}`,
		}, cwd) ?? "",
		/safety-control/,
		`bash: ${path}`,
	);
}

for (const exists of [true, false]) {
	test(`global settings protect linked and resolved paths when target exists=${exists}`, async () => {
		await withAgentFixture(({ root, agentDir, cwd }) => {
			const target = join(root, "dotfiles", "preferences.json");
			mkdirSync(dirname(target));
			if (exists) writeFileSync(target, "{}");
			const link = join(agentDir, "settings.json");
			symlinkSync(relative(agentDir, target), link);
			const alias = join(cwd, "preferences.json");
			symlinkSync(target, alias);

			for (const path of [link, target, alias]) assertControlDenied(path, cwd);
			assert.equal(
				deterministicHardDeny("write", {
					path: join(dirname(target), "notes.json"),
				}, cwd),
				undefined,
			);
		});
	});
}

for (const directory of ["extensions", "settings"]) {
	test(`global ${directory} protect linked and resolved directory trees`, async () => {
		await withAgentFixture(({ root, agentDir, cwd }) => {
			const target = join(root, "dotfiles", "controls");
			mkdirSync(target, { recursive: true });
			const link = join(agentDir, directory);
			symlinkSync(target, link, "junction");
			const alias = join(cwd, "controls");
			symlinkSync(target, alias, "junction");

			for (const path of [link, target, alias]) {
				assertControlDenied(path, cwd);
				assertControlDenied(join(path, "nested", "config.json"), cwd);
			}
			assert.equal(
				deterministicHardDeny("write", {
					path: join(root, "dotfiles", "controls-backup", "config.json"),
				}, cwd),
				undefined,
			);
		});
	});
}

test("a file symlink inside global extensions keeps its control-path protection", async () => {
	await withAgentFixture(({ root, agentDir, cwd }) => {
		const target = join(root, "script.ts");
		writeFileSync(target, "export default () => {};");
		const link = join(agentDir, "extensions", "script.ts");
		mkdirSync(dirname(link));
		symlinkSync(target, link);

		assertControlDenied(link, cwd);
	});
});

test("linked global settings cannot use permission or workspace allow tiers", async () => {
	await withAgentFixture(async ({ root, agentDir, cwd }) => {
		const target = join(cwd, "preferences.json");
		writeFileSync(target, "{}");
		const link = join(agentDir, "settings.json");
		symlinkSync(target, link);
		const alias = join(root, "preferences.json");
		symlinkSync(target, alias);
		const permissionAllow = ["write", "edit", "bash"].map((name) => {
			const pattern = parseToolPattern(name);
			assert.ok(pattern);
			return pattern;
		});
		const harness = await setupHookTest({
			config: baseConfig({ allowInsideWorkingDirectory: true, permissionAllow }),
			ctx: createFakeCtx([], { cwd }),
		});

		for (const path of [link, target, alias]) {
			for (const toolName of ["write", "edit", "bash"]) {
				const input = toolName === "bash"
					? { command: `printf test > ${JSON.stringify(path)}` }
					: { path, content: "{}" };
				const result = await harness.emit("tool_call", {
					toolName,
					input,
				}, harness.ctx) as { block?: boolean; reason?: string };

				assert.equal(result?.block, true, `${toolName}: ${path}`);
				assert.match(result.reason ?? "", /safety-control/);
			}
		}
		assert.equal(harness.classifierCalls, 0);
	});
});
