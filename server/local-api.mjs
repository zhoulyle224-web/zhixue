import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { buildAnalysisInput, ImportError, SKILL_ID, SKILL_VERSION, validateImport } from "./import-service.mjs";
import { createRuntimeStore } from "./runtime-store.mjs";
import { answerQa, getQaHistory, getQaInbox, getQaResources, QaError, replyQa } from "./qa-service.mjs";
import { createTaskService, TaskError } from "./task-service.mjs";

const require = createRequire(import.meta.url);
const { loadZhixueSkills } = require("./skill-runtime.cjs");

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const ASSETS_ROOT = resolve(ROOT, "assets");
const DATA_ROOT = resolve(ROOT, "data");
const DATABASE_PATH = resolve(DATA_ROOT, "zhixue_demo.sqlite");
const READ_MODEL_PATH = resolve(ASSETS_ROOT, "demo-data.json");
const AUDIT_PATH = resolve(DATA_ROOT, "runtime", "audit.jsonl");
const SKILL_ROOT = resolve(ASSETS_ROOT, "skills");

const PUBLIC_PAGES = new Set([
  "index.html",
  "login.html",
  "teacher.html",
  "student.html",
  "404.html",
]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const EXPORT_KINDS = new Set(["report", "questions", "review"]);
const EXPORT_FORMATS = new Set(["json", "csv", "excel", "print"]);
const SENSITIVE_KEY = /^(display_name|student_name|teacher_name|class_name|student_no|student_id|teacher_id|email|phone|mobile|id_card|gender|address)$/i;
const PROMPT_INJECTION = [
  /忽略(以上|之前|全部).*(指令|规则)/i,
  /泄露.*(系统提示|密钥|密码)/i,
  /输出.*(系统提示|开发者消息|隐藏规则)/i,
  /ignore (all )?(previous|above) instructions/i,
  /reveal.*(system prompt|secret|password)/i,
];

const skills = loadZhixueSkills(SKILL_ROOT);
let database;
let readModel;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? "public, max-age=30" : "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function text(body, status, contentType, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function openDatabase() {
  if (!database) {
    database = new DatabaseSync(DATABASE_PATH, { readOnly: true });
  }
  return database;
}

async function getReadModel() {
  if (!readModel) {
    readModel = JSON.parse(await readFile(READ_MODEL_PATH, "utf8"));
  }
  return readModel;
}

function cleanText(value, maxLength = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim()
    .slice(0, maxLength);
}

function redactText(value) {
  return cleanText(value, 2000)
    .replace(/1[3-9]\d{9}/g, "手机号已脱敏")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "邮箱已脱敏")
    .replace(/\b\d{17}[\dXx]\b/g, "证件号已脱敏")
    .replace(/\bS\d{6,}\b/gi, "匿名学生");
}

function redactValue(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[已脱敏]";
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, childKey),
      ]),
    );
  }
  return value;
}

function validateContext(audience, context) {
  if (audience === "teacher") return /^teacher:\d+:\d+$/.test(context);
  if (audience === "student") return /^student:S\d{6,}$/.test(context);
  return false;
}

function validateRequestContext(role, context) {
  if (role === "teacher") return /^teacher:\d+:\d+$/.test(context);
  if (role === "student") return /^student:S\d{6,}$/.test(context);
  return false;
}

async function readJsonBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("请求体过大");
      error.code = "PAYLOAD_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("JSON 格式错误");
    error.code = "INVALID_JSON";
    throw error;
  }
}

async function recordAudit(event) {
  try {
    await mkdir(resolve(DATA_ROOT, "runtime"), { recursive: true });
    await appendFile(
      AUDIT_PATH,
      `${JSON.stringify({
        occurredAt: new Date().toISOString(),
        ...event,
      })}\n`,
      "utf8",
    );
  } catch (error) {
    console.error("审计日志写入失败：", error.message);
  }
}

function flattenRows(payload, prefix = "") {
  const rows = [];
  function visit(value, pathParts) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...pathParts, String(index + 1)]));
      return;
    }
    if (value && typeof value === "object") {
      Object.entries(value).forEach(([key, child]) => visit(child, [...pathParts, key]));
      return;
    }
    rows.push({
      path: prefix ? `${prefix}.${pathParts.join(".")}` : pathParts.join("."),
      value: value === null || value === undefined ? "" : String(value),
    });
  }
  visit(payload, []);
  return rows;
}

function csvCell(value) {
  const textValue = String(value ?? "");
  return /[",\r\n]/.test(textValue)
    ? `"${textValue.replaceAll('"', '""')}"`
    : textValue;
}

function toCsv(payload) {
  const rows = flattenRows(payload);
  const lines = ["字段,值", ...rows.map((row) => `${csvCell(row.path)},${csvCell(row.value)}`)];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function toExcelXml(payload) {
  const rows = flattenRows(payload);
  const cells = rows
    .map(
      (row) =>
        `<Row><Cell><Data ss:Type="String">${escapeXml(row.path)}</Data></Cell>` +
        `<Cell><Data ss:Type="String">${escapeXml(row.value)}</Data></Cell></Row>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="智学双擎导出"><Table>${cells}</Table></Worksheet>
</Workbook>`;
}

function buildPrintHtml(title, payload) {
  const rows = flattenRows(payload)
    .map(
      (row) =>
        `<tr><th>${escapeXml(row.path)}</th><td>${escapeXml(row.value)}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeXml(
    title,
  )}</title><style>
body{font-family:"Microsoft YaHei",sans-serif;padding:32px;color:#14213d}
h1{font-size:22px}table{width:100%;border-collapse:collapse}th,td{padding:8px;border:1px solid #cbd5e1;text-align:left;vertical-align:top}
th{width:32%;background:#f1f5f9}.watermark{position:fixed;inset:45% auto auto 10%;transform:rotate(-24deg);font-size:48px;color:rgba(37,99,235,.09);pointer-events:none}
@media print{.no-print{display:none}}@media(max-width:700px){body{padding:16px}th{width:42%}}
</style><body><button class="no-print" onclick="print()">打印或另存为 PDF</button><h1>${escapeXml(
    title,
  )}</h1><p>导出时间：${new Date().toLocaleString("zh-CN")}</p><table>${rows}</table><div class="watermark">智学双擎内部使用</div></body></html>`;
}

async function getExportPayload(kind, context) {
  const model = await getReadModel();
  if (context.startsWith("student:")) {
    const student = model.student?.[context];
    if (!student) return null;
    if (kind === "report" || kind === "review") {
      return {
        kind,
        context,
        courseProfile: student,
      };
    }
    return {
      kind,
      context,
      questions: (student.courses || []).flatMap((course) =>
        (course.qa || []).map((item) => ({
          course: course.course_name,
          ...item,
        })),
      ),
    };
  }
  const teacher = model.teacher?.[context];
  if (!teacher) return null;
  if (kind === "questions") {
    return {
      kind,
      context,
      course: teacher.course_name,
      className: teacher.class_name,
      hotTopics: teacher.hotTopics,
    };
  }
  return {
    kind,
    context,
    teacherDashboard: teacher,
  };
}

function apiError(error) {
  return json({
    success: false,
    code: error.code || "INVALID_REQUEST",
    message: error.message,
    ...(error.details || {}),
  }, error.status || (error.code === "PAYLOAD_TOO_LARGE" ? 413 : 400));
}

function teacherContext(context) {
  return /^teacher:\d+:\d+$/.test(context);
}

async function handleApi(request, url, runtimeStore, taskService) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    const db = openDatabase();
    const integrity = db.prepare("PRAGMA quick_check").get();
    const studentCount = db.prepare("SELECT COUNT(*) AS count FROM students").get().count;
    const model = await getReadModel();
    return json({
      success: true,
      mode: "local",
      database: "sqlite",
      syntheticData: true,
      integrity: Object.values(integrity)[0],
      studentCount,
      sourceVersion: model.meta.sourceVersion,
      services: {
        skills: "ready",
        sqlite: "ready",
        network: "not_required",
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/api/catalog") {
    const model = await getReadModel();
    return json({
      success: true,
      source: "sqlite_read_model",
      sourceVersion: model.meta.sourceVersion,
      updatedAt: model.meta.generatedAt,
      data: {
        meta: model.meta,
        catalog: model.catalog,
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    const audience = cleanText(url.searchParams.get("audience"), 20);
    const context = cleanText(url.searchParams.get("context"), 80);
    if (!validateContext(audience, context)) {
      return json(
        {
          success: false,
          code: "INVALID_CONTEXT",
          message: "课程或班级上下文不合法，请重新选择后再试。",
        },
        400,
      );
    }
    const model = await getReadModel();
    const data = model[audience]?.[context];
    if (!data) {
      return json(
        {
          success: false,
          code: "DASHBOARD_NOT_FOUND",
          message: "没有找到对应的脱敏学情快照。",
        },
        404,
      );
    }
    await recordAudit({
      actorRole: audience,
      action: "read_dashboard",
      objectType: "dashboard",
      objectRef: context,
      result: "success",
    });
    return json({
      success: true,
      source: "sqlite_read_model",
      sourceVersion: model.meta.sourceVersion,
      updatedAt: model.meta.generatedAt,
      data,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/qa/resources") {
    try {
      const data = await getQaResources(openDatabase(), url.searchParams.get("studentContext"), url.searchParams.get("offeringId"));
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error.code) return apiError(error); throw error; }
  }

  if (request.method === "GET" && url.pathname === "/api/qa/history") {
    try {
      const data = getQaHistory(openDatabase(), runtimeStore, url.searchParams.get("studentContext"), url.searchParams.get("offeringId"), url.searchParams.get("limit"));
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error.code) return apiError(error); throw error; }
  }

  if (request.method === "GET" && url.pathname === "/api/qa/teacher-inbox") {
    try {
      const data = getQaInbox(openDatabase(), runtimeStore, url.searchParams.get("context"), url.searchParams.get("status") || "all", url.searchParams.get("limit"));
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error.code) return apiError(error); throw error; }
  }

  const qaReplyMatch = /^\/api\/qa\/(qa_[0-9a-f-]+)\/reply$/.exec(url.pathname);
  if (request.method === "POST" && qaReplyMatch) {
    try {
      const body = await readJsonBody(request);
      const rawReply = String(body.reply ?? "").trim();
      if (!rawReply) throw new QaError("QA_REPLY_EMPTY", "请填写教师回复。");
      if (rawReply.length > 2000) throw new QaError("QA_REPLY_TOO_LONG", "教师回复不能超过 2000 字。");
      const data = await replyQa({ db: openDatabase(), runtimeStore, questionId: qaReplyMatch[1],
        context: body.context, reply: redactText(rawReply), audit: recordAudit });
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error.code) return apiError(error); throw error; }
  }

  if (request.method === "POST" && url.pathname === "/api/qa") {
    try {
      const body = await readJsonBody(request);
      const question = String(body.question ?? "").trim();
      if (!question) throw new QaError("EMPTY_QUESTION", "请输入需要解答的课程问题。");
      if (question.length > 500) throw new QaError("QUESTION_TOO_LONG", "问题不能超过 500 字。");
      if (PROMPT_INJECTION.some((pattern) => pattern.test(question))) {
        await recordAudit({ actorRole: "student", action: "block_prompt_injection", objectType: "qa", objectRef: "blocked", result: "blocked" });
        throw new QaError("PROMPT_INJECTION_BLOCKED", "问题包含越权指令，已拦截。请改为询问课程知识点。");
      }
      const safeQuestion = redactText(question);
      const data = await answerQa({ db: openDatabase(), runtimeStore, tutor: skills.tutor,
        studentContext: body.studentContext, offeringId: body.offeringId, question: safeQuestion,
        clientRequestId: body.clientRequestId, studentLevel: cleanText(body.studentLevel || "普通", 20),
        piiRedacted: safeQuestion !== question, audit: recordAudit });
      return json({ success: true, source: "local_skill", data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error.code) return apiError(error); throw error; }
  }

  if (request.method === "POST" && url.pathname === "/api/import/validate") {
    try {
      const body = await readJsonBody(request, 24 * 1024 * 1024);
      const context = cleanText(body.context, 80);
      if (!teacherContext(context)) {
        return json({ success: false, code: "INVALID_CONTEXT", message: "请选择有效的教师课程与班级。" }, 400);
      }
      const parsed = validateImport({ context, fileName: body.fileName, content: body.content });
      const batch = runtimeStore.writeBatch(parsed);
      await recordAudit({
        actorRole: "teacher", action: "import_validate", objectType: "import_batch",
        objectRef: batch.batchId, result: "success", context,
        fileSha256: batch.file.sha256, validRows: batch.quality.validRows,
        excludedRows: batch.quality.invalidRows,
      });
      return json({
        success: true, source: "local_import_service", data: {
          ...batch, batch, quality: batch.quality, issues: parsed.issues,
          preview: parsed.preview, issuesTruncated: parsed.issuesTruncated,
        },
      });
    } catch (error) {
      if (error instanceof ImportError || error.code === "INVALID_JSON" || error.code === "PAYLOAD_TOO_LARGE") return apiError(error);
      throw error;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/import/latest") {
    const context = cleanText(url.searchParams.get("context"), 80);
    if (!teacherContext(context)) {
      return json({ success: false, code: "INVALID_CONTEXT", message: "请选择有效的教师课程与班级。" }, 400);
    }
    const batch = runtimeStore.getLatest(context);
    return json({ success: true, usage: "page_restore_only", data: batch ? {
      batch, quality: batch.quality, issues: runtimeStore.getIssues(batch.batchId),
      issuesTruncated: batch.quality.blockingIssueCount + batch.quality.warningIssueCount > 500,
      analysis: batch.status === "confirmed" && batch.confirmedAt ? runtimeStore.getLatestAnalysis(batch.batchId) : null,
    } : null }, 200, { "cache-control": "no-store" });
  }

  const analysisMatch = /^\/api\/analysis\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && analysisMatch) {
    const context = cleanText(url.searchParams.get("context"), 80);
    if (!teacherContext(context)) {
      return json({ success: false, code: "INVALID_CONTEXT", message: "请选择有效的教师课程与班级。" }, 400);
    }
    const analysisRunId = cleanText(analysisMatch[1], 120);
    const run = runtimeStore.getAnalysisRun(analysisRunId);
    if (!run) return json({ success: false, code: "ANALYSIS_NOT_FOUND", message: "研判记录不存在。" }, 404);
    if (run.context !== context) return json({ success: false, code: "ANALYSIS_CONTEXT_MISMATCH", message: "该研判不属于当前班级。" }, 403);
    const batch = runtimeStore.getBatch(run.batchId);
    if (!batch || batch.context !== context || batch.status !== "confirmed" || !batch.confirmedAt || run.status !== "completed") {
      return json({ success: false, code: "ANALYSIS_NOT_COMPLETED", message: "该研判不能作为后续任务来源。" }, 409);
    }
    return json({ success: true, data: {
      analysisRunId: run.analysisRunId, batchId: run.batchId, context: run.context,
      status: run.status, result: run.result, _evidence: run._evidence,
    } }, 200, { "cache-control": "no-store" });
  }

  const confirmMatch = /^\/api\/import\/(b_[0-9a-f-]+)\/confirm$/.exec(url.pathname);
  if (request.method === "POST" && confirmMatch) {
    let body;
    try { body = await readJsonBody(request); } catch (error) { return apiError(error); }
    const context = cleanText(body.context, 80);
    if (!teacherContext(context)) return json({ success: false, code: "INVALID_CONTEXT", message: "请选择有效的教师课程与班级。" }, 400);
    const batch = runtimeStore.getBatch(confirmMatch[1]);
    if (!batch) return json({ success: false, code: "IMPORT_BATCH_NOT_FOUND", message: "导入批次不存在。" }, 404);
    if (batch.context !== context) return json({ success: false, code: "IMPORT_CONTEXT_MISMATCH", message: "该批次不属于当前班级。" }, 403);
    if (batch.quality.validRows < 1) return json({ success: false, code: "IMPORT_NO_VALID_ROWS", message: "没有有效记录可确认。" }, 400);
    if (batch.status !== "validated" && batch.status !== "confirmed") {
      return json({ success: false, code: "IMPORT_BATCH_NOT_CONFIRMABLE", message: "该批次当前不能确认。" }, 409);
    }
    const alreadyConfirmed = batch.status === "confirmed";
    const confirmed = alreadyConfirmed ? batch : runtimeStore.confirmBatch(batch.batchId, context);
    await recordAudit({ actorRole: "teacher", action: "import_confirm", objectType: "import_batch", objectRef: batch.batchId, context, result: "success" });
    return json({ success: true, data: {
      batch: confirmed, batchId: confirmed.batchId, status: confirmed.status,
      alreadyConfirmed,
      validRows: confirmed.quality.validRows, excludedRows: confirmed.quality.invalidRows,
      confirmedAt: confirmed.confirmedAt,
    } });
  }

  if (request.method === "POST" && url.pathname === "/api/analyze") {
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      return json(
        {
          success: false,
          code: error.code || "INVALID_REQUEST",
          message: error.message,
        },
        400,
      );
    }
    if (body.batchId !== undefined) {
      const context = cleanText(body.context, 80);
      if (!teacherContext(context)) return json({ success: false, code: "INVALID_CONTEXT", message: "请选择有效的教师课程与班级。" }, 400);
      const batch = runtimeStore.getBatch(cleanText(body.batchId, 80));
      if (!batch) return json({ success: false, code: "IMPORT_BATCH_NOT_FOUND", message: "导入批次不存在。" }, 404);
      if (batch.context !== context) return json({ success: false, code: "IMPORT_CONTEXT_MISMATCH", message: "该批次不属于当前班级。" }, 403);
      if (batch.status !== "confirmed" || !batch.confirmedAt) return json({ success: false, code: "IMPORT_BATCH_NOT_CONFIRMED", message: "请先确认质检结果。" }, 409);
      try {
        const records = runtimeStore.getValidRecords(batch.batchId);
        if (!records.length) return json({ success: false, code: "IMPORT_NO_VALID_ROWS", message: "没有有效记录可研判。" }, 400);
        const { input, studentCount, inputDigest } = buildAnalysisInput(records, batch);
        const analyzed = skills.analyzer.analyze(input);
        if (analyzed.ask_clarification) throw new Error("Skill 无法从本批次生成结论。");
        const run = runtimeStore.writeAnalysis({ batchId: batch.batchId, context, skillId: SKILL_ID, skillVersion: SKILL_VERSION, inputDigest, result: analyzed, evidence: {
          fileName: batch.file.name, fileHash: batch.file.sha256, fileSha256: batch.file.sha256, sha256: batch.file.sha256,
          validRows: batch.quality.validRows, excludedRows: batch.quality.invalidRows,
          studentCount, inputDigest,
        } });
        await recordAudit({ actorRole: "teacher", action: "run_analysis", objectType: "analysis_run", objectRef: run.analysisRunId, batchId: batch.batchId, context, result: "success", inputDigest });
        return json({ success: true, source: "local_skill", analysisRunId: run.analysisRunId, batchId: batch.batchId, status: run.status, data: run.result });
      } catch (error) {
        console.error("导入数据研判失败：", error);
        return json({ success: false, code: "ANALYSIS_FAILED", message: "研判失败，导入数据未被替换；请检查后重试。" }, 500);
      }
    }
    const data = skills.analyzer.analyze({
      scores: Array.isArray(body.scores) ? body.scores.slice(0, 1000) : [],
      knowledge_points: Array.isArray(body.knowledgePoints)
        ? body.knowledgePoints.slice(0, 100)
        : [],
      exam_name: cleanText(body.examName || "最近一次评测", 80),
      class_name: cleanText(body.className || "当前班级", 80),
      full_score: Number(body.fullScore || 100),
      pass_score: Number(body.passScore || 60),
      excellent_score: Number(body.excellentScore || 85),
    });
    await recordAudit({
      actorRole: "teacher",
      action: "run_analysis",
      objectType: "skill",
      objectRef: "academic-performance-analyzer",
      result: data.ask_clarification ? "clarification" : "success",
    });
    return json({ success: true, source: "local_skill", data });
  }

  if (request.method === "POST" && url.pathname === "/api/tasks/drafts") {
    try {
      const body = await readJsonBody(request);
      const data = taskService.createDraft({
        context: cleanText(body.context, 80),
        analysisRunId: cleanText(body.analysisRunId, 120),
      });
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  const taskDraftMatch = /^\/api\/tasks\/drafts\/([^/]+)$/.exec(url.pathname);
  if (request.method === "PUT" && taskDraftMatch) {
    try {
      const body = await readJsonBody(request);
      const data = taskService.updateDraft(cleanText(taskDraftMatch[1], 120), {
        context: cleanText(body.context, 80), dueAt: body.dueAt, tasks: body.tasks,
      });
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  const taskPublishMatch = /^\/api\/tasks\/drafts\/([^/]+)\/publish$/.exec(url.pathname);
  if (request.method === "POST" && taskPublishMatch) {
    try {
      const body = await readJsonBody(request);
      const data = taskService.publish(cleanText(taskPublishMatch[1], 120), {
        context: cleanText(body.context, 80), clientRequestId: cleanText(body.clientRequestId, 120),
      });
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  const taskReviseMatch = /^\/api\/tasks\/versions\/([^/]+)\/revise$/.exec(url.pathname);
  if (request.method === "POST" && taskReviseMatch) {
    try {
      const body = await readJsonBody(request);
      const data = taskService.revise(cleanText(taskReviseMatch[1], 120), {
        context: cleanText(body.context, 80),
      });
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  const taskRevokeMatch = /^\/api\/tasks\/versions\/([^/]+)\/revoke$/.exec(url.pathname);
  if (request.method === "POST" && taskRevokeMatch) {
    try {
      const body = await readJsonBody(request);
      const data = taskService.revoke(cleanText(taskRevokeMatch[1], 120), {
        context: cleanText(body.context, 80), reason: body.reason,
      });
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  if (request.method === "GET" && url.pathname === "/api/tasks/teacher") {
    try {
      const data = taskService.teacherTasks(cleanText(url.searchParams.get("context"), 80));
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  if (request.method === "GET" && url.pathname === "/api/tasks/student/history") {
    try {
      const data = taskService.studentTasks({
        studentContext: cleanText(url.searchParams.get("studentContext"), 80),
        offeringId: url.searchParams.get("offeringId"), history: true,
      });
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  if (request.method === "GET" && url.pathname === "/api/tasks/student") {
    try {
      const data = taskService.studentTasks({
        studentContext: cleanText(url.searchParams.get("studentContext"), 80),
        offeringId: url.searchParams.get("offeringId"), history: false,
      });
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  const taskCompleteMatch = /^\/api\/tasks\/assignments\/([^/]+)\/complete$/.exec(url.pathname);
  if (request.method === "POST" && taskCompleteMatch) {
    try {
      const body = await readJsonBody(request);
      const data = taskService.complete(cleanText(taskCompleteMatch[1], 120), {
        studentContext: cleanText(body.studentContext, 80), feedback: body.feedback,
        clientRequestId: cleanText(body.clientRequestId, 120),
      });
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  const taskFeedbackMatch = /^\/api\/tasks\/versions\/([^/]+)\/feedback$/.exec(url.pathname);
  if (request.method === "GET" && taskFeedbackMatch) {
    try {
      const data = taskService.feedback(cleanText(taskFeedbackMatch[1], 120),
        cleanText(url.searchParams.get("context"), 80));
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  if (request.method === "GET" && url.pathname === "/api/tasks/feedback-summary") {
    try {
      const data = taskService.feedbackSummary(cleanText(url.searchParams.get("context"), 80));
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  if (request.method === "GET" && url.pathname === "/api/export") {
    const role = cleanText(url.searchParams.get("role"), 20);
    const context = cleanText(url.searchParams.get("context"), 80);
    const kind = cleanText(url.searchParams.get("kind") || "report", 20);
    const format = cleanText(url.searchParams.get("format") || "json", 20);
    if (!validateRequestContext(role, context)) {
      return json(
        {
          success: false,
          code: "EXPORT_FORBIDDEN",
          message: "当前身份无权导出该上下文数据。",
        },
        403,
      );
    }
    if (!EXPORT_KINDS.has(kind) || !EXPORT_FORMATS.has(format)) {
      return json(
        {
          success: false,
          code: "EXPORT_PARAM_INVALID",
          message: "导出类型或格式不受支持。",
        },
        400,
      );
    }
    const payload = await getExportPayload(kind, context);
    if (!payload) {
      return json(
        {
          success: false,
          code: "EXPORT_DATA_NOT_FOUND",
          message: "没有找到可导出的脱敏数据。",
        },
        404,
      );
    }
    const watermark = `智学双擎-${role}-${Date.now()}`;
    const redacted = {
      ...redactValue(payload),
      exportMeta: {
        watermark,
        generatedAt: new Date().toISOString(),
        redacted: true,
        usage: "仅限校内教学复盘使用",
      },
    };
    await recordAudit({
      actorRole: role,
      action: "export_data",
      objectType: "export",
      objectRef: `${kind}:${format}`,
      result: "success",
      watermark,
    });
    const commonHeaders = {
      "content-disposition": `attachment; filename="zhixue-${kind}-${Date.now()}.${
        format === "excel" ? "xls" : format === "print" ? "html" : format
      }"`,
      "x-zhixue-watermark": `zhixue-${role}-${Date.now()}`,
    };
    if (format === "json") {
      return json({ success: true, data: redacted }, 200, commonHeaders);
    }
    if (format === "csv") {
      return text(toCsv(redacted), 200, "text/csv; charset=utf-8", commonHeaders);
    }
    if (format === "excel") {
      return text(
        toExcelXml(redacted),
        200,
        "application/vnd.ms-excel; charset=utf-8",
        commonHeaders,
      );
    }
    return text(
      buildPrintHtml("智学双擎教学数据导出", redacted),
      200,
      "text/html; charset=utf-8",
      commonHeaders,
    );
  }

  if (request.method === "GET" && url.pathname === "/api/skills") {
    return json({ success: true, data: skills.registry.snapshot() });
  }

  return json(
    {
      success: false,
      code: "API_NOT_FOUND",
      message: "接口不存在。",
    },
    404,
  );
}

async function serveStatic(url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  let filePath;
  if (pathname.startsWith("/assets/")) {
    filePath = resolve(ASSETS_ROOT, `.${pathname.slice("/assets".length)}`);
    if (filePath !== ASSETS_ROOT && !filePath.startsWith(`${ASSETS_ROOT}${sep}`)) {
      return text("403 forbidden", 403, "text/plain; charset=utf-8");
    }
  } else {
    const pageName = pathname.replace(/^\/+/, "");
    if (!PUBLIC_PAGES.has(pageName)) {
      return text("404 not found", 404, "text/plain; charset=utf-8");
    }
    filePath = resolve(ROOT, pageName);
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(filePath);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type":
          MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream",
        "cache-control": filePath.startsWith(ASSETS_ROOT) ? "public, max-age=300" : "no-cache",
        "content-length": String(body.length),
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
      },
    });
  } catch {
    return text("404 not found", 404, "text/plain; charset=utf-8");
  }
}

export function createZhixueServer({ runtimeDbPath, runtimeStore: injectedRuntimeStore } = {}) {
  const runtimeStore = injectedRuntimeStore || createRuntimeStore(runtimeDbPath);
  const taskService = createTaskService({ baseDb: openDatabase(), runtimeStore, audit: recordAudit });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      const result = url.pathname.startsWith("/api/")
        ? await handleApi(request, url, runtimeStore, taskService)
        : await serveStatic(url);
      response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      console.error("本地服务异常：", error);
      const result = json(
        {
          success: false,
          code: "INTERNAL_ERROR",
          message: "服务暂时不可用，请检查本地数据库或稍后重试。",
        },
        500,
      );
      response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
      response.end(Buffer.from(await result.arrayBuffer()));
    }
  });
  if (!injectedRuntimeStore) server.on("close", () => runtimeStore.close());
  return server;
}

function getCliOption(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || getCliOption("port", 8080));
  const host = process.env.HOST || getCliOption("host", "127.0.0.1");
  const server = createZhixueServer();
  server.listen(port, host, () => {
    console.log(`智学双擎本地服务已启动：http://${host}:${port}`);
    console.log("模式：本地 SQLite + 离线 Skill，无需外网。");
  });
}
