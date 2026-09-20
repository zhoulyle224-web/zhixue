import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { removeDirectory } from "./lib/fs-safety.mjs";
import { withProjectLock } from "./lib/project-lock.mjs";
import {
  GENERATED_DIRECTORIES,
  PRESERVED_RUNTIME_DIRECTORIES,
  PROJECT_ROOT,
} from "./lib/project-layout.mjs";

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

await withProjectLock("build", async () => {
  let removed = 0;
  for (const relativePath of GENERATED_DIRECTORIES) {
    const target = resolve(PROJECT_ROOT, relativePath);
    if (!(await exists(target))) continue;
    await removeDirectory(PROJECT_ROOT, target);
    console.log(`[clean] 已删除可再生成目录：${relativePath}`);
    removed += 1;
  }

  if (!removed) console.log("[clean] 没有需要删除的构建产物或缓存");
  console.log(`[clean] 已保留运行数据：${PRESERVED_RUNTIME_DIRECTORIES.join("、")}`);
});
