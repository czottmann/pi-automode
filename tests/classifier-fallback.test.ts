import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  buildEffectiveConfigFromSources,
  createPiAutomode,
  defaultClassifyAction,
  restoreState,
  statusText,
  validateSettingsFile,
} from "../extensions/auto-mode.ts";
import { baseConfig, baseState, createFakeCtx, createFakePi } from "./test-helpers.ts";

function response(text: string, stopReason = "stop"): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "test", provider: "test", model: "test",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  } as AssistantMessage;
}

function decision(outcome: "allow" | "block"): AssistantMessage {
  return {
    ...response("", "toolUse"),
    content: [{ type: "toolCall", id: "decision", name: "classifier_decision", arguments: { decision: outcome, tier: "none", reason: "policy decision" } }],
  };
}

function setup(options: {
  missing?: string[];
  noAuth?: string[];
  auth?: (id: string) => Promise<void>;
  complete?: (id: string, stage: string, options: any) => Promise<AssistantMessage>;
  signal?: AbortSignal;
  fallbacks?: string[];
  timeout?: number;
} = {}) {
  const calls: Array<{ id: string; stage: string; options: any }> = [];
  const lookups: string[] = [];
  const model = (id: string) => ({ provider: "test", id, api: "test", reasoning: false, contextWindow: 128_000, maxTokens: 32_000 });
  const ctx = createFakeCtx([], {
    model: model("primary"), signal: options.signal,
    modelRegistry: {
      find(_provider: string, id: string) {
        lookups.push(id);
        return options.missing?.includes(id) ? undefined : model(id);
      },
      async getApiKeyAndHeaders(m: any) {
        await options.auth?.(m.id);
        return options.noAuth?.includes(m.id) ? { ok: false } : { ok: true, apiKey: "test-key" };
      },
      async complete(m: any, prompt: any, requestOptions: any) {
        const stage = prompt.tools ? "detailed" : "fast";
        calls.push({ id: m.id, stage, options: requestOptions });
        return options.complete ? options.complete(m.id, stage, requestOptions) : response("0");
      },
    },
  });
  const config = baseConfig({ classifierModel: "test/primary", classifierFallbackModels: options.fallbacks ?? ["test/backup", "test/last"], classifierTimeoutMs: options.timeout ?? 1000 });
  const run = () => defaultClassifyAction(ctx as never, config, '{"toolName":"noop","input":{}}', "");
  return { ctx, config, run, calls, lookups };
}

test("fallback configuration defaults, replaces by precedence, and ignores shared project settings", () => {
  assert.deepEqual(buildEffectiveConfigFromSources().classifierFallbackModels, []);
  const sources = {
    globalSettings: [{ autoMode: { classifierFallbackModels: ["test/global"] } }],
    projectLocalSettings: [{ autoMode: { classifierFallbackModels: ["test/local"] } }],
    projectSharedSettings: [{ autoMode: { classifierFallbackModels: ["test/shared"] } }],
  };
  assert.deepEqual(buildEffectiveConfigFromSources(sources).classifierFallbackModels, ["test/local"]);
  assert.deepEqual(buildEffectiveConfigFromSources({ ...sources, inlineSettings: [{ autoMode: { classifierFallbackModels: [] } }] }).classifierFallbackModels, []);
  assert.deepEqual(validateSettingsFile({ autoMode: { classifierFallbackModels: ["test/a", "test/b"] } }, "test"), []);
  for (const value of [null, "test/model", ["invalid"], ["test/valid", 42], ["$defaults"]]) {
    assert.match(validateSettingsFile({ autoMode: { classifierFallbackModels: value } } as any, "test").join("\n"), /classifierFallbackModels must be an array of provider\/model strings/);
    assert.deepEqual(buildEffectiveConfigFromSources({ globalSettings: sources.globalSettings, inlineSettings: [{ autoMode: { classifierFallbackModels: value } } as any] }).classifierFallbackModels, ["test/global"]);
  }
});

for (const unavailable of ["missing", "credentials", "auth throws", "request throws", "provider error", "provider abort", "timeout"]) {
  test(`fallback advances on ${unavailable} and keeps per-request timeout`, async () => {
    const h = setup({
      missing: unavailable === "missing" ? ["primary"] : [],
      noAuth: unavailable === "credentials" ? ["primary"] : [],
      auth: async (id) => { if (id === "primary" && unavailable === "auth throws") throw new Error("auth unavailable"); },
      timeout: 10,
      complete: async (id) => {
        if (id !== "primary") return response("0");
        if (unavailable === "request throws") throw new Error("network unavailable");
        if (unavailable === "provider error") return { ...response("0", "error"), errorMessage: "provider unavailable" };
        if (unavailable === "provider abort") return response("0", "aborted");
        if (unavailable === "timeout") return new Promise(() => {});
        throw new Error("primary request must not run");
      },
    });
    const result = await h.run();
    assert.equal(result.decision, "allow");
    assert.equal(result.classifier?.model, "test/backup");
    assert.equal(result.classifier?.failures.length, 1);
    assert.equal(result.classifier?.failures[0]?.model, "test/primary");
    assert.equal(h.calls.at(-1)?.id, "backup");
    assert.ok(h.calls.every((c) => c.options.timeoutMs === 10));
    assert.equal(h.calls.filter((c) => c.id === "primary").length, ["missing", "credentials", "auth throws"].includes(unavailable) ? 0 : 1);
  });
}

test("fallback follows order, restarts from fast stage, and starts primary again for each action", async () => {
  const h = setup({ complete: async (id, stage) => {
    if (stage === "fast") return response("1");
    if (id !== "last") throw new Error(`${id} offline`);
    return decision("allow");
  } });
  for (let i = 0; i < 2; i++) {
    const result = await h.run();
    assert.equal(result.decision, "allow");
    assert.equal(result.classifier?.model, "test/last");
    assert.deepEqual(result.classifier?.failures.map((f) => f.model), ["test/primary", "test/backup"]);
    assert.deepEqual(result.io?.attempts.map((a) => a.model), ["test/primary", "test/primary", "test/backup", "test/backup", "test/last", "test/last"]);
  }
  assert.deepEqual(h.calls.map((c) => `${c.id}/${c.stage}`), Array(2).fill(["primary/fast", "primary/detailed", "backup/fast", "backup/detailed", "last/fast", "last/detailed"]).flat());
});

for (const outcome of ["allow", "block"] as const) {
  test(`valid ${outcome} decision never triggers fallback`, async () => {
    const h = setup({ complete: async (_id, stage) => stage === "fast" ? response("1") : decision(outcome) });
    assert.equal((await h.run()).decision, outcome);
    assert.deepEqual(h.lookups, ["primary"]);
  });
}

for (const invalid of ["fast", "detailed", "truncated fast", "truncated detailed"]) {
  test(`${invalid} output fails closed without fallback`, async () => {
    const fast = invalid.endsWith("fast");
    const h = setup({ complete: async (_id, stage) => stage === "fast" && !fast ? response("1") : response("invalid", invalid.startsWith("truncated") ? "length" : "stop") });
    const result = await h.run();
    assert.equal(result.decision, "block");
    assert.deepEqual(result.classifier?.failures, []);
    assert.deepEqual(h.lookups, ["primary"]);
    assert.equal(h.calls.length, fast ? 1 : 3);
  });
}

test("all unavailable models preserve the last fail-closed reason", async () => {
  const h = setup({ complete: async (id) => { throw new Error(`${id} offline`); } });
  const result = await h.run();
  assert.equal(result.decision, "block");
  assert.equal(result.reason, "Fast classifier failed; auto mode fails closed: last offline");
  assert.equal(result.classifier?.failures.length, 3);
  assert.equal(result.io?.attempts.length, 3);
});

test("all missing models report no used model and preserve the setup block reason", async () => {
  const h = setup({ missing: ["primary", "backup", "last"] });
  const result = await h.run();
  assert.equal(result.reason, "No classifier model/API key available; auto mode fails closed.");
  assert.equal(result.classifier?.model, undefined);
  assert.equal(result.classifier?.failures.length, 3);
  assert.equal(h.calls.length, 0);
});

test("absent fallback list preserves single-model failure behavior", async () => {
  const h = setup({ fallbacks: [], complete: async () => { throw new Error("offline"); } });
  assert.equal((await h.run()).reason, "Fast classifier failed; auto mode fails closed: offline");
  assert.equal(h.calls.length, 1);
});

for (const when of ["before", "auth", "fast", "between stages", "detailed retry"]) {
  test(`parent cancellation ${when} stops classification without fallback`, async () => {
    const controller = new AbortController();
    if (when === "before") controller.abort();
    const h = setup({
      signal: controller.signal,
      auth: async () => { if (when === "auth") controller.abort(); },
      complete: async (_id, stage) => {
        if (when === "fast") { controller.abort(); return new Promise(() => {}); }
        if (when === "between stages" || stage === "detailed") controller.abort();
        return stage === "fast" ? response("1") : response("invalid");
      },
    });
    const result = await h.run();
    assert.equal(result.decision, "block");
    assert.ok(h.lookups.length <= 1);
    assert.equal(h.calls.length, ["before", "auth"].includes(when) ? 0 : when === "detailed retry" ? 2 : 1);
  });
}

test("fallback works with the session model as primary when classifierModel is absent", async () => {
  const h = setup({ complete: async (id) => { if (id === "primary") throw new Error("offline"); return response("0"); } });
  delete h.config.classifierModel;
  assert.equal((await h.run()).classifier?.model, "test/backup");
  assert.deepEqual(h.lookups, ["backup"]);
});

test("hook persists fallback diagnostics and logs actual models without classifier I/O logging", async () => {
  const dir = mkdtempSync(join(tmpdir(), "automode-fallback-"));
  try {
    const h = setup({ complete: async (id) => { if (id === "primary") throw new Error("private provider failure"); return response("0"); } });
    h.config.log = { enabled: true, classifierIo: false };
    const fake = createFakePi();
    const ctx = createFakeCtx(fake.entries, { modelRegistry: h.ctx.modelRegistry, sessionFile: join(dir, "session.jsonl") });
    createPiAutomode({ loadConfig: () => h.config })(fake.pi);
    await fake.emit("session_start", { type: "session_start" }, ctx);
    assert.equal(await fake.emit("tool_call", { toolName: "noop", input: {} }, ctx), undefined);
    const state = restoreState(ctx as never);
    assert.equal(state.lastClassifier?.model, "test/backup");
    const text = statusText(h.config, state);
    assert.match(text, /classifier: test\/primary/);
    assert.match(text, /classifier fallbacks: test\/backup → test\/last/);
    assert.match(text, /last classifier model: test\/backup/);
    assert.match(text, /private provider failure/);
    const log = readFileSync(join(dir, "session-pi-automode.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const entry = log.find((line) => line.type === "decision");
    assert.equal(entry.classifierModel, "test/primary");
    assert.equal(entry.classifier.model, "test/backup");
    assert.match(entry.classifier.failures[0].reason, /private provider failure/);
    assert.equal(log.filter((line) => line.type === "message").length, 1);
    const inspected = await fake.tools.get("automode_inspect")!.execute("inspect", { action: "status" }, undefined, undefined, ctx);
    assert.match(JSON.stringify(inspected), /test\/backup/);
    assert.doesNotMatch(JSON.stringify(inspected), /private provider failure/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("status and old session state have no previous classifier run", () => {
  assert.match(statusText(baseConfig(), baseState()), /last classifier model: none/);
  assert.equal(restoreState(createFakeCtx() as never).lastClassifier, undefined);
});

for (const unavailable of ["error", "aborted", "timeout"]) {
  test(`detailed-stage ${unavailable} restarts the fallback at fast stage`, async () => {
    const h = setup({ timeout: 10, complete: async (id, stage) => {
      if (id !== "primary") return response("0");
      if (stage === "fast") return response("1");
      return unavailable === "timeout" ? new Promise(() => {}) : response("", unavailable);
    } });
    assert.equal((await h.run()).decision, "allow");
    assert.deepEqual(h.calls.map((c) => `${c.id}/${c.stage}`), ["primary/fast", "primary/detailed", "backup/fast"]);
    assert.ok(h.calls.every((c) => c.options.timeoutMs === 10));
  });
}

test("invalid fallback output stops the chain before later models", async () => {
  const h = setup({ complete: async (id) => {
    if (id === "primary") throw new Error("offline");
    return response("not a decision");
  } });
  const result = await h.run();
  assert.equal(result.decision, "block");
  assert.equal(result.classifier?.failures.length, 1);
  assert.deepEqual(h.lookups, ["primary", "backup"]);
});

test("local context-limit failure does not trigger fallback or report a used model", async () => {
  const h = setup();
  const result = await defaultClassifyAction(h.ctx as never, h.config, "x".repeat(600_000), "");
  assert.equal(result.decision, "block");
  assert.match(result.reason, /cannot fit/);
  assert.deepEqual(h.lookups, ["primary"]);
  assert.equal(result.classifier?.model, undefined);
  assert.equal(h.calls.length, 0);
});

test("later model resolution failures retain usage attempts from earlier models", async () => {
  const h = setup({ missing: ["backup", "last"], complete: async () => response("", "error") });
  const result = await h.run();
  assert.equal(result.decision, "block");
  assert.equal(result.classifier?.model, "test/primary");
  assert.deepEqual(result.classifier?.failures.map((f) => f.kind), ["request", "resolution", "resolution"]);
  assert.equal(result.io?.attempts.length, 1);
});

test("classifier I/O logs retain failed and successful model attempts and usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "automode-fallback-io-"));
  try {
    const h = setup({ complete: async (id) => id === "primary" ? response("", "error") : response("0") });
    h.config.log = { enabled: true, classifierIo: true };
    const fake = createFakePi();
    const ctx = createFakeCtx(fake.entries, { modelRegistry: h.ctx.modelRegistry, sessionFile: join(dir, "session.jsonl") });
    createPiAutomode({ loadConfig: () => h.config })(fake.pi);
    await fake.emit("session_start", { type: "session_start" }, ctx);
    await fake.emit("tool_call", { toolName: "noop", input: {} }, ctx);
    const log = readFileSync(join(dir, "session-pi-automode.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(log.filter((line) => line.type === "message").length, 2);
    const entry = log.find((line) => line.type === "classifier");
    assert.equal(entry.model, "test/backup");
    assert.deepEqual(entry.attempts.map((a: any) => a.model), ["test/primary", "test/backup"]);
    assert.equal(entry.parsed.decision, "allow");
    assert.equal(entry.decisionId, log.at(-1).decisionId);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("deterministic hook decisions do not start fallback classification or erase last run", async () => {
  const h = setup({ complete: async (id) => { if (id === "primary") throw new Error("offline"); return response("0"); } });
  const fake = createFakePi();
  const ctx = createFakeCtx(fake.entries, { modelRegistry: h.ctx.modelRegistry });
  createPiAutomode({ loadConfig: () => h.config })(fake.pi);
  await fake.emit("session_start", { type: "session_start" }, ctx);
  await fake.emit("tool_call", { toolName: "noop", input: {} }, ctx);
  const calls = h.calls.length;
  await fake.emit("tool_call", { toolName: "read", input: { path: "safe.txt" } }, ctx);
  assert.equal(h.calls.length, calls);
  assert.equal(restoreState(ctx as never).lastClassifier?.model, "test/backup");
});

for (const settleLate of ["resolve", "reject"]) {
  test(`cancellation releases pending fallback authentication before late ${settleLate}`, async () => {
    const controller = new AbortController();
    const authStarted = Promise.withResolvers<void>();
    const auth = Promise.withResolvers<void>();
    const h = setup({
      signal: controller.signal,
      auth: async (id) => {
        if (id === "backup") {
          authStarted.resolve();
          await auth.promise;
        }
      },
      complete: async () => { throw new Error("primary offline"); },
    });
    const pending = h.run();
    await authStarted.promise;
    controller.abort(new Error("user cancelled"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Cancellation did not release pending authentication")), 100);
        }),
      ]);
      assert.equal(result.decision, "block");
      assert.match(result.reason, /cancelled/);
      assert.deepEqual(h.lookups, ["primary", "backup"]);
      assert.deepEqual(h.calls.map((call) => call.id), ["primary"]);
    } finally {
      clearTimeout(timer);
      if (settleLate === "resolve") auth.resolve();
      else auth.reject(new Error("late auth failure"));
      await pending;
    }
    // Allow late auth settlement to run; it must not resume classification.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.calls.map((call) => call.id), ["primary"]);
    assert.deepEqual(h.lookups, ["primary", "backup"]);
  });
}