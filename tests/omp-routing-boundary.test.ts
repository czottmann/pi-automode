import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { deterministicHardDeny, extractToolPaths } from "../extensions/auto-mode.ts";

function fixture(t: TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "automode-routing-boundary-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("OMP routing nested write headers cannot conceal safety controls", (t) => {
  const root = fixture(t);
  for (const path of ["[[.omp/settings.json]]", "[[.omp/settings.json#ABCD]]", "[[.omp/settings.json]#ABCD]"]) {
    assert.notEqual(deterministicHardDeny("write", { path, content: "replacement" }, root), undefined);
  }
  assert.equal(deterministicHardDeny("write", { path: "[[safe.txt]]", content: "safe" }, root), undefined);
});

test("OMP routing compound writes fail closed rather than checking member decoys", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "shield.zip"), "archive fixture\n");
  for (const path of ["shield.zip:member.txt", "[shield.zip:member.txt#ABCD]", "shield.zip:member.txt:raw"]) {
    assert.notEqual(extractToolPaths("write", { path, content: "replacement" }, root, { nativeWrite: true }).error, undefined);
  }
  assert.deepEqual(extractToolPaths("write", { path: "safe.txt" }, root, { nativeWrite: true }).paths, [join(root, "safe.txt")]);
});

test("OMP routing comma and whitespace lists cannot preempt native suffix discovery", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "nested"));
  for (const path of ["a.txt", "b.txt", "nested/a.txt,b.txt", "nested/a.txt b.txt"]) writeFileSync(join(root, path), "data\n");
  for (const path of ["a.txt,b.txt", "a.txt b.txt"]) {
    assert.notEqual(extractToolPaths("read", { path }, root, { nativeRead: true }).error, undefined);
  }
  assert.deepEqual(extractToolPaths("read", { path: "a.txt;b.txt" }, root, { nativeRead: true }).paths, [join(root, "a.txt"), join(root, "b.txt")]);
  writeFileSync(join(root, "a.txt,b.txt"), "literal\n");
  assert.deepEqual(extractToolPaths("read", { path: "a.txt,b.txt" }, root, { nativeRead: true }).paths, [join(root, "a.txt,b.txt")]);
});

test("OMP routing raw quoted and spaced literals retain native filename identity", (t) => {
  const root = fixture(t);
  for (const path of ["safe.txt", '"safe.txt"', " safe.txt "]) writeFileSync(join(root, path), "data\n");
  for (const path of ['"safe.txt"', " safe.txt "]) {
    assert.deepEqual(extractToolPaths("read", { path }, root, { nativeRead: true }).paths, [join(root, path)]);
  }
});

test("OMP routing line selectors cannot hide earlier native compound-file dispatch", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "shield.zip"), "archive fixture\n");
  writeFileSync(join(root, "shield.zip:member.txt"), "decoy\n");
  assert.notEqual(extractToolPaths("read", { path: "shield.zip:member.txt:1" }, root, { nativeRead: true }).error, undefined);
  writeFileSync(join(root, "safe.txt"), "safe\n");
  assert.deepEqual(extractToolPaths("read", { path: "safe.txt:1:raw" }, root, { nativeRead: true }).paths, [join(root, "safe.txt")]);
});

test("OMP routing configured project-control names remain safety controls", (t) => {
  const root = fixture(t);
  const previous = process.env.PI_CONFIG_DIR;
  process.env.PI_CONFIG_DIR = ".selected-omp";
  t.after(() => { if (previous === undefined) delete process.env.PI_CONFIG_DIR; else process.env.PI_CONFIG_DIR = previous; });
  const target = join(root, ".selected-omp/config.yml");
  assert.notEqual(deterministicHardDeny("write", { path: target }, root), undefined);
  assert.equal(deterministicHardDeny("write", { path: join(root, "data/config.yml") }, root), undefined);
});

test("OMP routing nested archive-member writes cannot hide the backing archive", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "shield.zip"), "archive fixture\n");
  for (const path of ["shield.zip:dir/member.txt", "shield.zip:dir\\member.txt"]) {
    assert.notEqual(extractToolPaths("write", { path }, root, { nativeWrite: true }).error, undefined);
  }
  writeFileSync(join(root, ":shield.txt"), "literal\n");
  assert.deepEqual(extractToolPaths("write", { path: ":shield.txt" }, root, { nativeWrite: true }).paths, [join(root, ":shield.txt")]);
});

test("OMP routing local URL aliases fail closed before filesystem authorization", (t) => {
  const root = fixture(t);
  for (const path of ["local:/shield.txt", join(root, "local:/shield.txt"), `${root}/local://shield.txt`]) {
    assert.notEqual(extractToolPaths("read", { path }, root, { nativeRead: true }).error, undefined);
    assert.notEqual(extractToolPaths("write", { path }, root, { nativeWrite: true }).error, undefined);
  }
  assert.deepEqual(extractToolPaths("read", { path: "local.txt" }, root, { nativeRead: false }).paths, [join(root, "local.txt")]);
});
