import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { analyzeBash, deterministicHardDeny } from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, setupHookTest, type ToolCallHarness } from "./test-helpers.ts";

function fixture(t: test.TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "automode-session-root-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// Actual native source trace:
// sdk.ts passes options.settings (or Settings.init({agentDir})) to ExtensionRunner.
// runner.ts #runHandlerWithTimeout uses withActiveSettings(this.settings).
// legacy-pi-coding-agent-shim.ts SettingsManager.create -> findScopedSettings
// takes that AsyncLocalStorage instance; Settings.getAgentDir/getCwd expose its
// actual root/scope. Native loader remaps the package import to that plain-object
// shim. The upstream Pi class used by this suite MUST NOT be called by native hooks.
// Successful actual-SDK binding must be exercised by the loader-backed native smoke,
// not by a fabricated context field or a production test-only option.

async function harness(root: string) {
  const ctx = createFakeCtx([], { cwd: root, hasUI: false });
  const h = await setupHookTest({ ctx, config: baseConfig({
    allowInsideWorkingDirectory: true,
    permissionAllow: ["write", "edit", "bash", "read"],
  }) });
  return { h, ctx };
}

async function blocked(h: ToolCallHarness, ctx: unknown, toolName: string, input: Record<string, unknown>) {
  const result = await h.emit("tool_call", { toolName, input }, ctx) as { block?: boolean; reason?: string } | undefined;
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /safety-control/);
}

test("explicit session roots protect native controls despite different environment roots", (t) => {
  const root = fixture(t);
  const sessionRoot = join(root, "actual-session");
  const environmentRoot = join(root, "process-environment");
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = environmentRoot;
  t.after(() => { if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved; });
  for (const dir of [sessionRoot, environmentRoot]) mkdirSync(dir);
  for (const dir of [sessionRoot, environmentRoot]) {
    for (const name of ["config.yml", "config.yaml", "settings.json", "extensions/guard.ts", "settings/approval.yml"]) {
      const path = join(dir, name);
      assert.match(deterministicHardDeny("write", { path }, root, undefined, sessionRoot) ?? "", /safety-control/);
    }
    const path = join(dir, "config.yml");
    writeFileSync(path, "original\n");
    assert.match(deterministicHardDeny("edit", { path, oldText: "original", newText: "replacement" }, root, undefined, sessionRoot) ?? "", /safety-control/);
    const patch = `*** Begin Patch\n[${path}#ABCD]\nPUT 1.=1:\n+replacement\n*** End Patch\n`;
    assert.match(deterministicHardDeny("edit", { input: patch }, root, undefined, sessionRoot) ?? "", /safety-control/);
    const command = `printf replacement > '${path}'`;
    assert.match(deterministicHardDeny("bash", { command }, root, analyzeBash(command), sessionRoot) ?? "", /safety-control/);
  }
  assert.equal(deterministicHardDeny("write", { path: join(sessionRoot, "notes.txt") }, root, undefined, sessionRoot), undefined);
  assert.equal(deterministicHardDeny("read", { path: join(sessionRoot, "config.yml") }, root, undefined, sessionRoot), undefined);
});

test("explicit session root policy does not confuse same-cwd sibling roots", (t) => {
  const root = fixture(t);
  for (const selected of ["first", "second"]) {
    const sessionRoot = join(root, selected);
    const other = selected === "first" ? "second" : "first";
    assert.match(deterministicHardDeny("write", { path: join(sessionRoot, "config.yml") }, root, undefined, sessionRoot) ?? "", /safety-control/);
    assert.equal(deterministicHardDeny("write", { path: join(root, other, "config.yml") }, root, undefined, sessionRoot), undefined);
  }
});

test("explicit session roots protect physical aliases", (t) => {
  if (process.platform === "win32") return t.skip("POSIX symlink fixture");
  const root = fixture(t);
  const selected = join(root, "physical");
  mkdirSync(selected);
  symlinkSync(selected, join(root, "alias"));
  const path = join(selected, "config.yml");
  assert.match(deterministicHardDeny("write", { path }, root, undefined, join(root, "alias")) ?? "", /safety-control/);
  const command = `printf replacement > '${path}'`;
  assert.match(deterministicHardDeny("bash", { command }, root, analyzeBash(command), join(root, "alias")) ?? "", /safety-control/);
});

test("native mutations reject unavailable scoped metadata before invoking the Pi factory", async (t) => {
  const root = fixture(t);
  const create = t.mock.method(SettingsManager, "create", () => { throw new Error("must not construct Pi settings"); });
  const { h, ctx } = await harness(root);
  Object.assign(h.pi, { pi: {
    createAgentSession() {}, getAgentDir: () => join(root, "global"),
    Settings: class {}, settings: { getAgentDir: () => join(root, "unrelated-global") },
  } });
  await blocked(h, ctx, "write", { path: join(root, "actual/config.yml"), content: "replacement" });
  await blocked(h, ctx, "edit", { path: "safe.txt", oldText: "x", newText: "y" });
  await blocked(h, ctx, "bash", { command: "rm -rf actual" });
  writeFileSync(join(root, "readable.txt"), "safe\n");
  assert.equal(await h.emit("tool_call", { toolName: "read", input: { path: "readable.txt" } }, ctx), undefined);
  assert.equal(create.mock.callCount(), 0);
  assert.equal(h.classifierCalls, 0);
});

test("native root provenance cannot be supplied by transcript, model, or tool input", async (t) => {
  const root = fixture(t);
  const { h, ctx } = await harness(root);
  Object.assign(h.pi, { pi: { createAgentSession() {}, getAgentDir: () => join(root, "global"), Settings: class {} } });
  Object.assign(ctx, { model: { agentDir: join(root, "fake") }, settings: { getAgentDir: () => join(root, "fake") } });
  h.entries.push({ type: "custom", customType: "settings", data: { agentDir: join(root, "fake") } });
  await blocked(h, ctx, "write", {
    path: join(root, "actual/config.yml"), content: "replacement",
    agentDir: join(root, "fake"), settings: { agentDir: join(root, "fake") },
  });
  assert.equal(h.classifierCalls, 0);
});

test("throwing and invalid native global getters fail closed without consulting Pi settings", async (t) => {
  const root = fixture(t);
  const create = t.mock.method(SettingsManager, "create", () => { throw new Error("must not construct Pi settings"); });
  const { h, ctx } = await harness(root);
  for (const value of ["", "relative/root", join(root, "bad") + "\0", 7, undefined]) {
    let calls = 0;
    Object.assign(h.pi, { pi: { createAgentSession() {}, Settings: class {}, getAgentDir() { calls += 1; return value; } } });
    await blocked(h, ctx, "write", { path: join(root, "actual/config.yml"), content: "replacement" });
    assert.equal(calls, 1);
  }
  let calls = 0;
  Object.assign(h.pi, { pi: { createAgentSession() {}, Settings: class {}, getAgentDir() { calls += 1; throw new Error("unavailable"); } } });
  await blocked(h, ctx, "bash", { command: "rm -rf actual" });
  assert.equal(calls, 1);
  assert.equal(create.mock.callCount(), 0);
  assert.equal(h.classifierCalls, 0);
});

test("normal Pi neither consults native metadata nor blanket-blocks ordinary config filenames", async (t) => {
  const root = fixture(t);
  const create = t.mock.method(SettingsManager, "create", () => { throw new Error("must not consult Pi settings"); });
  const { h, ctx } = await harness(root);
  assert.equal(await h.emit("tool_call", { toolName: "write", input: { path: join(root, "ordinary/config.yml"), content: "safe" } }, ctx), undefined);
  const result = await h.emit("tool_call", { toolName: "write", input: { path: join(root, ".omp/config.yml"), content: "unsafe" } }, ctx) as { block?: boolean };
  assert.equal(result.block, true);
  assert.equal(create.mock.callCount(), 0);
  assert.equal(h.classifierCalls, 0);
});
