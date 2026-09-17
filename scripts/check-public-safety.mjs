import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import worker from "../worker/index.js";

const ROOT = resolve(import.meta.dirname, "..");
const PUBLIC_ROOTS = ["assets", "index.html", "login.html", "student.html", "teacher.html", "worker"];
const SECRET_PATTERNS = [
  /\b(?:api[_-]?key|secret|password)\s*[:=]\s*["'][^"']{8,}/i,
  /authorization\s*:\s*bearer\s+[a-z0-9._-]{12,}/i,
  /zhixue_session\s*=/i,
  /csrf_token_hash\s*[:=]\s*["'][a-f0-9]{32,}/i,
];

async function filesAt(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...await filesAt(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

const files = [];
for (const name of PUBLIC_ROOTS) {
  const path = resolve(ROOT, name);
  if (/\.[a-z]+$/i.test(name)) files.push(path);
  else files.push(...await filesAt(path));
}
for (const file of files.filter((name) => /\.(?:html|js|mjs|css|json|csv|txt)$/i.test(name))) {
  const content = await readFile(file, "utf8");
  for (const pattern of SECRET_PATTERNS) {
    assert.doesNotMatch(content, pattern, `公开文件疑似包含秘密：${relative(ROOT, file).split(sep).join("/")}`);
  }
}

const response = await worker.fetch(new Request("https://demo.invalid/api/export", { method: "POST" }), {});
assert.equal(response.status, 501);
assert.equal((await response.json()).code, "EXPORT_NOT_AVAILABLE_IN_PUBLIC_DEMO");
console.log(`[M6] 公开安全检查通过：${files.length} 个文件，Worker 正式导出 fail closed`);
