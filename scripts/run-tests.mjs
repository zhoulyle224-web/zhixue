import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, relative, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TEST_ROOT = resolve(ROOT, "tests");
const EXCLUDED = new Set([
  // Vinext starter preview test; it validates generated scaffolding, not the Zhixue product.
  "tests/rendered-html.test.mjs",
]);

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collect(full));
    else if (entry.isFile() && entry.name.endsWith(".test.mjs")) files.push(full);
  }
  return files;
}

const files = (await collect(TEST_ROOT)).filter((file) => {
  const name = relative(ROOT, file).split(sep).join("/");
  return !EXCLUDED.has(name);
});

if (!files.length) throw new Error("未发现产品测试文件");
console.log(`[M6] 自动发现 ${files.length} 个产品测试文件`);
for (const file of files) console.log(`[M6] - ${relative(ROOT, file).split(sep).join("/")}`);

const child = spawn(process.execPath, ["--test", ...files], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "test" },
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
