import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { assertDescendant } from "../scripts/lib/fs-safety.mjs";
import { withProjectLock } from "../scripts/lib/project-lock.mjs";
import {
  GENERATED_DIRECTORIES,
  PRESERVED_RUNTIME_DIRECTORIES,
  PROJECT_ROOT,
  PUBLIC_PAGES,
} from "../scripts/lib/project-layout.mjs";

test("公开页面清单集中维护且源码均存在", async () => {
  assert.equal(new Set(PUBLIC_PAGES).size, PUBLIC_PAGES.length);
  await Promise.all(PUBLIC_PAGES.map((fileName) => access(resolve(PROJECT_ROOT, fileName))));
});

test("清理白名单不包含运行数据和用户输出", () => {
  assert.deepEqual(GENERATED_DIRECTORIES, ["dist", "release", ".tmp"]);
  for (const protectedPath of PRESERVED_RUNTIME_DIRECTORIES) {
    assert.ok(!GENERATED_DIRECTORIES.includes(protectedPath));
  }
  assert.ok(PRESERVED_RUNTIME_DIRECTORIES.includes("data/runtime"));
});

test("目录安全守卫拒绝根目录和越界路径", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zhixue-fs-safety-"));
  try {
    assert.throws(() => assertDescendant(root, root), /拒绝操作/);
    assert.throws(() => assertDescendant(root, resolve(root, "..", "outside")), /拒绝操作/);
    assert.equal(assertDescendant(root, resolve(root, "dist")), resolve(root, "dist"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("并发构建被项目锁明确阻止", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zhixue-build-lock-"));
  let releaseFirst;
  let markAcquired;
  const acquired = new Promise((resolveAcquired) => { markAcquired = resolveAcquired; });
  const gate = new Promise((resolveGate) => { releaseFirst = resolveGate; });
  try {
    const first = withProjectLock("build", async () => {
      markAcquired();
      await gate;
    }, { root });
    await acquired;
    await assert.rejects(
      withProjectLock("build", async () => {}, { root }),
      /已有构建或清理任务正在运行/,
    );
    releaseFirst();
    await first;
  } finally {
    releaseFirst?.();
    await rm(root, { recursive: true, force: true });
  }
});
