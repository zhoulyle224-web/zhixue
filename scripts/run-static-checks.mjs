import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, relative, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ROOTS = ["server", "scripts", "tests", "worker"];
const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".next", "github-pages", "evidence"]);

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collect(full));
    else if (entry.isFile() && /\.(?:mjs|cjs|js)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const files = [];
for (const name of ROOTS) files.push(...await collect(resolve(ROOT, name)));
for (const file of files) {
  const label = relative(ROOT, file).split(sep).join("/");
  const result = spawnSync(process.execPath, ["--check", file], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    throw new Error(`静态语法检查失败：${label}`);
  }
}
console.log(`[M6] 静态语法检查通过：${files.length} 个 JavaScript 文件`);
