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
import { createAuthService, AuthError } from "./auth-service.mjs";
import { createExportService, ExportError } from "./export-service.mjs";
import {
  authorizeStudentOffering,
  authorizeStudentSelf,
  authorizeTeacherContext,
  requireRole,
  scopedCatalog,
} from "./authorization.mjs";

const require = createRequire(import.meta.url);
const { loadZhixueSkills } = require("./skill-runtime.cjs");

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const ASSETS_ROOT = resolve(ROOT, "assets");
const DATA_ROOT = resolve(ROOT, "data");
const DATABASE_PATH = resolve(DATA_ROOT, "zhixue_demo.sqlite");
// Actor-level snapshots stay server-private; /assets/demo-data.json is public-safe only.
const READ_MODEL_PATH = resolve(DATA_ROOT, "web_snapshots.json");
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

const PROMPT_INJECTION = [
  /忽略(以上|之前|全部).*(指令|规则)/i,
  /泄露.*(系统提示|密钥|密码)/i,
  /输出.*(系统提示|开发者消息|隐藏规则)/i,
  /ignore (all )?(previous|above) instructions/i,
  /reveal.*(system prompt|secret|password)/i,
];

const skills = loadZhixueSkills(SKILL_ROOT);
let readModel;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
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

async function handleApi(request, url, runtimeStore, taskService, authService, exportService, baseDb) {
  let resolvedSession;
  const session = () => {
    resolvedSession ||= authService.resolve(request);
    return resolvedSession;
  };
  const stateSession = (role) => {
    const current = session();
    if (role) requireRole(current, role);
    authService.requireCsrf(request, current);
    return current;
  };

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    try {
      const body = await readJsonBody(request, 4096);
      const result = authService.login({
        account: body.account,
        password: body.password,
        requestedRole: body.requestedRole,
        rememberLogin: body.rememberLogin === true,
        userAgent: request.headers["user-agent"] || "",
      });
      await recordAudit({
        actorRole: result.session.role,
        accountId: result.session.accountId,
        sessionId: result.session.sessionId,
        action: "auth_login_success",
        objectType: "auth_session",
        objectRef: result.session.sessionId,
        result: "success",
      });
      return json({ success: true, data: result.data }, 200, { "set-cookie": result.cookie });
    } catch (error) {
      if (error instanceof AuthError || error.code) {
        await recordAudit({
          actorRole: "anonymous",
          action: "auth_login_failure",
          objectType: "auth_account",
          objectRef: "login",
          result: "denied",
          reasonCode: error.code,
        });
        return apiError(error);
      }
      throw error;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    return json({ success: true, data: authService.me(session()) });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const current = stateSession();
    const clear = authService.logout(current);
    await recordAudit({
      actorRole: current.role,
      accountId: current.accountId,
      sessionId: current.sessionId,
      action: "auth_logout",
      objectType: "auth_session",
      objectRef: current.sessionId,
      result: "success",
    });
    return json({ success: true, data: { authenticated: false } }, 200, { "set-cookie": clear });
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    const integrity = baseDb.prepare("PRAGMA quick_check").get();
    const model = await getReadModel();
    return json({
      success: true,
      mode: "local",
      database: "sqlite",
      syntheticData: true,
      integrity: Object.values(integrity)[0],
      sourceVersion: model.meta.sourceVersion,
      services: {
        auth: "ready",
        skills: "ready",
        sqlite: "ready",
        network: "not_required",
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/api/catalog") {
    const current = session();
    const model = await getReadModel();
    return json({
      success: true,
      source: "sqlite_read_model",
      sourceVersion: model.meta.sourceVersion,
      updatedAt: model.meta.generatedAt,
      data: {
        meta: model.meta,
        catalog: scopedCatalog(baseDb, current),
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    const current = session();
    const audience = cleanText(url.searchParams.get("audience"), 20);
    let context = cleanText(url.searchParams.get("context"), 80);
    if (audience !== current.role) {
      throw new AuthError("AUTH_ROLE_FORBIDDEN", "当前登录身份无权访问该工作台。", 403);
    }
    if (audience === "teacher") authorizeTeacherContext(baseDb, current, context);
    else context = authorizeStudentSelf(current, context);
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
      const current = session();
      const studentContext = authorizeStudentSelf(current, cleanText(url.searchParams.get("studentContext"), 80));
      const offeringId = authorizeStudentOffering(baseDb, current, url.searchParams.get("offeringId"));
      const data = await getQaResources(baseDb, studentContext, offeringId);
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error.code) return apiError(error); throw error; }
  }

  if (request.method === "GET" && url.pathname === "/api/qa/history") {
    try {
      const current = session();
      const studentContext = authorizeStudentSelf(current, cleanText(url.searchParams.get("studentContext"), 80));
      const offeringId = authorizeStudentOffering(baseDb, current, url.searchParams.get("offeringId"));
      const data = getQaHistory(baseDb, runtimeStore, studentContext, offeringId, url.searchParams.get("limit"));
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error.code) return apiError(error); throw error; }
  }

  if (request.method === "GET" && url.pathname === "/api/qa/teacher-inbox") {
    try {
      const current = session();
      const context = cleanText(url.searchParams.get("context"), 80);
      authorizeTeacherContext(baseDb, current, context);
      const data = getQaInbox(baseDb, runtimeStore, context, url.searchParams.get("status") || "all", url.searchParams.get("limit"));
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error.code) return apiError(error); throw error; }
  }

  const qaReplyMatch = /^\/api\/qa\/(qa_[0-9a-f-]+)\/reply$/.exec(url.pathname);
  if (request.method === "POST" && qaReplyMatch) {
    try {
      const current = stateSession("teacher");
      const body = await readJsonBody(request);
      const question = runtimeStore.getQa(qaReplyMatch[1]);
      if (!question) throw new AuthError("AUTH_CONTEXT_FORBIDDEN", "无权访问该问题。", 403);
      const context = cleanText(body.context || question.teacherContext, 80);
      authorizeTeacherContext(baseDb, current, context);
      if (question.teacherContext !== context) throw new AuthError("AUTH_CONTEXT_FORBIDDEN", "无权访问该问题。", 403);
      const rawReply = String(body.reply ?? "").trim();
      if (!rawReply) throw new QaError("QA_REPLY_EMPTY", "请填写教师回复。");
      if (rawReply.length > 2000) throw new QaError("QA_REPLY_TOO_LONG", "教师回复不能超过 2000 字。");
      const data = await replyQa({ db: baseDb, runtimeStore, questionId: qaReplyMatch[1],
        context, reply: redactText(rawReply), audit: recordAudit });
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error.code) return apiError(error); throw error; }
  }

  if (request.method === "POST" && url.pathname === "/api/qa") {
    try {
      const current = stateSession("student");
      const body = await readJsonBody(request);
      const studentContext = authorizeStudentSelf(current, cleanText(body.studentContext, 80));
      const offeringId = authorizeStudentOffering(baseDb, current, body.offeringId);
      const question = String(body.question ?? "").trim();
      if (!question) throw new QaError("EMPTY_QUESTION", "请输入需要解答的课程问题。");
      if (question.length > 500) throw new QaError("QUESTION_TOO_LONG", "问题不能超过 500 字。");
      if (PROMPT_INJECTION.some((pattern) => pattern.test(question))) {
        await recordAudit({ actorRole: "student", action: "block_prompt_injection", objectType: "qa", objectRef: "blocked", result: "blocked" });
        throw new QaError("PROMPT_INJECTION_BLOCKED", "问题包含越权指令，已拦截。请改为询问课程知识点。");
      }
      const safeQuestion = redactText(question);
      const data = await answerQa({ db: baseDb, runtimeStore, tutor: skills.tutor,
        studentContext, offeringId, question: safeQuestion,
        clientRequestId: body.clientRequestId, studentLevel: cleanText(body.studentLevel || "普通", 20),
        piiRedacted: safeQuestion !== question, audit: recordAudit });
      return json({ success: true, source: "local_skill", data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error.code) return apiError(error); throw error; }
  }

  if (request.method === "POST" && url.pathname === "/api/import/validate") {
    try {
      const current = stateSession("teacher");
      const body = await readJsonBody(request, 24 * 1024 * 1024);
      const context = cleanText(body.context, 80);
      authorizeTeacherContext(baseDb, current, context);
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
    const current = session();
    const context = cleanText(url.searchParams.get("context"), 80);
    authorizeTeacherContext(baseDb, current, context);
    const batch = runtimeStore.getLatest(context);
    return json({ success: true, usage: "page_restore_only", data: batch ? {
      batch, quality: batch.quality, issues: runtimeStore.getIssues(batch.batchId),
      issuesTruncated: batch.quality.blockingIssueCount + batch.quality.warningIssueCount > 500,
      analysis: batch.status === "confirmed" && batch.confirmedAt ? runtimeStore.getLatestAnalysis(batch.batchId) : null,
    } : null }, 200, { "cache-control": "no-store" });
  }

  const analysisMatch = /^\/api\/analysis\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && analysisMatch) {
    const current = session();
    const context = cleanText(url.searchParams.get("context"), 80);
    authorizeTeacherContext(baseDb, current, context);
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
    const current = stateSession("teacher");
    let body;
    try { body = await readJsonBody(request); } catch (error) { return apiError(error); }
    const context = cleanText(body.context, 80);
    authorizeTeacherContext(baseDb, current, context);
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
    const current = stateSession("teacher");
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
      authorizeTeacherContext(baseDb, current, context);
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
      const current = stateSession("teacher");
      const body = await readJsonBody(request);
      const context = cleanText(body.context, 80);
      authorizeTeacherContext(baseDb, current, context);
      const data = taskService.createDraft({
        context,
        analysisRunId: cleanText(body.analysisRunId, 120),
      });
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  const taskDraftMatch = /^\/api\/tasks\/drafts\/([^/]+)$/.exec(url.pathname);
  if (request.method === "PUT" && taskDraftMatch) {
    try {
      const current = stateSession("teacher");
      const body = await readJsonBody(request);
      const versionId = cleanText(taskDraftMatch[1], 120);
      const scope = taskService.versionScope(versionId);
      if (!scope) throw new AuthError("AUTH_CONTEXT_FORBIDDEN", "无权访问该任务版本。", 403);
      authorizeTeacherContext(baseDb, current, scope.context);
      if (body.context && cleanText(body.context, 80) !== scope.context) throw new AuthError("AUTH_CONTEXT_FORBIDDEN", "任务上下文与授权范围不一致。", 403);
      const data = taskService.updateDraft(versionId, {
        context: scope.context, dueAt: body.dueAt, tasks: body.tasks,
      });
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  const taskPublishMatch = /^\/api\/tasks\/drafts\/([^/]+)\/publish$/.exec(url.pathname);
  if (request.method === "POST" && taskPublishMatch) {
    try {
      const current = stateSession("teacher");
      const body = await readJsonBody(request);
      const versionId = cleanText(taskPublishMatch[1], 120);
      const scope = taskService.versionScope(versionId);
      if (!scope) throw new AuthError("AUTH_CONTEXT_FORBIDDEN", "无权访问该任务版本。", 403);
      authorizeTeacherContext(baseDb, current, scope.context);
      if (body.context && cleanText(body.context, 80) !== scope.context) throw new AuthError("AUTH_CONTEXT_FORBIDDEN", "任务上下文与授权范围不一致。", 403);
      const data = taskService.publish(versionId, {
        context: scope.context, clientRequestId: cleanText(body.clientRequestId, 120),
      });
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  const taskReviseMatch = /^\/api\/tasks\/versions\/([^/]+)\/revise$/.exec(url.pathname);
  if (request.method === "POST" && taskReviseMatch) {
    try {
      const current = stateSession("teacher");
      const body = await readJsonBody(request);
      const versionId = cleanText(taskReviseMatch[1], 120);
      const scope = taskService.versionScope(versionId);
      if (!scope) throw new AuthError("AUTH_CONTEXT_FORBIDDEN", "无权访问该任务版本。", 403);
      authorizeTeacherContext(baseDb, current, scope.context);
      if (body.context && cleanText(body.context, 80) !== scope.context) throw new AuthError("AUTH_CONTEXT_FORBIDDEN", "任务上下文与授权范围不一致。", 403);
      const data = taskService.revise(versionId, {
        context: scope.context,
      });
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  const taskRevokeMatch = /^\/api\/tasks\/versions\/([^/]+)\/revoke$/.exec(url.pathname);
  if (request.method === "POST" && taskRevokeMatch) {
    try {
      const current = stateSession("teacher");
      const body = await readJsonBody(request);
      const versionId = cleanText(taskRevokeMatch[1], 120);
      const scope = taskService.versionScope(versionId);
      if (!scope) throw new AuthError("AUTH_CONTEXT_FORBIDDEN", "无权访问该任务版本。", 403);
      authorizeTeacherContext(baseDb, current, scope.context);
      if (body.context && cleanText(body.context, 80) !== scope.context) throw new AuthError("AUTH_CONTEXT_FORBIDDEN", "任务上下文与授权范围不一致。", 403);
      const data = taskService.revoke(versionId, {
        context: scope.context, reason: body.reason,
      });
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  if (request.method === "GET" && url.pathname === "/api/tasks/teacher") {
    try {
      const current = session();
      const context = cleanText(url.searchParams.get("context"), 80);
      authorizeTeacherContext(baseDb, current, context);
      const data = taskService.teacherTasks(context);
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  if (request.method === "GET" && url.pathname === "/api/tasks/student/history") {
    try {
      const current = session();
      const studentContext = authorizeStudentSelf(current, cleanText(url.searchParams.get("studentContext"), 80));
      const offeringId = authorizeStudentOffering(baseDb, current, url.searchParams.get("offeringId"));
      const data = taskService.studentTasks({
        studentContext,
        offeringId, history: true,
      });
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  if (request.method === "GET" && url.pathname === "/api/tasks/student") {
    try {
      const current = session();
      const studentContext = authorizeStudentSelf(current, cleanText(url.searchParams.get("studentContext"), 80));
      const offeringId = authorizeStudentOffering(baseDb, current, url.searchParams.get("offeringId"));
      const data = taskService.studentTasks({
        studentContext,
        offeringId, history: false,
      });
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  const taskCompleteMatch = /^\/api\/tasks\/assignments\/([^/]+)\/complete$/.exec(url.pathname);
  if (request.method === "POST" && taskCompleteMatch) {
    try {
      const current = stateSession("student");
      const body = await readJsonBody(request);
      const assignmentId = cleanText(taskCompleteMatch[1], 120);
      const scope = taskService.assignmentScope(assignmentId);
      if (!scope || scope.studentId !== current.actorRefId) throw new AuthError("TASK_ASSIGNMENT_FORBIDDEN", "该任务不属于当前学生。", 403);
      const studentContext = authorizeStudentSelf(current, cleanText(body.studentContext, 80));
      const data = taskService.complete(assignmentId, {
        studentContext, feedback: body.feedback,
        clientRequestId: cleanText(body.clientRequestId, 120),
      });
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  const taskFeedbackMatch = /^\/api\/tasks\/versions\/([^/]+)\/feedback$/.exec(url.pathname);
  if (request.method === "GET" && taskFeedbackMatch) {
    try {
      const current = session();
      const versionId = cleanText(taskFeedbackMatch[1], 120);
      const scope = taskService.versionScope(versionId);
      if (!scope) throw new AuthError("AUTH_CONTEXT_FORBIDDEN", "无权访问该任务版本。", 403);
      authorizeTeacherContext(baseDb, current, scope.context);
      const requested = cleanText(url.searchParams.get("context"), 80);
      if (requested && requested !== scope.context) throw new AuthError("AUTH_CONTEXT_FORBIDDEN", "任务上下文与授权范围不一致。", 403);
      const data = taskService.feedback(versionId, scope.context);
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  if (request.method === "GET" && url.pathname === "/api/tasks/feedback-summary") {
    try {
      const current = session();
      const context = cleanText(url.searchParams.get("context"), 80);
      authorizeTeacherContext(baseDb, current, context);
      const data = taskService.feedbackSummary(context);
      return json({ success: true, data }, 200, { "cache-control": "no-store" });
    } catch (error) { if (error instanceof TaskError || error.code) return apiError(error); throw error; }
  }

  if (request.method === "GET" && url.pathname === "/api/export") {
    return json({ success: false, code: "EXPORT_METHOD_NOT_ALLOWED", message: "正式导出仅支持 POST。" }, 405, { allow: "POST" });
  }

  if (request.method === "POST" && url.pathname === "/api/export") {
    const current = stateSession();
    const body = await readJsonBody(request, 16 * 1024);
    try {
      const file = await exportService.generate(current, body);
      return new Response(file.bytes, { status: 200, headers: file.headers });
    } catch (error) {
      throw exportService.normalizeError(error);
    }
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

export function createZhixueServer({
  runtimeDbPath,
  runtimeStore: injectedRuntimeStore,
  baselineDbPath = DATABASE_PATH,
  secureCookie,
  exportOptions,
} = {}) {
  const baseDb = new DatabaseSync(baselineDbPath, { readOnly: true });
  const runtimeStore = injectedRuntimeStore || createRuntimeStore(runtimeDbPath);
  const taskService = createTaskService({ baseDb, runtimeStore, audit: recordAudit });
  const authService = createAuthService({ baseDb, runtimeStore, secureCookie });
  const exportService = createExportService({ baseDb, runtimeStore, secondaryAudit: recordAudit, options: exportOptions });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      const result = url.pathname.startsWith("/api/")
        ? await handleApi(request, url, runtimeStore, taskService, authService, exportService, baseDb)
        : await serveStatic(url);
      response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      if (!(error instanceof AuthError) && !(error instanceof ExportError)) console.error("本地服务异常：", error);
      const result = error instanceof AuthError || error instanceof ExportError || error.code ? apiError(error) : json(
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
  server.on("close", () => {
    if (!injectedRuntimeStore) runtimeStore.close();
    baseDb.close();
  });
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
