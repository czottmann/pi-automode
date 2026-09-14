import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, parse as parsePath, relative, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import {
	MAX_WILDCARD_INPUT_LENGTH,
	MAX_WILDCARD_PATTERN_LENGTH,
	analyzeBash,
	appendPermissionPathPatternSuffix,
	buildEffectiveConfigFromSources,
	matchesDeniedPath,
	matchingBashCommandText,
	matchesToolPattern,
	matchesWildcardPattern,
	normalizePermissionPathForMatch,
	parseToolPattern,
	validateSettingsFile,
} from "../extensions/auto-mode.ts";

test("permission patterns keep argument scope instead of flattening to a tool allow", () => {
	const pattern = parseToolPattern("bash(git status*)");
	assert.ok(pattern);
	assert.equal(matchesToolPattern(pattern, "bash", { command: "git status --short" }, process.cwd()), true);
	assert.equal(matchesToolPattern(pattern, "bash", { command: "git push --force" }, process.cwd()), false);

	const capitalized = parseToolPattern("Bash(git status*)");
	assert.ok(capitalized);
	assert.equal(matchesToolPattern(capitalized, "bash", { command: "git status --short" }, process.cwd()), true);
});

test("malformed permission deny patterns fail closed without broadening allow rules", () => {
	for (const source of ["bash()", "bash(", 'bash(git push "unterminated)']) {
		const pattern = parseToolPattern(source);
		assert.ok(pattern);
		assert.equal(
			matchesToolPattern(pattern, "bash", { command: "git status" }, process.cwd(), "match"),
			true,
		);
		assert.equal(
			matchesToolPattern(pattern, "bash", { command: "git status" }, process.cwd(), "no-match"),
			false,
		);
	}
});

test("Bash permission denies match chained commands and normalized whitespace", () => {
	const pattern = parseToolPattern("bash(git push *)");
	assert.ok(pattern);

	for (const command of ["git status && git push", "git  push"]) {
		assert.equal(
			matchesToolPattern(
				pattern,
				"bash",
				{ command },
				process.cwd(),
				"match",
				analyzeBash(command),
			),
			true,
		);
	}
});

test(
	"POSIX permission paths preserve literal backslashes",
	{ skip: process.platform === "win32" },
	() => {
		const base = mkdtempSync(join(os.tmpdir(), "pi-automode-permission-backslash-"));
		try {
			mkdirSync(join(base, "safe"));
			writeFileSync(join(base, "safe", "secret"), "slash");
			writeFileSync(join(base, String.raw`safe\secret`), "backslash");
			const slashPattern = parseToolPattern("read(safe/secret)");
			const backslashPattern = parseToolPattern(String.raw`read(safe\secret)`);
			assert.ok(slashPattern);
			assert.ok(backslashPattern);

			for (const policy of ["match", "no-match"] as const) {
				assert.equal(
					matchesToolPattern(slashPattern, "read", { path: "safe/secret" }, base, policy),
					true,
				);
				assert.equal(
					matchesToolPattern(slashPattern, "read", { path: String.raw`safe\secret` }, base, policy),
					false,
				);
				assert.equal(
					matchesToolPattern(backslashPattern, "read", { path: String.raw`safe\secret` }, base, policy),
					true,
				);
				assert.equal(
					matchesToolPattern(backslashPattern, "read", { path: "safe/secret" }, base, policy),
					false,
				);
			}
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	},
);

test("permission path candidates normalize Windows separators", () => {
	const candidate = String.raw`C:\Users\carlo\private\secret.txt`;
	const normalized = normalizePermissionPathForMatch(candidate, "win32");

	assert.equal(normalized, "C:/Users/carlo/private/secret.txt");
	assert.equal(matchesWildcardPattern("C:/Users/*/secret.txt", normalized, "match"), true);
	assert.equal(matchesWildcardPattern("C:/Users/*/secret.txt", normalized, "no-match"), true);
});

test("permission path suffixes preserve Windows drive roots", () => {
	assert.equal(appendPermissionPathPatternSuffix("C:/", "*"), "C:/*");
	assert.equal(appendPermissionPathPatternSuffix("/", "*"), "/*");
	assert.equal(
		appendPermissionPathPatternSuffix("C:/Users/carlo", "*/secret"),
		"C:/Users/carlo/*/secret",
	);
});

test(
	"Windows drive-root junction permission patterns match canonical targets",
	{ skip: process.platform !== "win32" },
	() => {
		const base = mkdtempSync(join(os.tmpdir(), "pi-automode-permission-drive-root-"));
		try {
			const driveRoot = parsePath(base).root;
			const link = join(base, "drive-root-link");
			symlinkSync(driveRoot, link, "junction");
			const pattern = parseToolPattern(`read(${link}/*)`);
			assert.ok(pattern);
			const input = join(driveRoot, "Windows", "System32", "file");

			for (const policy of ["match", "no-match"] as const) {
				assert.equal(
					matchesToolPattern(pattern, "read", { path: input }, base, policy),
					true,
				);
			}
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	},
);

test("relative permission path patterns resolve against the session cwd", () => {
	const base = mkdtempSync(join(os.tmpdir(), "pi-automode-permission-cwd-"));
	try {
		const processDir = join(base, "process");
		const sessionDir = join(base, "session");
		const processTarget = join(base, "process-target");
		const sessionTarget = join(base, "session-target");
		for (const path of [processDir, sessionDir, processTarget, sessionTarget]) {
			mkdirSync(path);
		}
		symlinkSync(processTarget, join(processDir, "safe"));
		symlinkSync(sessionTarget, join(sessionDir, "safe"));
		const processSecret = join(processTarget, "secret.txt");
		const sessionSecret = join(sessionTarget, "secret.txt");
		writeFileSync(processSecret, "process");
		writeFileSync(sessionSecret, "session");

		const moduleUrl = pathToFileURL(join(process.cwd(), "extensions/auto-mode.ts")).href;
		const script = `
			import { matchesToolPattern, parseToolPattern } from ${JSON.stringify(moduleUrl)};
			process.chdir(${JSON.stringify(processDir)});
			const pattern = parseToolPattern("read(safe/*)");
			if (!pattern) throw new Error("pattern did not parse");
			console.log(JSON.stringify({
				processDeny: matchesToolPattern(pattern, "read", { path: ${JSON.stringify(processSecret)} }, ${JSON.stringify(sessionDir)}, "match"),
				processAllow: matchesToolPattern(pattern, "read", { path: ${JSON.stringify(processSecret)} }, ${JSON.stringify(sessionDir)}, "no-match"),
				sessionDeny: matchesToolPattern(pattern, "read", { path: ${JSON.stringify(sessionSecret)} }, ${JSON.stringify(sessionDir)}, "match"),
				sessionAllow: matchesToolPattern(pattern, "read", { path: ${JSON.stringify(sessionSecret)} }, ${JSON.stringify(sessionDir)}, "no-match"),
			}));
		`;
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", script],
			{ cwd: process.cwd(), encoding: "utf8" },
		);

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), {
			processDeny: false,
			processAllow: false,
			sessionDeny: true,
			sessionAllow: true,
		});
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("path permission rules match canonical symlink targets", () => {
	const base = mkdtempSync(join(os.tmpdir(), "pi-automode-permission-symlink-"));
	try {
		const target = join(base, "secret.txt");
		const link = join(base, "public.txt");
		writeFileSync(target, "secret");
		symlinkSync(target, link);
		const pattern = parseToolPattern(`read(${target})`);
		assert.ok(pattern);

		for (const policy of ["match", "no-match"] as const) {
			assert.equal(
				matchesToolPattern(pattern, "read", { path: link }, base, policy),
				true,
			);
		}
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("path permission rules normalize file URLs before matching", () => {
	const path = join(os.tmpdir(), "pi-automode-permission-secret.txt");
	const pattern = parseToolPattern(`read(${path})`);
	assert.ok(pattern);

	for (const policy of ["match", "no-match"] as const) {
		assert.equal(
			matchesToolPattern(
				pattern,
				"read",
				{ path: pathToFileURL(path).href },
				process.cwd(),
				policy,
			),
			true,
		);
	}
});

test("matchingBashCommandText reports the specific nested command match", () => {
	const pattern = parseToolPattern("bash(git push*)");
	assert.ok(pattern);
	const analysis = analyzeBash("echo $(git push origin main)");

	assert.equal(
		matchingBashCommandText(pattern, analysis),
		"git push origin main",
	);
});

test("matchingBashCommandText falls back to an explicit full-script match", () => {
	const pattern = parseToolPattern("bash(git status* && echo *)");
	assert.ok(pattern);
	const source = "git status --short && echo done";

	assert.equal(
		matchingBashCommandText(pattern, analyzeBash(source)),
		source,
	);
});

test("matchingBashCommandText omits unsafe or unscoped match details", () => {
	const scoped = parseToolPattern("bash(git status*)");
	const bare = parseToolPattern("bash");
	assert.ok(scoped);
	assert.ok(bare);

	assert.equal(matchingBashCommandText(scoped, analyzeBash('echo "')), undefined);
	assert.equal(matchingBashCommandText(bare, analyzeBash("git status")), undefined);
	assert.equal(matchingBashCommandText(scoped, undefined), undefined);
});

test("wildcard matching is anchored, case-insensitive, and includes newlines", () => {
	assert.equal(matchesWildcardPattern("git *", "GIT status\n--short"), true);
	assert.equal(matchesWildcardPattern("*.env", "/tmp/project/.ENV"), true);
	assert.equal(matchesWildcardPattern("Σ*", "ς-file"), true);
	assert.equal(matchesWildcardPattern("Μ*", "µ-file"), true);
	assert.equal(matchesWildcardPattern("a.b", "axb"), false);
	assert.equal(matchesWildcardPattern("prefix*suffix", "prefixsuffix"), true);
	assert.equal(matchesWildcardPattern("prefix*suffix", "xprefixsuffix"), false);
	assert.equal(matchesWildcardPattern("prefix*suffix", "prefixsuffixx"), false);
});

test("wildcard matching applies context-specific overflow behavior", () => {
	const maximumPattern = "a".repeat(MAX_WILDCARD_PATTERN_LENGTH);
	const maximumInput = "a".repeat(MAX_WILDCARD_INPUT_LENGTH);
	assert.equal(matchesWildcardPattern(maximumPattern, maximumPattern), true);
	assert.equal(matchesWildcardPattern("b", maximumInput), false);
	assert.equal(matchesWildcardPattern(`${maximumPattern}a`, "b"), true);
	assert.equal(matchesWildcardPattern("b", `${maximumInput}a`), true);
	assert.equal(matchesWildcardPattern(`${maximumPattern}a`, "b", "no-match"), false);
	assert.equal(matchesWildcardPattern("b", `${maximumInput}a`, "no-match"), false);

	const broadBash = parseToolPattern("bash(*)");
	assert.ok(broadBash);
	const oversizedCommand = { command: `${maximumInput}a` };
	assert.equal(matchesToolPattern(broadBash, "bash", oversizedCommand, process.cwd()), true);
	assert.equal(
		matchesToolPattern(broadBash, "bash", oversizedCommand, process.cwd(), "no-match"),
		false,
	);
});

test("wildcard config limits produce diagnostics and reject oversized entries", () => {
	const maximumPermission = `bash(${
		"a".repeat(MAX_WILDCARD_PATTERN_LENGTH - "bash()".length)
	})`;
	const oversizedPermission = `${maximumPermission}a`;
	const maximumDeniedPath = `/${
		"a".repeat(MAX_WILDCARD_PATTERN_LENGTH - 1)
	}`;
	const oversizedDeniedPath = `${maximumDeniedPath}a`;
	const settings = {
		autoMode: {
			deniedPaths: [maximumDeniedPath, oversizedDeniedPath],
		},
		permissions: {
			deny: [maximumPermission, oversizedPermission],
			allow: [maximumPermission, oversizedPermission],
		},
	};

	const diagnostics = validateSettingsFile(settings, "test-config");
	assert.equal(
		diagnostics.some((line) =>
			line.includes(`permissions.deny[1] must be at most ${MAX_WILDCARD_PATTERN_LENGTH} characters`)
		),
		true,
	);
	assert.equal(
		diagnostics.some((line) =>
			line.includes(`permissions.allow[1] must be at most ${MAX_WILDCARD_PATTERN_LENGTH} characters`)
		),
		true,
	);
	assert.equal(
		diagnostics.some((line) =>
			line.includes(`deniedPaths[1] must be at most ${MAX_WILDCARD_PATTERN_LENGTH} characters`)
		),
		true,
	);

	const config = buildEffectiveConfigFromSources({
		projectLocalSettings: [settings],
	});
	assert.deepEqual(config.deniedPaths, [maximumDeniedPath]);
	assert.deepEqual(config.permissionDeny.map((pattern) => pattern.raw), [
		maximumPermission,
	]);
	assert.deepEqual(config.permissionAllow.map((pattern) => pattern.raw), [
		maximumPermission,
	]);
});

test("adversarial wildcard matching completes within a bounded child process", () => {
	const script = `
		import { matchesWildcardPattern } from "./extensions/auto-mode.ts";
		const pattern = "*a".repeat(30) + "b";
		const value = "a".repeat(300);
		process.stdout.write(String(matchesWildcardPattern(pattern, value)));
	`;
	// The bound accommodates cold-start module import (includes the
	// peer-dependent pi-coding-agent graph) plus the adversarial match.
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", "--input-type=module", "-e", script],
		{ cwd: process.cwd(), encoding: "utf8", timeout: 10_000 },
	);

	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "false");
});

test("denied-path matching uses the bounded wildcard matcher", () => {
	assert.equal(
		matchesDeniedPath("/tmp/project/secret\nfile", ["/tmp/*"]),
		true,
	);
	assert.equal(
		matchesDeniedPath("/tmp/project/public.txt", ["/tmp/*/secret.txt"]),
		false,
	);
});
