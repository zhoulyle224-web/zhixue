import { open, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { assertDescendant } from "./fs-safety.mjs";
import { PROJECT_ROOT } from "./project-layout.mjs";

export async function withProjectLock(name, task, { root = PROJECT_ROOT } = {}) {
  const lockPath = assertDescendant(root, resolve(root, `.zhixue-${name}.lock`));

  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const ownerPid = Number.parseInt(await readFile(lockPath, "utf8").catch(() => ""), 10);
    let ownerIsActive = Number.isInteger(ownerPid) && ownerPid > 0;
    if (ownerIsActive) {
      try { process.kill(ownerPid, 0); } catch (probeError) {
        ownerIsActive = probeError?.code !== "ESRCH";
      }
    }
    if (ownerIsActive) {
      throw new Error(`已有构建或清理任务正在运行（PID ${ownerPid}），请等待其完成后重试`);
    }
    await rm(lockPath, { force: true });
    try {
      handle = await open(lockPath, "wx");
    } catch (retryError) {
      if (retryError?.code === "EEXIST") {
        throw new Error("已有构建或清理任务正在运行，请等待其完成后重试");
      }
      throw retryError;
    }
  }

  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    return await task();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}
