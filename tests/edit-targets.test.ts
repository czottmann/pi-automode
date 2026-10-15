import assert from "node:assert/strict";
import test from "node:test";
import { extractEditPaths } from "../extensions/auto-mode/edit-targets.ts";

function assertRejected(input: Record<string, unknown>, format: "pi" | "omp" = "omp"): void {
	const result = extractEditPaths(input);
	assert.equal(result.format, format);
	assert.equal(typeof result.error, "string", JSON.stringify(input));
	assert.ok(result.error);
	assert.deepEqual(result.paths, [], "Failures must never expose a partial target set");
}


test("Pi edits reject missing, empty, non-string, control and opaque paths", () => {
	for (const path of [undefined, null, 4, {}, [], "", " \t ", "src/\u0000app.ts", "src/\napp.ts", "agent://session", "https://example.com/a", "xd:edit"]) {
		assertRejected({ path, oldText: "old", newText: "new" }, "pi");
	}
	assertRejected({}, "pi");
	assertRejected({ path: "src/app.ts", oldText: 42, newText: "new" }, "pi");
});

test("hashline edits return every source and move destination, ignoring compatibility path", () => {
	const input = "*** Begin Patch\n[src/a.ts#ABCD]\nPUT 1.=1:\n+new\nMV src/b.ts\n[src/c.ts#1234]\nCUT 1*\nMV src/d.ts\n*** End Patch\n";
	assert.deepEqual(extractEditPaths({ input, path: "safe-decoy.ts" }), {
		paths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], format: "omp",
	});
	assert.deepEqual(extractEditPaths({ input, path: null }), {
		paths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], format: "omp",
	});
});

test("wrapperless hashline edits support moves, removal and stable unique targets", () => {
	assert.deepEqual(extractEditPaths({ input: "[a#A1B2]\nMV b\n[b#B2C3]\nREM\n" }), {
		paths: ["a", "b"], format: "omp",
	});
	assert.deepEqual(extractEditPaths({ input: "*** Begin Patch\n[a#ABCD]\nREM\n*** End Patch" }), {
		paths: ["a"], format: "omp",
	});
});

test("all hashline locator and register grammar productions are consumed", () => {
	const input = [
		"[a#ABCD]",
		"PUT 1.=2:", "+range",
		"PUT 3*:", "+block",
		"PUT <4:", "+before",
		"PUT >5:", "+after",
		"PUT >6*:", "+sibling",
		"PUT >$:", "+end", "+",
		"CUT 1.=2 @name_1-A", "CUT 3*", "CUT 4* @saved",
		"PUT 1.=2 @name_1-A", "PUT 3* @saved",
		"PUT <4 @saved", "PUT >5 @saved", "PUT >6* @saved", "PUT >$ @saved",
		"PUT <4", "PUT >5", "PUT >6*", "PUT >$",
		"MV b", "",
	].join("\n");
	assert.deepEqual(extractEditPaths({ input }), { paths: ["a", "b"], format: "omp" });
});

test("body rows that look like headers, operations and wrappers never add targets", () => {
	const input = "*** Begin Patch\n[real.ts#ABCD]\nPUT 1.=1:\n+[.pi/agent/settings.json#FFFF]\n+MV hidden.ts\n+*** End Patch\n+CUT 2* @register\n++literal plus\n*** End Patch\n";
	assert.deepEqual(extractEditPaths({ input }), { paths: ["real.ts"], format: "omp" });
	assertRejected({ input: "[real.ts#ABCD]\n+[spoof.ts#FFFF]\n" });
	assertRejected({ input: "[real.ts#ABCD]\nREM\n+[spoof.ts#FFFF]\n" });
});

test("quoted hashline paths strip only native outer quotes, preserving spaces and escapes", () => {
	for (const quote of ['"', "'"]) {
		assert.deepEqual(extractEditPaths({ input: `[${quote}src/old file.ts${quote}#ABCD]\nMV ${quote}src/new file.ts${quote}\n` }), {
			paths: ["src/old file.ts", "src/new file.ts"], format: "omp",
		});
	}
	assert.deepEqual(extractEditPaths({ input: '["src/old\\\"name.ts"#ABCD]\nMV "src/new\\\"name.ts"\n' }), {
		paths: ['src/old\\"name.ts', 'src/new\\"name.ts'], format: "omp",
	});
	assert.deepEqual(extractEditPaths({ input: "[  src/old file.ts  #ABCD]\nMV src/new file.ts\n" }), {
		paths: ["src/old file.ts", "src/new file.ts"], format: "omp",
	});
});

test("malformed or partial hashline payloads produce no partial success", () => {
	for (const input of [
		"", "*** Begin Patch\n*** End Patch\n", "[a#ABCD]\n", "[a#ABCD]\n[b#1234]\nREM\n",
		"[a#abcd]\nREM\n", "[a#ABCDE]\nREM\n", "[a#ABC]\nREM\n", "[a#ABCG]\nREM\n",
		"[a#ABCD]\nPUT 1.=1:\n", "[a#ABCD]\nPUT 1.=1:\n[b#FFFF]\nREM\n",
		"[a#ABCD]\nREM\ntrailing\n", "[a#ABCD]\nREM\n[b#FFFF]\nUNKNOWN\n",
		"[a#ABCD]\nREM\n[b#FFFF]\n", "[a#ABCD]\nREM", "[a#ABCD]\r\nREM\r\n",
		"*** Begin Patch\n[a#ABCD]\nREM\n", "*** Begin Patch\n[a#ABCD]\nREM\n*** End Patch\ntrailing\n",
		"[a#ABCD]\nREM\n*** End Patch\n", "*** Begin Patch\n[a#ABCD]\nREM\n*** End Patch\n[b#FFFF]\nREM\n",
		"[a#ABCD]\nMV \n", '[a#ABCD]\nMV "unterminated\n', '[a#ABCD]\nMV "dest" trailing\n',
		'[a#ABCD]\nMV "dest"quote"\n', '["unterminated#ABCD]\nREM\n', '[a#ABCD]\nMV b#FFFF\n',
	]) assertRejected({ input, path: "safe-decoy.ts" });
});

test("invalid registers and hunk locators are not accepted as path-only edits", () => {
	for (const hunk of [
		"CUT >1", "CUT 0*=0", "CUT 01*", "CUT 1* @", "CUT 1* @bad.name", "CUT 1* @a @b",
		"CUT 1*:", "CUT 1.=1@name", "PUT 1.=1", "PUT 1*", "PUT <0", "PUT >1**",
		"PUT >$ @bad/name", "PUT >1 @name:", "PUT 1.=1 @name extra", "PUT >1  @name",
	]) assertRejected({ input: `[a#ABCD]\n${hunk}\n`, path: "safe.ts" });
	assertRejected({ input: "[a#ABCD]\nPUT >1 @name\n+not-a-register-body\n" });
});

test("OMP payloads reject opaque targets in every target position", () => {
	for (const path of ["https://example.com/file", "file:///tmp/file", "agent://session", "xd:edit", "local:/file", "src/\u0000file", "src/\u007ffile"]) {
		assertRejected({ input: `[${path}#ABCD]\nREM\n`, path: "safe.ts" });
		assertRejected({ input: `[safe.ts#ABCD]\nMV ${path}\n` });
		assertRejected({ path, old_string: "old", new_string: "new" });
		assertRejected({ path: "safe.ts", edits: [{ rename: path }] });
	}
	assertRejected({ input: '["agent://session"#ABCD]\nREM\n' });
	assertRejected({ input: '[safe.ts#ABCD]\nMV "xd://edit"\n' });
});

test("Windows drive paths are filesystem targets, not opaque URL schemes", () => {
	assert.deepEqual(extractEditPaths({ input: "[C:\\src\\old.ts#ABCD]\nMV D:\\src\\new.ts\n" }), {
		paths: ["C:\\src\\old.ts", "D:\\src\\new.ts"], format: "omp",
	});
	assert.deepEqual(extractEditPaths({ path: "C:\\src\\old.ts", oldText: "old", newText: "new" }), {
		paths: ["C:\\src\\old.ts"], format: "pi",
	});
});

test("native filename recovery is explicitly rejected rather than authorizing a decoy", () => {
	for (const path of ["***.pi/agent/settings.json", "Update File:.pi/agent/settings.json", '"  .pi/agent/settings.json"']) {
		assertRejected({ input: `[${path}#ABCD]\nREM\n` });
		assertRejected({ input: `[safe.ts#ABCD]\nMV ${path}\n` });
	}
	for (const path of ["\"'agent://session'\"", '"./dest.ts "']) {
		assertRejected({ input: `[safe.ts#ABCD]\nMV ${path}\n` });
	}
});

test("native structured patch entries include every rename destination", () => {
	assert.deepEqual(extractEditPaths({ path: "src/a.ts", edits: [
		{ op: "update", diff: "+[spoof.ts#ABCD]\n+MV hidden.ts\n", rename: "src/b.ts" },
		{ op: "create", diff: "body", rename: "src/c.ts" },
		{ op: "delete" },
	] }), { paths: ["src/a.ts", "src/b.ts", "src/c.ts"], format: "omp" });
	assert.deepEqual(extractEditPaths({ path: "src/a.ts", edits: [{ rename: '"literal quotes.ts"' }] }), {
		paths: ["src/a.ts", '"literal quotes.ts"'], format: "omp",
	});
});

test("native structured replacement and internal replacement batches are supported", () => {
	assert.deepEqual(extractEditPaths({ path: "src/a.ts", old_string: "old", new_string: "new", replace_all: true }), {
		paths: ["src/a.ts"], format: "omp",
	});
	assert.deepEqual(extractEditPaths({ path: "src/a.ts", edits: [
		{ old_string: "old", new_string: "new" }, { old_string: "other", new_string: "", replace_all: false },
	] }), { paths: ["src/a.ts"], format: "omp" });
});

test("malformed structured schemas reject the whole target set", () => {
	for (const input of [
		{ path: "safe.ts", edits: null }, { path: "safe.ts", edits: "opaque" },
		{ path: "safe.ts", edits: [{ rename: "b" }, { rename: 3 }] },
		{ path: "safe.ts", edits: [{ rename: "b" }, { path: "hidden.ts" }] },
		{ path: "safe.ts", edits: [{ diff: 3 }] }, { path: "safe.ts", edits: [{ op: "move" }] },
		{ path: "safe.ts", edits: [null] }, { path: "safe.ts", edits: [[]] },
		{ path: "safe.ts", edits: [{ old_string: "old" }] },
		{ path: "safe.ts", edits: [{ old_string: "old", new_string: "new", rename: "b" }] },
		{ path: "safe.ts", edits: [{ old_string: "old", new_string: "new" }, { rename: "b" }] },
		{ path: "safe.ts", old_string: "old", new_string: 3 },
		{ path: "safe.ts", old_string: "old", new_string: "new", replace_all: "yes" },
		{ edits: [{ rename: "b" }] }, { path: 3, old_string: "old", new_string: "new" },
	]) assertRejected(input);
});

test("opaque and unsupported payload fields cannot fall back to a supplied path", () => {
	for (const input of [
		{ path: "safe.ts", input: undefined }, { path: "safe.ts", input: null },
		{ path: "safe.ts", input: {} }, { path: "safe.ts", input: "not a patch" },
		{ path: "safe.ts", input: "*** Begin Patch\n*** Update File: hidden.ts\n@@\n-old\n+new\n*** End Patch\n" },
		{ path: "safe.ts", patch: "opaque" }, { path: "safe.ts", files: [{ path: "hidden.ts" }] },
		{ path: "safe.ts", operations: [{ rename: "hidden.ts" }] },
		{ path: "safe.ts", input: "[a#ABCD]\nREM\n", edits: [{ rename: "hidden.ts" }] },
		{ path: "safe.ts", edits: [{ rename: "hidden.ts" }], oldText: "old", newText: "new" },
	]) assertRejected(input);
});
