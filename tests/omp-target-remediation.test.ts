import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deterministicHardDeny, extractToolPaths, resolvePathForPolicy } from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, setupHookTest } from "./test-helpers.ts";

function fixture(t: test.TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "automode-target-remediation-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function denied(t: test.TestContext, root: string, toolName: string, input: Record<string, unknown>, target: string) {
  const ctx = createFakeCtx([], { cwd: root });
  const h = await setupHookTest({ ctx, config: baseConfig({ allowInsideWorkingDirectory: true, deniedPaths: [target] }) });
  const result = await h.emit("tool_call", { toolName, input }, ctx) as { block?: boolean } | undefined;
  assert.equal(result?.block, true);
  assert.equal(h.classifierCalls, 0);
}

test("OMP remediation literal-colon hashline targets retain their filename", async (t) => {
  const root = fixture(t);
  const target = join(root, ":shield.txt");
  writeFileSync(target, "before\n");
  const input = "*** Begin Patch\n[:shield.txt#ABCD]\nPUT 1.=1:\n+after\n*** End Patch\n";
  assert.deepEqual(extractToolPaths("edit", { input, path: ":shield.txt", paths: [":shield.txt"] }, root).paths, [target]);
  await denied(t, root, "edit", { input, path: ":shield.txt", paths: [":shield.txt"] }, target);
});

test("OMP remediation bracket-wrapped writes deny the native destination", async (t) => {
  const root = fixture(t);
  const target = join(root, "protected.txt");
  writeFileSync(target, "before\n");
  for (const path of [`[${target}#ABCD]`, `[${target}]`, `[${target}#ABCD]   `]) {
    await denied(t, root, "write", { path, content: "after" }, target);
  }
  assert.equal(deterministicHardDeny("write", { path: `[${join(root, ".omp/settings.json")}#ABCD]` }, root)?.includes("safety-control"), true);
});

test("OMP remediation absolute symlink parent traversal preserves filesystem order", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX symlink traversal fixture");
  const root = fixture(t);
  mkdirSync(join(root, "work"));
  mkdirSync(join(root, "outside/child"), { recursive: true });
  symlinkSync(join(root, "outside/child"), join(root, "work/link"));
  const target = join(root, "outside/protected.txt");
  writeFileSync(target, "before\n");
  const raw = join(root, "work") + "/link/../protected.txt";
  assert.equal(resolvePathForPolicy(raw), target);
  await denied(t, join(root, "work"), "write", { path: raw, content: "after" }, target);
  assert.equal(resolvePathForPolicy(join(root, "work") + "/link/../new.txt"), join(root, "outside/new.txt"));
});

test("OMP remediation delimited reads deny every effective sibling", async (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "safe.txt"), "safe\n");
  const target = join(root, "protected.txt");
  writeFileSync(target, "secret\n");
  for (const path of ["safe.txt;protected.txt", "safe.txt, protected.txt", "safe.txt protected.txt"]) {
    await denied(t, root, "read", { path }, target);
  }
  await denied(t, root, "read", { paths: ["safe.txt", "protected.txt"] }, target);
});

test("OMP remediation read delimiter literal filenames take precedence", (t) => {
  const root = fixture(t);
  const target = join(root, "safe.txt;protected.txt");
  writeFileSync(target, "literal\n");
  assert.deepEqual(extractToolPaths("read", { path: "safe.txt;protected.txt" }, root).paths, [target]);
});

test("OMP remediation configurable and canonical agent-root aliases stay hard denied", (t) => {
  const root = fixture(t);
  const saved = { PI_CONFIG_DIR: process.env.PI_CONFIG_DIR, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  delete process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CONFIG_DIR = join(root, ".custom-omp");
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const custom = join(root, ".custom-omp/agent/settings.json");
  assert.match(deterministicHardDeny("write", { path: custom }, root) ?? "", /safety-control/);
  mkdirSync(join(root, "relocated/agent"), { recursive: true });
  symlinkSync(join(root, "relocated/agent"), join(root, "agent-alias"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent-alias");
  assert.match(deterministicHardDeny("write", { path: join(root, "relocated/agent/settings.json") }, root) ?? "", /safety-control/);
  mkdirSync(join(root, "project-relocated"));
  const project = join(root, "project");
  mkdirSync(project);
  symlinkSync(join(root, "project-relocated"), join(project, ".omp"));
  assert.match(deterministicHardDeny("write", { path: join(root, "project-relocated/settings.json") }, project) ?? "", /safety-control/);
});

test("OMP remediation unresolved native reads cannot use bare allow or read-only tiers", async (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "nested/secret.txt"), "secret\n");
  writeFileSync(join(root, "safe.txt"), "safe\n");
  const ctx = createFakeCtx([], { cwd: root });
  const h = await setupHookTest({ ctx, config: baseConfig({
    allowInsideWorkingDirectory: true, permissionAllow: ["read"],
  }) });
  Object.assign(h.pi, { pi: { createAgentSession() {} } });
  for (const path of ["secret.txt", "*.txt", "safe.txt;missing.txt", "safe.txt? q=secret", "safe.txt:unknown"]) {
    const result = await h.emit("tool_call", { toolName: "read", input: { path } }, ctx) as { block?: boolean };
    assert.equal(result.block, true);
  }
  assert.equal(await h.emit("tool_call", { toolName: "read", input: { path: "safe.txt:1:raw" } }, ctx), undefined);
  assert.equal(h.classifierCalls, 0);
});

test("OMP remediation strict reads preserve selector and delimiter literal precedence", (t) => {
  const root = fixture(t);
  for (const path of ["safe.txt", "safe.txt:1", "a;b", ":literal"]) writeFileSync(join(root, path), "data\n");
  for (const path of ["safe.txt:1", "a;b", ":literal"]) {
    assert.deepEqual(extractToolPaths("read", { path }, root, { nativeRead: true }).paths, [join(root, path)]);
  }
  assert.deepEqual(extractToolPaths("read", { path: "safe.txt:2:raw" }, root, { nativeRead: true }).paths, [join(root, "safe.txt")]);
});

test("OMP remediation canonical project-control aliases deny direct targets", (t) => {
  if (process.platform === "win32") return t.skip("POSIX symlink fixture");
  const root = fixture(t);
  mkdirSync(join(root, "project"));
  mkdirSync(join(root, "controls"));
  symlinkSync(join(root, "controls"), join(root, "project/.omp"));
  const target = join(root, "controls/settings.json");
  writeFileSync(target, "controls\n");
  assert.notEqual(deterministicHardDeny("write", { path: target }, join(root, "project")), undefined);
});

test("OMP remediation canonical default-root aliases deny direct targets", (t) => {
  if (process.platform === "win32") return t.skip("POSIX symlink fixture");
  const root = fixture(t);
  mkdirSync(join(root, "controls/agent"), { recursive: true });
  symlinkSync(join(root, "controls"), join(root, ".omp"));
  const target = join(root, "controls/agent/settings.json");
  writeFileSync(target, "controls\n");
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: root, PI_CONFIG_DIR: ".omp" };
  delete environment.PI_CODING_AGENT_DIR;
  const moduleUrl = new URL("../extensions/auto-mode.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { deterministicHardDeny } from ${JSON.stringify(moduleUrl)};
    if (!deterministicHardDeny("write", { path: ${JSON.stringify(target)} }, ${JSON.stringify(root)})) process.exit(1);
  `], { env: environment, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

