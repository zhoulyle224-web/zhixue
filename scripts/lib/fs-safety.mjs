import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export function assertDescendant(root, target) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`拒绝操作项目目录之外或项目根目录本身：${resolvedTarget}`);
  }
  return resolvedTarget;
}

export async function resetDirectory(root, target) {
  const safeTarget = assertDescendant(root, target);
  await rm(safeTarget, { recursive: true, force: true });
  await mkdir(safeTarget, { recursive: true });
  return safeTarget;
}

export async function removeDirectory(root, target) {
  const safeTarget = assertDescendant(root, target);
  await rm(safeTarget, { recursive: true, force: true });
  return safeTarget;
}
