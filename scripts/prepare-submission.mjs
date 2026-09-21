import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const RELEASE_ROOT = join(ROOT, "release");
const STAGING = join(RELEASE_ROOT, "智学双擎_参赛提交版");
const ROOT_FILES = [
  ".dockerignore", ".gitattributes", ".gitignore", ".nojekyll", "404.html", "Dockerfile", "compose.yaml",
  "deploy-and-open.bat", "一键部署并打开.bat", "stop-service.bat", "停止智学双擎服务.bat",
  "index.html", "login.html", "student.html",
  "teacher.html", "package.json", "package-lock.json", "README.md",
];
const DIRECTORIES = [
  ".openai", "assets", "db", "drizzle", "openclaw", "prompts", "scripts", "server", "tests",
  "worker", "docs",
];
const EXCLUDED_SEGMENTS = new Set([
  "node_modules", ".git", "runtime", ".tmp", "backups", "outputs", "work", ".wrangler",
  ".next", ".vinext", "archive", "dist", "github-pages",
]);

function posix(path) {
  return path.split(sep).join("/");
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function excluded(source) {
  const rel = posix(relative(ROOT, source));
  const parts = rel.split("/");
  if (parts.some((part) => EXCLUDED_SEGMENTS.has(part))) return true;
  if (/\.sqlite-(?:wal|shm)$/i.test(rel)) return true;
  if (/(^|\/)(?:audit\.jsonl|server\.json|[^/]+\.log)$/i.test(rel)) return true;
  if (/(^|\/)\.env(?:\..+)?$/i.test(rel) && !/\.env\.example$/i.test(rel)) return true;
  if (/deploy-zhixue\.zip$/i.test(rel)) return true;
  return false;
}

async function copyPath(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter: (current) => !excluded(current),
  });
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function main() {
  const resolvedStaging = resolve(STAGING);
  if (dirname(resolvedStaging) !== resolve(RELEASE_ROOT) || basename(resolvedStaging) !== "智学双擎_参赛提交版") {
    throw new Error(`拒绝清理非预期目录：${resolvedStaging}`);
  }
  await rm(resolvedStaging, { recursive: true, force: true });
  await mkdir(resolvedStaging, { recursive: true });

  for (const name of ROOT_FILES) {
    const source = join(ROOT, name);
    if (!(await exists(source))) throw new Error(`缺少源码文件：${name}`);
    await copyPath(source, join(resolvedStaging, name));
  }
  for (const name of ["deploy-and-open.bat", "一键部署并打开.bat", "stop-service.bat", "停止智学双擎服务.bat"]) {
    const target = join(resolvedStaging, name);
    const content = await readFile(target, "utf8");
    await writeFile(target, content.replace(/\r?\n/g, "\r\n"), "utf8");
  }
  for (const name of DIRECTORIES) {
    const source = join(ROOT, name);
    if (await exists(source)) await copyPath(source, join(resolvedStaging, name));
  }

  await mkdir(join(resolvedStaging, "data"), { recursive: true });
  for (const name of ["README.md", "web_snapshots.json", "zhixue_demo.sqlite", "zhixue_demo.summary.json"]) {
    await copyPath(join(ROOT, "data", name), join(resolvedStaging, "data", name));
  }

  const bundledNodeRuntime = process.platform === "win32";
  if (bundledNodeRuntime) {
    const runtimeDirectory = join(resolvedStaging, "runtime");
    await mkdir(runtimeDirectory, { recursive: true });
    await copyFile(process.execPath, join(runtimeDirectory, "node.exe"));
  }

  const runId = (await readFile(join(ROOT, "evidence", "m6", "LATEST.txt"), "utf8")).trim();
  const evidenceSource = join(ROOT, "evidence", "m6", runId);
  const evidenceTarget = join(resolvedStaging, "evidence", "m6", runId);
  await mkdir(dirname(evidenceTarget), { recursive: true });
  await copyPath(evidenceSource, evidenceTarget);
  await writeFile(join(resolvedStaging, "evidence", "m6", "LATEST.txt"), `${runId}\n`, "utf8");

  const environment = JSON.parse(await readFile(join(evidenceSource, "environment.json"), "utf8"));
  const manifest = {
    project: "智学双擎",
    releaseVersion: "2026.09-final",
    createdAt: new Date().toISOString(),
    dataClassification: "synthetic-demo-only",
    coreScenarios: ["学生课后即时答疑", "教师学情智能研判"],
    localRuntime: bundledNodeRuntime ? `Bundled Node.js ${process.version} for Windows x64` : "Node.js >= 22.13",
    bundledNodeRuntime,
    publicRuntime: "展示版能力受限；正式写操作仅在本地 Node 版提供",
    m6FinalRunId: runId,
    m6SummarySha256: await sha256(join(evidenceSource, "summary.md")),
    baselineDbSha256: environment.baselineDb.sha256After,
    runtimeDbIncluded: false,
    activeSessionsIncluded: false,
    schoolIdentifyingInformationIncluded: false,
    artifactStatus: {
      source: "ready",
      oneClickStart: "ready",
      documentation: "ready",
      presentationBinary: "not_ready",
      demonstrationVideo: "not_ready",
      m6ManualGate: "blocked"
    }
  };
  await writeFile(join(RELEASE_ROOT, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await writeFile(join(resolvedStaging, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const reportPath = join(resolvedStaging, "release-evidence", "submission-check.json");
  const result = spawnSync(process.execPath, [
    join(ROOT, "scripts", "check-submission.mjs"),
    "--target", resolvedStaging,
    "--smoke",
    "--json-out", reportPath,
  ], { cwd: ROOT, encoding: "utf8" });
  if (result.status === 0) console.log("[M7] clean staging smoke and submission check complete");
  else {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
  }
  if (result.status !== 0) throw new Error(`提交检查失败（exit ${result.status}）`);

  const finalCheck = spawnSync(process.execPath, [
    join(ROOT, "scripts", "check-submission.mjs"),
    "--target", resolvedStaging,
    "--json-out", reportPath,
  ], { cwd: ROOT, encoding: "utf8" });
  if (finalCheck.status === 0) console.log("[M7] final staging scan complete");
  else {
    process.stdout.write(finalCheck.stdout || "");
    process.stderr.write(finalCheck.stderr || "");
  }
  if (finalCheck.status !== 0) throw new Error(`最终提交检查失败（exit ${finalCheck.status}）`);
  console.log(`[M7] staging ready: ${posix(relative(ROOT, resolvedStaging))}`);
}

main().catch((error) => {
  console.error(`[M7] prepare submission failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
