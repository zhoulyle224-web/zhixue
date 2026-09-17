import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const matrix = JSON.parse(await readFile(resolve(ROOT, "tests", "acceptance-matrix.json"), "utf8"));

test("M6-MATRIX-01 验收矩阵完整覆盖 M1～M6 与 12 个必需人工项", () => {
  const ids = matrix.items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const [module, count] of [["M1",20],["M2",12],["M3",28],["M4",45],["M5",50]]) {
    for (let index = 1; index <= count; index += 1) {
      assert.ok(ids.includes(`${module}-T${String(index).padStart(2, "0")}`));
    }
  }
  for (let index = 1; index <= 10; index += 1) {
    assert.ok(ids.includes(`M6-E2E-${String(index).padStart(2, "0")}`));
  }
  assert.equal(ids.filter((id) => id.startsWith("MANUAL-")).length, 12);
});

test("M6-MATRIX-02 状态枚举合法且自动化条目可追溯到测试源码", async () => {
  const coverage = new Set(["自动化已覆盖", "人工已验证", "尚未实现"]);
  const result = new Set(["pass", "fail", "not_run", "blocked"]);
  const cache = new Map();
  for (const item of matrix.items) {
    assert.ok(coverage.has(item.coverageStatus), item.id);
    assert.ok(result.has(item.lastRunResult), item.id);
    if (item.method !== "automated") continue;
    assert.ok(item.testFiles.length > 0 && item.testNames.length > 0, item.id);
    for (const file of item.testFiles) {
      if (!cache.has(file)) cache.set(file, await readFile(resolve(ROOT, file), "utf8"));
      for (const name of item.testNames) assert.ok(cache.get(file).includes(name), `${item.id} -> ${name}`);
    }
  }
});

test("M6-MATRIX-03 测试入口自动发现且验收脚本不自动改绿人工项", async () => {
  const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
  assert.match(pkg.scripts.test, /scripts\/run-tests\.mjs/);
  assert.match(pkg.scripts["test:acceptance"], /scripts\/run-acceptance\.mjs/);
  const runner = await readFile(resolve(ROOT, "scripts", "run-acceptance.mjs"), "utf8");
  assert.match(runner, /coverageStatus === "人工已验证"/);
  assert.match(runner, /manual\?\.result === "pass"/);
  assert.doesNotMatch(runner, /method === "manual"[^\n]+lastRunResult:\s*"pass"/);
});
