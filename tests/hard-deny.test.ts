import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	deterministicHardDeny,
	isRootHomeOrSystemPath,
	tempRootCandidates,
} from "../extensions/auto-mode.ts";

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

test("deterministic hard deny protects global Pi extensions and settings", () => {
	const agentDir = join(os.homedir(), ".pi/agent");
	for (const path of [
		join(agentDir, "extensions/auto-mode.ts"),
		join(agentDir, "extensions/pi-automode/config.json"),
		join(os.homedir(), ".PI/AGENT/EXTENSIONS/auto-mode.ts"),
		join(agentDir, "settings.json"),
		join(agentDir, "settings/providers.json"),
	]) {
		assert.match(
			deterministicHardDeny("write", { path }, "/tmp/project") ?? "",
			/safety-control/,
			path,
		);
	}
	assert.match(
		deterministicHardDeny(
			"edit",
			{ path: join(agentDir, "settings.json") },
			"/tmp/project",
		) ?? "",
		/safety-control/,
	);

	assert.equal(
		deterministicHardDeny(
			"write",
			{ path: "/tmp/project/src/app.ts" },
			"/tmp/project",
		),
		undefined,
	);
});

test("deterministic hard deny resolves symlinks to global Pi extensions", () => {
	const project = mkdtempSync(join(os.tmpdir(), "pi-automode-global-extension-link-"));
	try {
		const link = join(project, "linked-extensions");
		symlinkSync(join(os.homedir(), ".pi/agent/extensions"), link);
		assert.match(
			deterministicHardDeny(
				"write",
				{ path: join(link, "auto-mode.ts") },
				project,
			) ?? "",
			/safety-control/,
		);
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
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

test("AST hard-deny checks inspect nested and background commands", () => {
	for (const command of [
		'echo "$(git config --global http.sslVerify false)"',
		"cat <(git config --global http.sslVerify false)",
		"echo safe & git config --global http.sslVerify false",
		"if test -n x; then git config --global http.sslVerify false; fi",
	]) {
		assert.match(
			deterministicHardDeny("bash", { command }, process.cwd()) ?? "",
			/TLS/,
			command,
		);
	}
});

test("AST hard-deny checks inspect literal shell and eval wrappers", () => {
	for (const command of [
		`bash -c 'rm -rf /'`,
		`sh -c 'rm -rf /'`,
		`eval 'rm -rf /'`,
	]) {
		assert.match(
			deterministicHardDeny("bash", { command }, process.cwd()) ?? "",
			/irreversible deletion/,
			command,
		);
	}
});

test("AST hard-deny checks inspect literal shells behind transparent dispatch wrappers", () => {
	for (const command of [
		`command bash -c 'rm -rf /'`,
		`command -p /bin/bash -c 'rm -rf /'`,
		`exec sh -c 'rm -rf /'`,
		`exec -a worker /bin/sh -c 'rm -rf /'`,
		`env bash -c 'rm -rf /'`,
		`env -i MODE=test /bin/bash -c 'rm -rf /'`,
	]) {
		assert.match(
			deterministicHardDeny("bash", { command }, process.cwd()) ?? "",
			/irreversible deletion/,
			command,
		);
	}
});

test("AST hard-deny checks inspect commands behind transparent dispatch wrappers", () => {
	for (const command of [
		"command rm -rf /",
		"command -p /bin/rm -rf /",
		"exec rm -rf /",
		"exec -a worker /bin/rm -rf /",
		"env rm -rf /",
		"env -- MODE=test rm -rf /",
		"env 1=x rm -rf /",
		"env -i MODE=test /bin/rm -rf /",
		"env MODE=test command rm -rf /",
	]) {
		assert.match(
			deterministicHardDeny("bash", { command }, process.cwd()) ?? "",
			/irreversible deletion/,
			command,
		);
	}
});

test("AST hard-deny parses rm options and operands around the option delimiter", () => {
	const cwd = mkdtempSync(join(os.tmpdir(), "pi-automode-rm-options-"));
	try {
		symlinkSync("/", join(cwd, "-root"));
		assert.match(
			deterministicHardDeny(
				"bash",
				{ command: "rm -rf -- -root/etc" },
				cwd,
			) ?? "",
			/irreversible deletion/,
		);
		assert.equal(
			deterministicHardDeny(
				"bash",
				{ command: "rm -- --recursive /" },
				cwd,
			),
			undefined,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("AST hard-deny checks normalize absolute executable paths", () => {
	assert.match(
		deterministicHardDeny("bash", { command: "/bin/rm -rf /" }, process.cwd()) ?? "",
		/irreversible deletion/,
	);
	assert.match(
		deterministicHardDeny(
			"bash",
			{ command: "/usr/bin/git config --global http.sslVerify false" },
			process.cwd(),
		) ?? "",
		/TLS/,
	);
});

test("AST hard-deny checks protect recursive rm variants and system roots", () => {
	for (const command of [
		"rm -Rf /",
		"rm --recurs /",
		"rm -rf ~",
		"rm -rf /home",
		"rm -rf /proc",
		"rm -rf /root",
		"rm -rf /run",
		"rm -rf /System",
		"rm -rf /Library",
		"rm -rf /Users",
		"rm -rf /Users/another-user",
		"rm -rf ~root",
		`rm -rf ~root/"child"`,
	]) {
		assert.match(
			deterministicHardDeny("bash", { command }, process.cwd()) ?? "",
			/irreversible deletion/,
			command,
		);
	}
});

test("AST hard-deny checks exempt OS temp-directory subtrees", () => {
	// Reported false positive: `rm -rf /tmp/<dir>` hard-denied on macOS because
	// /tmp is a symlink to /private/tmp and /private matched as a system root.
	assert.equal(
		deterministicHardDeny(
			"bash",
			{ command: "rm -rf /tmp/automode-allow-test" },
			process.cwd(),
		),
		undefined,
	);

	// Deleting a temp directory created with mktemp/mkdtemp is routine cleanup.
	// Prefix avoids the separate "pi-automode" substring safety-control deny so
	// this test exercises only the temp-root logic.
	const created = mkdtempSync(join(os.tmpdir(), "automode-temp-subtree-"));
	try {
		assert.equal(
			deterministicHardDeny(
				"bash",
				{ command: `rm -rf ${created}` },
				process.cwd(),
			),
			undefined,
		);
	} finally {
		rmSync(created, { recursive: true, force: true });
	}

	// Compound form from the field report stays allowed end to end.
	assert.equal(
		deterministicHardDeny(
			"bash",
			{ command: "rm -rf /tmp/foolfighter-debug && mkdir /tmp/foolfighter-debug && docker cp c:/data/x.db /tmp/foolfighter-debug/x.db" },
			process.cwd(),
		),
		undefined,
	);
});

test(
	"AST hard-deny checks keep the OS temp roots themselves protected",
	{ skip: process.platform !== "darwin" },
	() => {
		for (const command of [
			"rm -rf /tmp",
			"rm -rf /private/tmp",
			"rm -rf /var/folders",
			"rm -rf /private/var/folders",
		]) {
			assert.match(
				deterministicHardDeny("bash", { command }, process.cwd()) ?? "",
				/irreversible deletion/,
				command,
			);
		}
	},
);

test("AST hard-deny checks leave literal tildes and application roots to review", () => {
	for (const command of [
		`rm -rf "~"`,
		"rm -rf \\~",
		`rm -rf ~"root"`,
		"rm -- /",
		"rm -rf /opt/app",
		"rm -rf /srv/app",
		"git push",
	]) {
		assert.equal(
			deterministicHardDeny("bash", { command }, process.cwd()),
			undefined,
			command,
		);
	}
});

test(
	"AST hard-deny checks canonicalize case aliases on case-insensitive macOS volumes",
	{ skip: process.platform !== "darwin" || !existsSync("/system") },
	() => {
		const commands = ["rm -rf /system", "rm -rf /library"];
		const lowerHome = os.homedir().toLowerCase();
		if (lowerHome !== os.homedir() && existsSync(lowerHome)) {
			commands.push(`rm -rf ${lowerHome}`);
		}
		for (const command of commands) {
			assert.match(
				deterministicHardDeny("bash", { command }, process.cwd()) ?? "",
				/irreversible deletion/,
				command,
			);
		}
	},
);

test("AST hard-deny checks fail closed on malformed Bash input", () => {
	assert.match(
		deterministicHardDeny("bash", { command: 'echo "unterminated' }, process.cwd()) ?? "",
		/could not be parsed safely/,
	);
});

test("AST hard-deny checks do not execute or inspect quoted command text", () => {
	for (const command of [
		`echo 'git config --global http.sslVerify false'`,
		`printf '%s' 'rm -rf /'`,
		"git push origin main",
	]) {
		assert.equal(
			deterministicHardDeny("bash", { command }, process.cwd()),
			undefined,
			command,
		);
	}
});

test("isRootHomeOrSystemPath exempts home subtree but keeps home root and system paths", () => {
	// Silverblue-style HOME under /var: the case PR #7 fixed. With a real
	// os.homedir() this subtree used to match `path.startsWith("/var/")` and
	// hard-deny routine `rm -rf ~/...`.
	const home = "/var/home/jdoe";
	const cases: Array<[string, boolean]> = [
		[home, true], // rm -rf ~ stays blocked
		[`${home}/projects/foo/build`, false], // the bug: was true before the fix
		["/var", true], // /var itself stays protected
		["/var/log", true], // sibling system path under /var stays protected
		["/var/lib/pkg", true],
		["/etc", true],
		["/usr/share/x", true],
		["/", true],
		["/opt/app", false], // not a tracked system root
	];
	for (const [path, expected] of cases) {
		assert.equal(isRootHomeOrSystemPath(path, home), expected, `path=${path}`);
	}

	// Standard HOME (/home/user): system roots still protected, subtree exempt.
	const stdHome = "/home/jdoe";
	assert.equal(isRootHomeOrSystemPath(stdHome, stdHome), true);
	assert.equal(isRootHomeOrSystemPath(`${stdHome}/src/pkg`, stdHome), false);
	assert.equal(isRootHomeOrSystemPath("/home", stdHome), true);
	assert.equal(isRootHomeOrSystemPath("/home/other-user", stdHome), true);
	assert.equal(isRootHomeOrSystemPath("/proc/1", stdHome), true);
	assert.equal(isRootHomeOrSystemPath("/root/.ssh", stdHome), true);
	assert.equal(isRootHomeOrSystemPath("/run/service", stdHome), true);
	assert.equal(isRootHomeOrSystemPath("/System/Library", stdHome), true);
	assert.equal(isRootHomeOrSystemPath("/Library/LaunchDaemons", stdHome), true);
	assert.equal(isRootHomeOrSystemPath("/Users", stdHome), true);
	assert.equal(isRootHomeOrSystemPath("/Users/another-user", stdHome), true);
	assert.equal(isRootHomeOrSystemPath("/etc/hosts", stdHome), true);
	assert.equal(isRootHomeOrSystemPath("/opt/app", stdHome), false);
	assert.equal(isRootHomeOrSystemPath("/srv/app", stdHome), false);
});

test("isRootHomeOrSystemPath exempts temp subtrees but keeps temp roots", () => {
	// Injectable candidates keep this platform-independent: callers pass
	// symlink-resolved policy paths (`/tmp` → `/private/tmp` on macOS) and
	// unresolved fallbacks alike, so both spellings must be listed.
	const home = "/home/jdoe";
	const temps = ["/tmp", "/private/tmp", "/var/folders/gn/T"];
	assert.equal(isRootHomeOrSystemPath("/tmp/project/sub", home, temps), false);
	assert.equal(
		isRootHomeOrSystemPath("/private/tmp/session", home, temps),
		false,
	);
	assert.equal(isRootHomeOrSystemPath("/var/folders/gn/T/x", home, temps), false);
	assert.equal(isRootHomeOrSystemPath("/tmp", home, temps), true); // root itself stays blocked
	assert.equal(isRootHomeOrSystemPath("/private/tmp", home, temps), true);
	assert.equal(isRootHomeOrSystemPath("/var/folders/gn/T", home, temps), true);
	assert.equal(isRootHomeOrSystemPath("/usr/local/lib", home, temps), true);
	assert.equal(isRootHomeOrSystemPath("/etc/hosts", home, temps), true);
});

test("isRootHomeOrSystemPath keeps exact protections ahead of temp candidates", () => {
	// Injected candidates must never defeat exact protections: the Silverblue
	// home root, `/`, system subtrees, and broader declared values all stay
	// protected no matter what callers pass as tempRoots.
	const home = "/var/home/jdoe";
	assert.equal(isRootHomeOrSystemPath(home, home, ["/var"]), true);
	assert.equal(isRootHomeOrSystemPath("/etc/nginx", "/Users/x", [""]), true);
	assert.equal(isRootHomeOrSystemPath("/", "/Users/x", [""]), true);
	assert.equal(
		isRootHomeOrSystemPath("/private/etc/ssl", "/Users/x", ["/private"]),
		true,
	);
	assert.equal(isRootHomeOrSystemPath("/usr/share/doc", "/Users/x", ["/usr"]), true);
});

test("tempRootCandidates rejects malformed, protected, and home-ancestor declarations", async () => {
	const previousTmpdir = process.env.TMPDIR;
	const setTmpdir = (value: string | undefined) => {
		if (value === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = value;
	};
	try {
		// Distinct query strings give each check a pristine module instance, so
		// earlier suite calls cannot mask these through memoization.
		setTmpdir("/");
		const slashModule = await import(
			`../extensions/auto-mode/hard-deny.ts?tmp-root-slash`
		);
		assert.ok(
			!slashModule.tempRootCandidates().includes(""),
			slashModule.tempRootCandidates().join(","),
		);

		setTmpdir("/private");
		const privateModule = await import(
			`../extensions/auto-mode/hard-deny.ts?tmp-root-private`
		);
		assert.ok(
			!privateModule.tempRootCandidates().includes("/private"),
			privateModule.tempRootCandidates().join(","),
		);

		setTmpdir("/etc/cache");
		const cacheModule = await import(
			`../extensions/auto-mode/hard-deny.ts?tmp-root-cache`
		);
		const cacheRoots = [...cacheModule.tempRootCandidates()];
		assert.ok(cacheRoots.some((root) => root.endsWith("/etc/cache")));

		setTmpdir("/var");
		const varModule = await import(
			`../extensions/auto-mode/hard-deny.ts?tmp-root-var`
		);
		const varRoots = [...varModule.tempRootCandidates()];
		assert.ok(!varRoots.includes("/var"), varRoots.join(","));
		if (process.platform === "darwin") {
			assert.ok(!varRoots.includes("/private/var"), varRoots.join(","));
		}

		setTmpdir(join(os.homedir(), ".."));
		const ancestorModule = await import(
			`../extensions/auto-mode/hard-deny.ts?tmp-root-ancestor`
		);
		assert.ok(
			!ancestorModule.tempRootCandidates().includes(resolve(os.homedir(), "..")),
			ancestorModule.tempRootCandidates().join(","),
		);
	} finally {
		setTmpdir(previousTmpdir);
	}
});

test("tempRootCandidates recomputes when the effective tmpdir changes", () => {
	const previousTmpdir = process.env.TMPDIR;
	try {
		process.env.TMPDIR = "/etc/cache-first";
		const first = tempRootCandidates();
		process.env.TMPDIR = "/etc/cache-second";
		const second = tempRootCandidates();
		assert.ok(first.some((root) => root.endsWith("/cache-first")), first.join(","));
		assert.ok(second.some((root) => root.endsWith("/cache-second")));
		assert.ok(!second.some((root) => root.endsWith("/cache-first")));
	} finally {
		if (previousTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpdir;
	}
});

test("AST hard-deny applies temp policy to find -delete roots", () => {
	assert.equal(
		deterministicHardDeny(
			"bash",
			{ command: "find /tmp/automode-find-subtree -delete" },
			process.cwd(),
		),
		undefined,
	);
	assert.match(
		deterministicHardDeny("bash", { command: "find /tmp -delete" }, process.cwd()) ?? "",
		/system-wide delete/,
	);
});

test("AST hard-deny checks find global options before system-wide delete roots", () => {
	for (const command of [
		"find -H /etc -delete",
		"find -L /etc -delete",
		"find -H -L /etc -delete",
		"find -P /Users -delete",
	]) {
		assert.match(
			deterministicHardDeny("bash", { command }, process.cwd()) ?? "",
			/system-wide delete/,
			command,
		);
	}
	assert.equal(
		deterministicHardDeny(
			"bash",
			{ command: "find -H /tmp/automode-find-subtree -delete" },
			process.cwd(),
		),
		undefined,
	);
});
