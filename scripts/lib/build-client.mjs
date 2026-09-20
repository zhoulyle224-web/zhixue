import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { assertDescendant } from "./fs-safety.mjs";
import { PROJECT_ROOT, PUBLIC_PAGES } from "./project-layout.mjs";

export async function copyClient({
  root = PROJECT_ROOT,
  destination,
} = {}) {
  if (!destination) throw new Error("缺少前端构建目标目录");
  const client = assertDescendant(root, destination);
  await mkdir(client, { recursive: true });
  await Promise.all(
    PUBLIC_PAGES.map((fileName) =>
      cp(resolve(root, fileName), resolve(client, fileName)),
    ),
  );
  await cp(resolve(root, "assets"), resolve(client, "assets"), { recursive: true });
  return client;
}
