import assert from "node:assert/strict";
import test from "node:test";
import { snapshotContextEntries } from "../extensions/auto-mode/context.ts";
import { buildClassifierTranscript } from "../extensions/auto-mode/transcript.ts";
import { createFakeCtx } from "./test-helpers.ts";

const user = (id: string, parentId: string | null = null) => ({
  type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "user", content: id, timestamp: 1 },
});
const options = { maxUserTokens: 400, maxToolTokens: 400, includeToolResults: true };
function legacyContext(entries: unknown[]) {
  const ctx = createFakeCtx(entries);
  Object.assign(ctx.sessionManager, { buildContextEntries: undefined });
  return ctx;
}

test("native retained-entry API takes precedence over the SDK adapter, even when empty", () => {
  const ctx = createFakeCtx([]);
  Object.assign(ctx.sessionManager, { getBranch: () => { throw Error("must not read branch"); } });
  const native = () => { throw Error("must not project"); };
  assert.deepEqual(snapshotContextEntries(ctx as never, true, native), {
    entries: [], supportsOutcomes: true,
  });
});

test("SDK adapter receives exactly one active-branch snapshot and an explicit leaf", () => {
  const branch = [user("active")];
  const ctx = legacyContext(branch);
  let reads = 0;
  Object.assign(ctx.sessionManager, { getBranch: () => { reads++; return branch; } });
  const native = (entries: unknown[], leafId: string | null) => {
    assert.equal(entries, branch);
    assert.equal(leafId, "active");
    return { messages: [user("projected").message] };
  };
  const snapshot = snapshotContextEntries(ctx as never, true, native as never);
  assert.equal(reads, 1);
  assert.equal(snapshot.supportsOutcomes, true);
  assert.deepEqual(snapshot.entries.map(e => e.type === "message" && e.message), [user("projected").message]);
});

test("nullish retained snapshots use the native SDK adapter", () => {
  for (const retained of [null, undefined]) {
    const ctx = legacyContext([user("active")]);
    Object.assign(ctx.sessionManager, { buildContextEntries: () => retained });
    const snapshot = snapshotContextEntries(ctx as never, true);
    assert.equal(snapshot.supportsOutcomes, true);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].type === "message" && snapshot.entries[0].message.role, "user");
  }
});

test("SDK adapter keeps an explicitly empty branch empty", () => {
  const ctx = legacyContext([]);
  const native = (entries: unknown[], leafId: string | null) => {
    assert.deepEqual(entries, []);
    assert.equal(leafId, null);
    return { messages: [] };
  };
  assert.deepEqual(snapshotContextEntries(ctx as never, true, native as never), {
    entries: [], supportsOutcomes: true,
  });
});

test("opt-out preserves legacy evidence without invoking the adapter", () => {
  const branch = [user("old")];
  const native = () => { throw Error("must not project"); };
  const snapshot = snapshotContextEntries(legacyContext(branch) as never, false, native);
  assert.equal(snapshot.entries, branch);
  assert.equal(snapshot.supportsOutcomes, false);
});

test("missing SDK projection or malformed identities never enable raw results", () => {
  // Passing a non-function simulates an older SDK namespace without the export.
  for (const native of [null, false]) {
    const branch = [user("old")];
    const snapshot = snapshotContextEntries(legacyContext(branch) as never, true, native as never);
    assert.equal(snapshot.entries, branch);
    assert.equal(snapshot.supportsOutcomes, false);
  }
  const snapshot = snapshotContextEntries(legacyContext([{ type: "message", message: {} }]) as never,
    true, (() => { throw Error("must not project invalid entries"); }) as never);
  assert.equal(snapshot.supportsOutcomes, false);
});

test("SDK errors propagate instead of enabling raw-branch evidence", () => {
  assert.throws(() => snapshotContextEntries(legacyContext([user("old")]) as never,
    true, () => { throw Error("projection failed"); }), /projection failed/);
});

test("real Pi SDK adapter drops compacted calls/results and preserves retained outcomes", () => {
  const call = (id: string, parentId: string | null) => ({
    ...user(id, parentId), message: { role: "assistant", content: [
      { type: "toolCall", id, name: "ask_user_question", arguments: { question: id } },
    ], timestamp: 1 },
  });
  const result = (id: string, parentId: string) => ({
    ...user(`${id}-result`, parentId), message: { role: "toolResult", toolCallId: id,
      toolName: "ask_user_question", isError: false,
      content: [{ type: "text", text: `${id}-answer` }], timestamp: 2 },
  });
  const branch = [call("discarded", null), result("discarded", "discarded"),
    call("retained", "discarded-result"), result("retained", "retained"),
    { type: "compaction", id: "compact", parentId: "retained-result",
      timestamp: "2026-01-01T00:00:00.000Z", firstKeptEntryId: "retained",
      summary: "Earlier work summarized", tokensBefore: 1000 },
    user("current", "compact")];
  const before = JSON.stringify(branch);
  const text = buildClassifierTranscript(legacyContext(branch) as never, options);
  assert.doesNotMatch(text, /discarded/);
  assert.match(text, /retained-answer/);
  assert.match(text, /User: current/);
  assert.equal(JSON.stringify(branch), before);
});
