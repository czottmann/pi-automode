import os from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {
	CONFIG_DIR_NAME,
	deterministicHardDeny,
	piGlobalSettingsPaths,
	piLegacyGlobalSettingsPath,
	resolveLogPath,
} from "../extensions/auto-mode.ts";

const PREVIOUS_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

function withAgentDir(dir: string | undefined, fn: () => void): void {
	if (dir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = dir;
	try {
		fn();
	} finally {
		if (PREVIOUS_AGENT_DIR === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = PREVIOUS_AGENT_DIR;
		}
	}
}

test("global settings paths follow PI_CODING_AGENT_DIR", () => {
	const customDir = join(os.tmpdir(), "pi-agent-custom-config");
	withAgentDir(customDir, () => {
		assert.equal(
			piGlobalSettingsPaths()[0],
			join(customDir, "extensions/pi-automode/config.json"),
		);
		assert.equal(
			piLegacyGlobalSettingsPath(),
			join(customDir, "automode.json"),
		);
	});
	withAgentDir(undefined, () => {
		assert.equal(
			piGlobalSettingsPaths()[0],
			join(
				resolve(os.homedir(), CONFIG_DIR_NAME, "agent"),
				"extensions/pi-automode/config.json",
			),
		);
	});
});

test("deterministic hard deny follows the effective agent directory", () => {
	const customDir = join(os.tmpdir(), "pi-agent-custom-guard");
	const defaultDir = resolve(os.homedir(), CONFIG_DIR_NAME, "agent");
	withAgentDir(customDir, () => {
		const customSettings = join(customDir, "settings.json");
		const customExtension = join(customDir, "extensions/example.ts");
		assert.match(
			deterministicHardDeny("edit", { path: customSettings }, "/tmp/project") ?? "",
			/safety-control/,
		);
		assert.match(
			deterministicHardDeny("write", { path: customExtension, content: "x" }, "/tmp/project") ?? "",
			/safety-control/,
		);
		// The stale default directory is no longer treated as the agent directory.
		assert.equal(
			deterministicHardDeny(
				"edit",
				{ path: join(defaultDir, "settings.json") },
				"/tmp/project",
			),
			undefined,
		);
	});
	withAgentDir(undefined, () => {
		assert.match(
			deterministicHardDeny(
				"edit",
				{ path: join(defaultDir, "settings.json") },
				"/tmp/project",
			) ?? "",
			/safety-control/,
		);
	});
});

test("deterministic hard deny canonicalizes a symlinked agent directory", () => {
	const realDir = mkdtempSync(join(os.tmpdir(), "pi-agent-real-"));
	const linkDir = join(os.tmpdir(), "pi-agent-link-canonical");
	rmSync(linkDir, { force: true });
	symlinkSync(realDir, linkDir);
	try {
		withAgentDir(linkDir, () => {
			// The target spelled through the canonical path is still guarded.
			assert.match(
				deterministicHardDeny(
					"edit",
					{ path: join(realDir, "settings.json") },
					"/tmp/project",
				) ?? "",
				/safety-control/,
			);
			// The target spelled through the symlink is guarded too.
			assert.match(
				deterministicHardDeny(
					"edit",
					{ path: join(linkDir, "settings.json") },
					"/tmp/project",
				) ?? "",
				/safety-control/,
			);
		});
	} finally {
		rmSync(linkDir, { force: true });
		rmSync(realDir, { recursive: true, force: true });
	}
});

test("deterministic hard deny tolerates a trailing separator in the agent directory", () => {
	const realDir = mkdtempSync(join(os.tmpdir(), "pi-agent-trailing-"));
	try {
		withAgentDir(`${realDir}/`, () => {
			assert.match(
				deterministicHardDeny(
					"edit",
					{ path: join(realDir, "settings.json") },
					"/tmp/project",
				) ?? "",
				/safety-control/,
			);
		});
	} finally {
		rmSync(realDir, { recursive: true, force: true });
	}
});

test("deterministic hard deny resolves a relative agent directory", () => {
	const baseDir = mkdtempSync(join(os.tmpdir(), "pi-agent-relative-"));
	const relativeDir = "rel-agent-dir";
	mkdirSync(join(baseDir, relativeDir), { recursive: true });
	const previousCwd = process.cwd();
	try {
		process.chdir(baseDir);
		withAgentDir(relativeDir, () => {
			assert.match(
				deterministicHardDeny(
					"edit",
					{ path: join(baseDir, relativeDir, "settings.json") },
					"/tmp/project",
				) ?? "",
				/safety-control/,
			);
		});
	} finally {
		process.chdir(previousCwd);
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("in-memory log root follows PI_CODING_AGENT_DIR", () => {
	const customDir = join(os.tmpdir(), "pi-agent-custom-logs");
	const sessionCwd = join(os.tmpdir(), "pi-agent-log-cwd");
	const projectDir = `--${
		sessionCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")
	}--`;
	withAgentDir(customDir, () => {
		assert.equal(
			resolveLogPath(
				undefined,
				"",
				"id",
				sessionCwd,
				undefined,
				new Date("2026-08-11T12:00:00.000Z"),
			),
			join(
				customDir,
				"extensions/pi-automode/logs",
				projectDir,
				"2026-08-11",
				"id-pi-automode.jsonl",
			),
		);
	});
});