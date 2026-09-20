import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PATH = resolve(fileURLToPath(new URL("../assets/knowledge/common-foundations.json", import.meta.url)));
let cached;

export async function loadCommonKnowledge() {
  if (cached) return cached;
  const value = JSON.parse(await readFile(PATH, "utf8"));
  if (!value?.version || !Array.isArray(value.entries) || !value.entries.every(item =>
    item.id && ["K0", "K1"].includes(item.layer) && item.title && item.text && item.locator)) {
    throw Object.assign(new Error("公共基础知识库配置错误。"), { code: "COMMON_KNOWLEDGE_INVALID", status: 500 });
  }
  cached = { version: value.version, sourceLabel: value.sourceLabel, entries: value.entries.map(item => ({
    ...item, version: value.version, source_label: value.sourceLabel,
  })) };
  return cached;
}
