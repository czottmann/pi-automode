import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { selectOutcomeEntries } from "../extensions/auto-mode/outcomes.ts";

// Run with AUTOMODE_OMP_SDK_ROOT=/path/to/package bun test tests/omp-context.test.ts.
const sdkRoot = process.env.AUTOMODE_OMP_SDK_ROOT;
test("published OMP SDK: retained outcomes through the native context adapter", { skip: !sdkRoot }, async t => {
  const load = (file: string) => import(pathToFileURL(join(sdkRoot!, "src", "session", file)).href);
  const { buildSessionContext } = await load("session-context.ts");
  const { SessionManager } = await load("session-manager.ts");
  const shim = await import(pathToFileURL(join(sdkRoot!, "src", "extensibility", "legacy-pi-coding-agent-shim.ts")).href);
  assert.equal(shim.buildSessionContext, buildSessionContext, "Pi-compatible SDK must expose the native projector");
  const { loadLegacyPiModule } = await import(pathToFileURL(join(sdkRoot!, "src", "extensibility", "plugins", "legacy-pi-compat.ts")).href);
  const adapter = await loadLegacyPiModule(join(import.meta.dirname, "..", "extensions", "auto-mode", "context.ts")) as
    typeof import("../extensions/auto-mode/context.ts");
  let checkedSnapshots = 0;
  const version = JSON.parse(readFileSync(join(sdkRoot!, "package.json"), "utf8")).version;
  assert.ok(["18.0.0", "18.13.2"].includes(version), `unverified OMP version ${version}`);
  const manager = () => SessionManager.inMemory(process.cwd());
  const user = (m: any, text: string) => m.appendMessage({ role: "user", content: text, timestamp: 1 });
  const pair = (m: any, id: string) => {
    const first = m.appendMessage({ role: "assistant", content: [
      { type: "toolCall", id, name: "ask_user_question", arguments: { question: id } },
    ], api: "anthropic-messages", provider: "anthropic", model: "test", timestamp: 1,
    stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    m.appendMessage({ role: "toolResult", toolCallId: id, toolName: "ask_user_question",
      content: [{ type: "text", text: `${id}-answer` }], isError: false, timestamp: 2 });
    return first;
  };
  const snapshot = (m: any) => {
    assert.equal(typeof m.buildContextEntries, "undefined");
    const before = JSON.stringify(m.getEntries());
    const result = adapter.snapshotContextEntries({ sessionManager: m } as never, true);
    assert.equal(result.supportsOutcomes, true);
    checkedSnapshots++;
    assert.equal(JSON.stringify(m.getEntries()), before, "must not mutate the session journal");
    // Compare with the manager's full journal projection for the current leaf.
    const relevant = (messages: any[]) => messages.filter(m => ["user", "assistant", "toolResult"].includes(m.role));
    assert.deepEqual(relevant(result.entries.map((e: any) => e.message)), relevant(m.buildSessionContext().messages));
    return result;
  };
  const ids = (m: any) => selectOutcomeEntries(snapshot(m).entries, 2000).selected
    .map(e => JSON.parse(e.text.slice("ToolResult ".length)).toolCallId);

  await t.test("empty session and ordinary paired results", () => {
    const m = manager();
    assert.deepEqual(ids(m), []);
    user(m, "request"); pair(m, "current");
    assert.deepEqual(ids(m), ["current"]);
  });
  await t.test("compaction drops the old prefix and keeps the tail plus new results", () => {
    const m = manager(); pair(m, "discarded"); const keep = pair(m, "kept");
    m.appendCompaction("summary", undefined, keep, 1000);
    pair(m, "new");
    assert.deepEqual(ids(m), ["kept", "new"]);
  });
  await t.test("repeated compaction uses only the latest retained tail", () => {
    const m = manager(); const old = pair(m, "old");
    m.appendCompaction("first", undefined, old, 1000);
    const keep = pair(m, "kept");
    m.appendCompaction("second", undefined, keep, 1000);
    assert.deepEqual(ids(m), ["kept"]);
  });
  await t.test("clear after compaction drops all earlier outcomes", () => {
    const m = manager(); const old = pair(m, "old");
    m.appendCompaction("summary", undefined, old, 1000);
    m.appendResetBoundary(); pair(m, "new");
    assert.deepEqual(ids(m), ["new"]);
  });
  await t.test("compaction after clear retains only its valid suffix", () => {
    const m = manager(); pair(m, "old"); m.appendResetBoundary();
    const keep = pair(m, "kept"); m.appendCompaction("summary", undefined, keep, 1000);
    assert.deepEqual(ids(m), ["kept"]);
  });
  await t.test("navigating away from a branch excludes its outcomes", () => {
    const m = manager(); const fork = user(m, "fork point"); pair(m, "abandoned");
    m.branch(fork); pair(m, "active");
    assert.deepEqual(ids(m), ["active"]);
  });
  await t.test("missing retained boundary does not recover older history", () => {
    const m = manager(); pair(m, "discarded");
    m.appendCompaction("summary", undefined, "unavailable-id", 1000); pair(m, "new");
    assert.deepEqual(ids(m), ["new"]);
  });
  await t.test("OpenAI remote replay does not expose the replaced raw results", () => {
    const m = manager(); const keep = pair(m, "replaced");
    m.appendCompaction("summary", undefined, keep, 1000, {
      method: "remote", preserveData: { openaiRemoteCompaction: {
        provider: "openai", replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
      } },
    }); pair(m, "new");
    assert.deepEqual(ids(m), ["new"]);
  });
  if (version === "18.13.2") {
    await t.test("in-flight tail after the provider replay checkpoint is retained", () => {
      const m = manager(); const keep = pair(m, "replaced");
      const checkpoint = m.getLeafId(); pair(m, "inflight");
      m.appendCompaction("summary", undefined, keep, 1000, {
        method: "remote", providerReplayThroughEntryId: checkpoint,
        preserveData: { openaiRemoteCompaction: { provider: "openai", replacementHistory: [] } },
      });
      assert.deepEqual(ids(m), ["inflight"]);
    });
    await t.test("Anthropic replay retains its native checkpoint tail", () => {
      const m = manager(); pair(m, "replaced"); const checkpoint = m.getLeafId(); pair(m, "inflight");
      m.appendCompaction("summary", undefined, "", 1000, {
        providerReplayThroughEntryId: checkpoint,
        preserveData: { anthropicCompaction: { provider: "anthropic", content: "native summary", exactTail: true } },
      });
      assert.deepEqual(ids(m), ["inflight"]);
    });
  }
  assert.equal(checkedSnapshots, version === "18.13.2" ? 11 : 9, "all nested cases must execute");
});
