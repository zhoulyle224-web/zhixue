import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, join, relative, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const EVIDENCE_ROOT = resolve(ROOT, "evidence", "m6");
const MATRIX_PATH = resolve(ROOT, "tests", "acceptance-matrix.json");
const MANUAL_PATH = resolve(ROOT, "tests", "manual-acceptance-results.json");
const BASELINE_PATH = resolve(ROOT, "data", "zhixue_demo.sqlite");
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" });
const gitCommit = git.status === 0 ? git.stdout.trim() : "unknown";
const runId = `${stamp}_${gitCommit}`;
const runDir = resolve(EVIDENCE_ROOT, runId);
const commandDir = resolve(runDir, "commands");
const manualDir = resolve(runDir, "manual");

const hash = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const baselineBefore = await hash(BASELINE_PATH);
await mkdir(commandDir, { recursive: true });
await mkdir(manualDir, { recursive: true });

function sanitize(value) {
  return String(value)
    .replace(/(password|api[_-]?key|authorization|cookie|set-cookie|x-csrf-token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/zhixue_session=[^\s;]+/gi, "zhixue_session=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]");
}

function execute(name, args, fileName) {
  const began = Date.now();
  const result = spawnSync(process.execPath, [name, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test", NO_COLOR: "1" },
    timeout: 180000,
  });
  const output = sanitize((result.stdout || "") + (result.stderr || ""));
  const record = {
    command: [process.execPath, name, ...args].map((item) => relative(ROOT, item).split(sep).join("/") || item).join(" "),
    exitCode: result.status ?? 1,
    durationMs: Date.now() - began,
    output,
  };
  return writeFile(resolve(commandDir, fileName), [
    `command: ${record.command}`,
    `exitCode: ${record.exitCode}`,
    `durationMs: ${record.durationMs}`,
    "",
    output,
  ].join("\n"), "utf8").then(() => record);
}

const commands = {};
commands.tests = await execute("scripts/run-tests.mjs", [], "tests.txt");
commands.skills = await execute("scripts/verify-skills.cjs", [], "skills.txt");
commands.syntax = await execute("scripts/run-static-checks.mjs", [], "syntax.txt");
commands.publicSafety = await execute("scripts/check-public-safety.mjs", [], "public-safety.txt");

function metric(output, label) {
  const match = output.match(new RegExp(`(?:^|\\n)[ℹ# ]*${label}\\s+(\\d+)`, "i"));
  return match ? Number(match[1]) : 0;
}
const testMetrics = {
  total: metric(commands.tests.output, "tests"),
  passed: metric(commands.tests.output, "pass"),
  failed: metric(commands.tests.output, "fail"),
  skipped: metric(commands.tests.output, "skipped"),
  todo: metric(commands.tests.output, "todo"),
};
const skillMatch = commands.skills.output.match(/(\d+)\/(\d+)\s+passed/i);
const skillMetrics = {
  passed: skillMatch ? Number(skillMatch[1]) : 0,
  total: skillMatch ? Number(skillMatch[2]) : 0,
  failed: skillMatch ? Number(skillMatch[2]) - Number(skillMatch[1]) : 1,
};
const automatedPass = Object.values(commands).every((item) => item.exitCode === 0)
  && testMetrics.failed === 0 && testMetrics.skipped === 0 && testMetrics.todo === 0
  && skillMetrics.failed === 0;

const matrix = JSON.parse(await readFile(MATRIX_PATH, "utf8"));
let manualResults = { results: [] };
try { manualResults = JSON.parse(await readFile(MANUAL_PATH, "utf8")); } catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const manualById = new Map((manualResults.results || []).map((item) => [item.id, item]));
const finishedAt = new Date();
const items = matrix.items.map((item) => {
  if (item.method === "automated") {
    const result = automatedPass ? "pass" : "fail";
    return {
      ...item,
      lastRunResult: result,
      lastRunAt: finishedAt.toISOString(),
      evidenceRefs: [
        `evidence/m6/${runId}/commands/tests.txt`,
        `evidence/m6/${runId}/commands/skills.txt`,
        `evidence/m6/${runId}/commands/syntax.txt`,
        `evidence/m6/${runId}/commands/public-safety.txt`,
      ],
    };
  }
  const manual = manualById.get(item.id);
  const verified = item.coverageStatus === "人工已验证" && manual?.result === "pass";
  return {
    ...item,
    lastRunResult: verified ? "pass" : manual?.result === "fail" ? "fail" : manual?.result === "blocked" ? "blocked" : "not_run",
    lastRunAt: manual?.verifiedAt || null,
    evidenceRefs: verified ? [`evidence/m6/${runId}/manual/checklist.md`] : [],
    manualNotes: manual?.notes || "",
  };
});
const baselineAfter = await hash(BASELINE_PATH);
const counts = items.reduce((acc, item) => {
  acc[item.lastRunResult] = (acc[item.lastRunResult] || 0) + 1;
  return acc;
}, { pass: 0, fail: 0, not_run: 0, blocked: 0 });
const environment = {
  runId,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  projectVersion: JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8")).version,
  gitCommit,
  networkPolicy: "offline-only",
  baselineDb: {
    path: "data/zhixue_demo.sqlite",
    sha256Before: baselineBefore,
    sha256After: baselineAfter,
    unchanged: baselineBefore === baselineAfter,
  },
  testMetrics,
  skillMetrics,
  commandExitCodes: Object.fromEntries(Object.entries(commands).map(([key, value]) => [key, value.exitCode])),
};
const results = {
  schemaVersion: 1,
  runId,
  generatedAt: finishedAt.toISOString(),
  automatedPass,
  baselineUnchanged: baselineBefore === baselineAfter,
  counts,
  items,
};

const manualValue = (value, fallback = "未记录") =>
  String(value || fallback).replace(/\r?\n/g, " ");
const manualLines = [
  `# M6 人工验收清单（${runId}）`,
  "",
  "本文件由受控的 manual-acceptance-results.json 投影生成；自动脚本不会把人工项改为 pass。",
  "",
  ...items.filter((item) => item.method === "manual").flatMap((item) => {
    const manual = manualById.get(item.id) || {};
    return [
      `## ${item.id} · ${item.title}`,
      `- 时间：${manualValue(item.lastRunAt)}`,
      `- 浏览器 A：${manualValue(manual.browserA)}`,
      `- 浏览器 B：${manualValue(manual.browserB)}`,
      `- 操作：${manualValue(manual.operation)}`,
      `- 预期：${manualValue(manual.expected)}`,
      `- 实际：${manualValue(manual.actual)}`,
      `- 结果：${item.lastRunResult}`,
      `- 证据备注：${manualValue(manual.notes, "尚未执行")}`,
      "",
    ];
  }),
  "",
];
const summary = [
  `# M6 验收摘要（${runId}）`,
  "",
  `- 代码：${gitCommit}`,
  `- Node：${process.version} / ${process.platform} ${process.arch}`,
  `- 自动化门禁：${automatedPass ? "PASS" : "FAIL"}`,
  `- Node tests：${testMetrics.passed}/${testMetrics.total}，fail ${testMetrics.failed}，skip ${testMetrics.skipped}，todo ${testMetrics.todo}`,
  `- Skills：${skillMetrics.passed}/${skillMetrics.total}`,
  `- Matrix：pass ${counts.pass} / fail ${counts.fail} / not_run ${counts.not_run} / blocked ${counts.blocked}`,
  `- Baseline SQLite：${baselineBefore === baselineAfter ? "哈希一致" : "哈希变化（失败）"}`,
  "- 网络：未使用；fixtures 为本地合成数据",
  "",
  "详细结果见 acceptance-results.json；命令日志已脱敏并位于 commands/。",
  "",
].join("\n");

await Promise.all([
  writeFile(resolve(runDir, "environment.json"), JSON.stringify(environment, null, 2) + "\n", "utf8"),
  writeFile(resolve(runDir, "acceptance-results.json"), JSON.stringify(results, null, 2) + "\n", "utf8"),
  writeFile(resolve(runDir, "summary.md"), summary, "utf8"),
  writeFile(resolve(manualDir, "checklist.md"), manualLines.join("\n"), "utf8"),
  writeFile(resolve(EVIDENCE_ROOT, "LATEST.txt"), runId + "\n", "utf8"),
]);
console.log(`[M6] evidence/m6/${runId}`);
console.log(`[M6] auto=${automatedPass ? "PASS" : "FAIL"} matrix=${JSON.stringify(counts)} baseline=${baselineBefore === baselineAfter ? "UNCHANGED" : "CHANGED"}`);
if (!automatedPass || baselineBefore !== baselineAfter) process.exitCode = 1;
