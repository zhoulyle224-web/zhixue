import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_TARGET = resolve(PROJECT_ROOT, "release", "智学双擎_参赛提交版");
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".html",
  ".css", ".yaml", ".yml", ".sql", ".py", ".ps1", ".sh", ".bat", ".csv",
]);

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const target = resolve(option("target") || DEFAULT_TARGET);
const jsonOut = option("json-out") ? resolve(option("json-out")) : null;
const archive = option("archive") ? resolve(option("archive")) : null;
const runSmoke = process.argv.includes("--smoke");

function posix(path) {
  return path.split(sep).join("/");
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function filesUnder(root) {
  const result = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) result.push(full);
    }
  }
  if (await exists(root)) await walk(root);
  return result;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function decodeTerms(config) {
  return Object.fromEntries(
    [...config.schoolTerms, ...config.schoolUrls]
      .map((item) => [item.id, String.fromCodePoint(...item.codePoints)]),
  );
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function scanDatabase(path, terms) {
  const db = new DatabaseSync(path, { readOnly: true });
  const hits = [];
  let scannedTextColumns = 0;
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    for (const { name } of tables) {
      const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all()
        .filter((column) => /TEXT|CHAR|CLOB/i.test(String(column.type || "")));
      for (const column of columns) {
        scannedTextColumns += 1;
        for (const [id, term] of Object.entries(terms)) {
          const row = db.prepare(
            `SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)} ` +
            `WHERE instr(lower(CAST(${quoteIdentifier(column.name)} AS TEXT)), lower(?)) > 0`,
          ).get(term);
          if (Number(row.count)) hits.push({ table: name, column: column.name, termId: id, count: Number(row.count) });
        }
      }
    }
  } finally {
    db.close();
  }
  return { scannedTextColumns, hits };
}

function makeResult(id, title, status, detail) {
  return { id, title, status, detail };
}

async function runCleanSmoke() {
  const workspace = await mkdtemp(join(tmpdir(), "zhixue-m7-smoke-"));
  const runtimeDbPath = join(workspace, "runtime.sqlite");
  const stagingRuntimePath = join(target, "data", "runtime");
  const stagingRuntimeExisted = await exists(stagingRuntimePath);
  const module = await import(`${pathToFileURL(join(target, "server", "local-api.mjs")).href}?m7=${Date.now()}`);
  const server = module.createZhixueServer({ runtimeDbPath });
  let base;
  async function call(auth, path, { method = "GET", body } = {}) {
    const headers = new Headers();
    if (auth?.cookie) headers.set("cookie", auth.cookie);
    if (body !== undefined) headers.set("content-type", "application/json");
    if (auth?.csrf && !["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("x-csrf-token", auth.csrf);
    const response = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let payload = null;
    try { payload = JSON.parse(bytes.toString("utf8")); } catch {}
    return { status: response.status, body: payload, bytes };
  }
  async function login(role) {
    const response = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account: role === "teacher" ? "teacher2026" : "student2026",
        password: "demo123",
        requestedRole: role,
        rememberLogin: true,
      }),
    });
    const payload = await response.json();
    if (response.status !== 200) throw new Error(`${role} login returned ${response.status}`);
    return {
      cookie: (response.headers.get("set-cookie") || "").split(";")[0],
      csrf: payload.data.csrfToken,
    };
  }
  const smoke = {
    generatedAt: new Date().toISOString(),
    runtime: "temporary-runtime-sqlite",
    network: "loopback-only",
    results: {},
  };
  try {
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    base = `http://127.0.0.1:${server.address().port}`;
    smoke.results.start = "pass";
    smoke.results.health = (await call(null, "/api/health")).status === 200 ? "pass" : "fail";
    const teacher = await login("teacher");
    const student = await login("student");
    smoke.results.teacherLogin = "pass";
    smoke.results.studentLogin = "pass";

    const qa = await call(student, "/api/qa", {
      method: "POST",
      body: {
        studentContext: "student:S240101",
        offeringId: 7,
        question: "什么是机器学习？",
        clientRequestId: randomUUID(),
      },
    });
    smoke.results.m1 = qa.status === 200 && ["answered", "pending_teacher", "teacher_replied"].includes(qa.body?.data?.status)
      ? "pass" : "fail";

    const csv = await readFile(join(target, "tests", "fixtures", "m3", "publishable-ai201.csv"), "utf8");
    const imported = await call(teacher, "/api/import/validate", {
      method: "POST",
      body: { context: "teacher:7:1", fileName: "publishable-ai201.csv", content: csv },
    });
    const batchId = imported.body?.data?.batch?.batchId;
    const confirmed = await call(teacher, `/api/import/${batchId}/confirm`, {
      method: "POST",
      body: { context: "teacher:7:1" },
    });
    const analyzed = await call(teacher, "/api/analyze", {
      method: "POST",
      body: { context: "teacher:7:1", batchId },
    });
    smoke.results.m2 = imported.status === 200 && confirmed.status === 200 && analyzed.status === 200 ? "pass" : "fail";

    const drafted = await call(teacher, "/api/tasks/drafts", {
      method: "POST",
      body: { context: "teacher:7:1", analysisRunId: analyzed.body?.analysisRunId },
    });
    const versionId = drafted.body?.data?.versionId;
    const saved = await call(teacher, `/api/tasks/drafts/${versionId}`, {
      method: "PUT",
      body: {
        context: "teacher:7:1",
        dueAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        tasks: drafted.body?.data?.tasks,
      },
    });
    const published = await call(teacher, `/api/tasks/drafts/${versionId}/publish`, {
      method: "POST",
      body: { context: "teacher:7:1", clientRequestId: randomUUID() },
    });
    const studentTasks = await call(student, "/api/tasks/student?studentContext=student%3AS240101&offeringId=7");
    smoke.results.m3 = drafted.status === 200 && saved.status === 200 && published.status === 200 &&
      studentTasks.status === 200 && studentTasks.body?.data?.activeAssignments?.length > 0 ? "pass" : "fail";

    const exported = await call(teacher, "/api/export", {
      method: "POST",
      body: { kind: "report", format: "json", scope: { context: "teacher:7:1" } },
    });
    smoke.results.m5 = exported.status === 200 && exported.bytes.length > 0 ? "pass" : "fail";
    smoke.results.staticSecurity = (await call(null, "/data/zhixue_demo.sqlite")).status === 404 ? "pass" : "fail";
  } finally {
    await new Promise((done) => server.close(done));
    await rm(workspace, { recursive: true, force: true });
    if (!stagingRuntimeExisted) {
      await rm(stagingRuntimePath, { recursive: true, force: true });
    }
  }
  const evidencePath = join(target, "release-evidence", "clean-smoke-results.json");
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(smoke, null, 2) + "\n", "utf8");
  return smoke;
}

async function main() {
  if (!(await exists(target))) throw new Error(`提交目录不存在：${target}`);
  const allFiles = await filesUnder(target);
  const relFiles = allFiles.map((file) => posix(relative(target, file)));
  const textFiles = allFiles.filter((file) => TEXT_EXTENSIONS.has(extname(file).toLowerCase()));
  const termConfig = JSON.parse(await readFile(join(target, "scripts", "submission-forbidden-terms.json"), "utf8"));
  const terms = decodeTerms(termConfig);
  const textEntries = [];
  for (const file of textFiles) textEntries.push({ file, rel: posix(relative(target, file)), text: await readFile(file, "utf8") });
  const joinedText = textEntries.map((entry) => entry.text).join("\n");
  const results = [];
  const set = (number, title, status, detail) => results.push(makeResult(`M7-T${String(number).padStart(2, "0")}`, title, status, detail));

  const latestPath = join(target, "evidence", "m6", "LATEST.txt");
  const runId = (await exists(latestPath)) ? (await readFile(latestPath, "utf8")).trim() : "";
  const evidenceDir = join(target, "evidence", "m6", runId);
  const acceptancePath = join(evidenceDir, "acceptance-results.json");
  const environmentPath = join(evidenceDir, "environment.json");
  const summaryPath = join(evidenceDir, "summary.md");
  const hasEvidence = Boolean(runId) && await exists(acceptancePath) && await exists(environmentPath) && await exists(summaryPath);
  set(1, "M6 final run 存在", hasEvidence ? "pass" : "fail", runId || "LATEST.txt 缺失");
  const acceptance = hasEvidence ? JSON.parse(await readFile(acceptancePath, "utf8")) : null;
  const environment = hasEvidence ? JSON.parse(await readFile(environmentPath, "utf8")) : null;
  set(2, "M6 final summary 无 blocking fail", acceptance?.automatedPass && acceptance?.counts?.fail === 0 ? "pass" : "fail",
    acceptance ? `automatedPass=${acceptance.automatedPass}, fail=${acceptance.counts.fail}` : "evidence unavailable");
  const blockedManual = acceptance?.items?.filter((item) => item.method === "manual" && item.lastRunResult !== "pass") || [];
  set(3, "M6 必需 manual 全 pass", blockedManual.length === 0 ? "pass" : "blocked",
    blockedManual.length ? blockedManual.map((item) => item.id).join(", ") : "all pass");

  const baselinePath = join(target, "data", "zhixue_demo.sqlite");
  const baselineHash = await exists(baselinePath) ? await sha256(baselinePath) : "";
  const expectedBaselineHash = environment?.baselineDb?.sha256After || "";
  set(4, "baseline DB hash 与 M6 一致", baselineHash && baselineHash === expectedBaselineHash ? "pass" : "fail",
    `${baselineHash || "missing"} / expected ${expectedBaselineHash || "missing"}`);
  const runtimeDb = relFiles.filter((name) => /(^|\/)data\/runtime\/.*\.sqlite$/i.test(name));
  set(5, "无 runtime DB", runtimeDb.length ? "fail" : "pass", runtimeDb.join(", ") || "none");
  const walShm = relFiles.filter((name) => /\.sqlite-(?:wal|shm)$/i.test(name));
  set(6, "无 WAL/SHM", walShm.length ? "fail" : "pass", walShm.join(", ") || "none");
  const runtimeArtifacts = relFiles.filter((name) => /(^|\/)(?:audit\.jsonl|server\.json|[^/]+\.log)$/i.test(name));
  set(7, "无 Session/audit/log", runtimeArtifacts.length ? "fail" : "pass", runtimeArtifacts.join(", ") || "none");
  const envFiles = relFiles.filter((name) => /(^|\/)\.env(?:\..+)?$/i.test(name) && !/\.env\.example$/i.test(name));
  set(8, "无真实 .env", envFiles.length ? "fail" : "pass", envFiles.join(", ") || "none");

  const secretPatterns = [
    { id: "private-key", pattern: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/gi },
    { id: "session-cookie-value", pattern: /zhixue_session=[A-Za-z0-9._~-]{16,}/gi },
    { id: "api-key-value", pattern: /api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9._~-]{20,}/gi },
    { id: "bearer-value", pattern: /authorization\s*:\s*bearer\s+[A-Za-z0-9._~-]{16,}/gi },
    { id: "token-query-value", pattern: /token=[A-Za-z0-9._~-]{20,}/gi },
  ];
  const secretHits = [];
  for (const entry of textEntries) for (const item of secretPatterns) {
    item.pattern.lastIndex = 0;
    if (item.pattern.test(entry.text)) secretHits.push({ file: entry.rel, pattern: item.id });
  }
  set(9, "无 secret patterns", secretHits.length ? "fail" : "pass", secretHits.length ? JSON.stringify(secretHits) : "none");

  const schoolHits = [];
  const schoolUrlHits = [];
  for (const entry of textEntries) {
    if (entry.rel === "scripts/submission-forbidden-terms.json") continue;
    for (const [id, term] of Object.entries(terms)) {
      if (!entry.text.toLowerCase().includes(term.toLowerCase())) continue;
      const hit = { file: entry.rel, termId: id };
      if (id.includes("url")) schoolUrlHits.push(hit); else schoolHits.push(hit);
    }
  }
  const dbScan = await exists(baselinePath) ? scanDatabase(baselinePath, terms) : { scannedTextColumns: 0, hits: [] };
  for (const hit of dbScan.hits) {
    if (hit.termId.includes("url")) schoolUrlHits.push({ file: "data/zhixue_demo.sqlite", ...hit });
    else schoolHits.push({ file: "data/zhixue_demo.sqlite", ...hit });
  }
  set(10, "无已知学校名称", schoolHits.length ? "fail" : "pass", schoolHits.length ? JSON.stringify(schoolHits) : "none");
  set(11, "无已知学校 URL", schoolUrlHits.length ? "fail" : "pass", schoolUrlHits.length ? JSON.stringify(schoolUrlHits) : "none");
  const dataReadme = await readFile(join(target, "data", "README.md"), "utf8");
  set(12, "data README 已中性化", Object.values(terms).some((term) => dataReadme.toLowerCase().includes(term.toLowerCase())) ? "fail" : "pass",
    "specific school references absent");

  const publicSafety = spawnSync(process.execPath, ["scripts/check-public-safety.mjs"], { cwd: target, encoding: "utf8" });
  set(13, "公开 static assets 无 actor/secret snapshot", publicSafety.status === 0 ? "pass" : "fail",
    publicSafety.status === 0 ? publicSafety.stdout.trim().split(/\r?\n/).at(-1) : publicSafety.stderr.trim());
  set(14, "无嵌套旧 deploy ZIP", relFiles.some((name) => basename(name).toLowerCase() === "deploy-zhixue.zip") ? "fail" : "pass", "checked filenames");

  const readme = await readFile(join(target, "README.md"), "utf8");
  const deployment = await readFile(join(target, "docs", "部署手册.md"), "utf8");
  const ppt = await readFile(join(target, "docs", "PPT大纲.md"), "utf8");
  const video = await readFile(join(target, "docs", "演示视频脚本.md"), "utf8");
  const matrix = await readFile(join(target, "docs", "评分证据矩阵.md"), "utf8");
  set(15, "README 核心命令存在", ["node server/local-api.mjs", "npm test", "scripts/prepare-submission.mjs"].every((value) => readme.includes(value)) ? "pass" : "fail", "startup/test/release commands");
  const coreRoutes = ["/api/auth/login", "/api/auth/me", "/api/catalog", "/api/dashboard", "/api/qa", "/api/import/", "/api/analyze", "/api/tasks/", "/api/export", "/api/skills"];
  set(16, "README 接口与服务匹配", coreRoutes.every((route) => readme.includes(route)) ? "pass" : "fail", "core route list");
  set(17, "README 无旧 auth 文案", readme.includes("当前登录为前端演示认证") ? "fail" : "pass", "server Session wording checked");
  set(18, "README 无旧 export GET 文案", /`\/api\/export`\s*\|\s*GET/i.test(readme) ? "fail" : "pass", "POST contract checked");
  set(19, "部署手册无旧 auth/export 文案", /当前登录为前端演示认证|`\/api\/export`\s*\|\s*GET/i.test(deployment) ? "fail" : "pass", "current contract checked");
  set(20, "PPT 无旧固定 8/17/11", /8\s*[\/：:]\s*17\s*[\/：:]\s*11/.test(ppt) ? "fail" : "pass", "final fixture is 3/5/2");
  set(21, "PPT 测试数字来自 M6 final", ppt.includes(runId) && ppt.includes("175/175") && ppt.includes("26/26") ? "pass" : "fail", runId);
  set(22, "视频测试数字来自 M6 final", video.includes(runId) && video.includes("175/175") && video.includes("26/26") ? "pass" : "fail", runId);
  set(23, "视频不声称真实试点", /已在.{0,12}(?:真实|正式).{0,8}(?:学校|院校|试点)/.test(video) ? "fail" : "pass", "synthetic-demo wording");
  set(24, "PPT 不声称真实试点", /已在.{0,12}(?:真实|正式).{0,8}(?:学校|院校|试点)/.test(ppt) ? "fail" : "pass", "synthetic-demo wording");
  const platformText = `${readme}\n${ppt}\n${video}`;
  const unsafePlatformClaim = /(?:已接入|正在使用).{0,12}帝王蟹|(?:正在|已)实时调用帝王蟹|帝王蟹.{0,12}(?:正在|已)实时运行/.test(platformText);
  set(25, "帝王蟹表述符合证据", platformText.includes("帝王蟹") && platformText.includes("参照帝王蟹 Skill 规范") && !unsafePlatformClaim ? "pass" : "fail", "no live platform claim");
  const unsafeOpenClawClaim = /(?:正在|已)实时.{0,12}OpenClaw|OpenClaw.{0,12}(?:正在|已)实时/.test(platformText);
  set(26, "OpenClaw 表述符合实际", unsafeOpenClawClaim ? "fail" : "pass", "semantic-compatible config only");
  set(27, "PDF 表述准确", /服务端(?:原生)?\s*PDF\s*(?:导出|生成|服务)/.test(platformText) ? "fail" : "pass", "print HTML / browser save-as-PDF");
  set(28, "Excel 表述准确", /原生\s*XLSX\s*(?:导出|生成|文件)/.test(platformText) ? "fail" : "pass", "SpreadsheetML .xls");
  set(29, "README/PPT/视频场景一致", [readme, ppt, video].every((value) => value.includes("两个核心场景")) ? "pass" : "fail", "two core scenarios");
  const scoreLabels = ["场景适配性", "功能实用性", "操作便捷性", "代码规范性", "异常处理能力", "文档完整性"];
  set(30, "评分证据矩阵六项齐全", scoreLabels.every((label) => matrix.includes(label)) && ["30", "25", "15", "10", "5"].every((n) => matrix.includes(`| ${n} |`)) ? "pass" : "fail", scoreLabels.join(", "));
  set(31, "每个评分项有 M6 evidence ref", scoreLabels.every((label) => matrix.split(/\r?\n/).some((line) => line.includes(label) && line.includes(runId))) ? "pass" : "fail", runId);
  set(32, "每个评分项有现场可见证据", scoreLabels.every((label) => matrix.split(/\r?\n/).some((line) => line.includes(label) && !line.includes("待补现场证据"))) ? "pass" : "fail", "matrix rows inspected");

  const manifestPath = join(target, "release-manifest.json");
  const manifest = await exists(manifestPath) ? JSON.parse(await readFile(manifestPath, "utf8")) : null;
  set(33, "release manifest 存在", manifest ? "pass" : "fail", posix(relative(target, manifestPath)));
  set(34, "manifest M6 run 一致", manifest?.m6FinalRunId === runId ? "pass" : "fail", `${manifest?.m6FinalRunId || "missing"} / ${runId}`);
  set(35, "manifest 排除 runtime DB", manifest?.runtimeDbIncluded === false ? "pass" : "fail", `runtimeDbIncluded=${manifest?.runtimeDbIncluded}`);

  let smoke = null;
  if (runSmoke) smoke = await runCleanSmoke();
  const smokePath = join(target, "release-evidence", "clean-smoke-results.json");
  if (!smoke && await exists(smokePath)) smoke = JSON.parse(await readFile(smokePath, "utf8"));
  const smokeMap = [
    [36, "clean staging 启动", "start"], [37, "clean staging health", "health"],
    [38, "clean staging teacher login", "teacherLogin"], [39, "clean staging student login", "studentLogin"],
    [40, "clean staging M1 smoke", "m1"], [41, "clean staging M2 smoke", "m2"],
    [42, "clean staging M3 smoke", "m3"], [43, "clean staging M5 smoke", "m5"],
    [44, "clean staging static DB 404", "staticSecurity"],
  ];
  for (const [number, title, key] of smokeMap) set(number, title, smoke?.results?.[key] === "pass" ? "pass" : "fail", smoke?.results?.[key] || "missing smoke evidence");

  const localPathHits = [];
  for (const entry of textEntries) if (/C:\\Users\\|\/home\/[^\s/]+|\/mnt\/data/.test(entry.text)) localPathHits.push(entry.rel);
  set(45, "无工作区外文件引用", localPathHits.length ? "fail" : "pass", localPathHits.join(", ") || "none");
  const brokenLinks = [];
  for (const entry of textEntries.filter((item) => item.rel.endsWith(".md"))) {
    for (const match of entry.text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const href = match[1].trim().replace(/^<|>$/g, "").split("#")[0];
      if (!href || /^(?:https?:|mailto:|#)/i.test(href)) continue;
      const resolved = resolve(dirname(entry.file), decodeURIComponent(href));
      if (!resolved.startsWith(target) || !(await exists(resolved))) brokenLinks.push({ file: entry.rel, href });
    }
  }
  set(46, "所有相对路径有效", brokenLinks.length ? "fail" : "pass", brokenLinks.length ? JSON.stringify(brokenLinks) : "none");
  const badNames = relFiles.filter((name) => Object.values(terms).some((term) => name.toLowerCase().includes(term.toLowerCase())));
  set(47, "正式文件名无学校信息", badNames.length ? "fail" : "pass", badNames.join(", ") || "none");

  let archiveDetail = "archive not supplied";
  let archiveStatus = "not_ready";
  if (archive && await exists(archive)) {
    const sumsPath = join(dirname(archive), "SHA256SUMS");
    const digest = await sha256(archive);
    const sums = await exists(sumsPath) ? await readFile(sumsPath, "utf8") : "";
    archiveStatus = sums.includes(digest) && sums.includes(basename(archive)) ? "pass" : "fail";
    archiveDetail = `${basename(archive)} ${digest}`;
  }
  set(48, "最终 ZIP/hash", archiveStatus, archiveDetail);
  const pptx = relFiles.filter((name) => name.toLowerCase().endsWith(".pptx"));
  set(49, "最终 PPT 二进制", pptx.length ? "blocked" : "not_ready", pptx.length ? "requires manual open inspection" : "no .pptx in submission");
  const videos = relFiles.filter((name) => /\.(?:mp4|mov|mkv)$/i.test(name));
  set(50, "最终视频", videos.length ? "blocked" : "not_ready", videos.length ? "requires full manual playback" : "no video in submission");

  const counts = results.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {});
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: posix(relative(PROJECT_ROOT, target)) || ".",
    status: results.some((item) => item.status === "fail") ? "not_ready" :
      results.some((item) => ["blocked", "not_ready"].includes(item.status)) ? "blocked" : "ready",
    m6FinalRunId: runId,
    scannedFiles: allFiles.length,
    scannedTextFiles: textFiles.length,
    scannedDbTextColumns: dbScan.scannedTextColumns,
    externalUrlsForManualReview: [...new Set(
      textEntries.flatMap((entry) => [...entry.text.matchAll(/https?:\/\/[^\s)>'"`]+/gi)].map((match) => match[0]))
        .filter((url) => !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/i.test(url)),
    )].sort(),
    counts,
    results,
  };
  if (jsonOut) {
    await mkdir(dirname(jsonOut), { recursive: true });
    await writeFile(jsonOut, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "not_ready") process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[M7] submission check failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
