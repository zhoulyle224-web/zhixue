import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  authorizeStudentOffering,
  authorizeTeacherContext,
  requireRole,
} from "./authorization.mjs";

export const EXPORT_POLICY_VERSION = "export-policy-2026.09-v1";
export const MAX_EXPORT_BYTES = 5 * 1024 * 1024;
const FORMATS = new Set(["json", "csv", "excel", "print"]);
const TEACHER_KINDS = new Set(["report", "questions", "review"]);
const STUDENT_KINDS = new Set(["learning-record"]);
const FORBIDDEN_KEYS = new Set([
  "display_name", "student_name", "teacher_name", "student_no", "student_id",
  "teacher_id", "email", "phone", "mobile", "id_card", "gender", "address",
  "password", "token", "cookie", "session", "csrf", "raw_question", "raw_feedback",
]);
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}\b/gi;
const ID_CARD_RE = /(?<!\d)\d{17}[\dXx](?!\d)/g;
const STUDENT_NO_RE = /\bS\d{6,}\b/gi;
const FINAL_SENSITIVE = [
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
  /\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}\b/i,
  /(?<!\d)\d{17}[\dXx](?!\d)/,
  /\bS\d{6,}\b/i,
  /zhixue_session/i,
  /csrfToken/i,
  /M5_SECRET_MARKER/,
];

export class ExportError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function keyName(key) {
  return String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();
}

export function redactExportText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(PHONE_RE, "手机号已脱敏")
    .replace(EMAIL_RE, "邮箱已脱敏")
    .replace(ID_CARD_RE, "证件号已脱敏")
    .replace(STUDENT_NO_RE, "匿名学生");
}

export function redactExportValue(value) {
  if (typeof value === "string") return redactExportText(value);
  if (Array.isArray(value)) return value.map(redactExportValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactExportValue(child)]));
  }
  return value;
}

export function assertSafeDto(value, path = "$") {
  if (Array.isArray(value)) return value.forEach((item, index) => assertSafeDto(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(keyName(key))) {
      throw new ExportError("EXPORT_REDACTION_FAILED", "导出字段安全检查未通过，本次未生成文件。", 500);
    }
    assertSafeDto(child, `${path}.${key}`);
  }
}

export function assertSerializedSafe(text) {
  if (FINAL_SENSITIVE.some((pattern) => pattern.test(String(text)))) {
    throw new ExportError("EXPORT_SENSITIVE_CONTENT_DETECTED", "安全检查未通过，本次未生成下载。", 500);
  }
}

export function maskStudentRef(value) {
  const text = String(value || "");
  if (text.length < 5) return "匿名学生";
  return `${text.slice(0, 3)}***${text.slice(-2)}`;
}

function safeJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function courseScope(baseDb, offeringId, classId) {
  const row = baseDb.prepare(`SELECT c.course_code,c.course_name FROM course_offerings o
    JOIN courses c ON c.id=o.course_id WHERE o.id=?`).get(offeringId);
  if (!row) throw new ExportError("EXPORT_SCOPE_INVALID", "导出课程范围不存在。", 400);
  return { courseCode: row.course_code, courseName: row.course_name, classRef: `班级-${classId}` };
}

function latestAnalysis(db, context) {
  const row = db.prepare(`SELECT ar.*,b.file_sha256,b.valid_rows,b.invalid_rows
    FROM runtime_analysis_runs ar JOIN runtime_import_batches b ON b.id=ar.batch_id
    WHERE ar.context_key=? AND ar.status='completed' AND b.confirmed_at IS NOT NULL
    ORDER BY ar.generated_at DESC,ar.rowid DESC LIMIT 1`).get(context);
  if (!row) return null;
  return { row, result: safeJson(row.result_json, {}) };
}

function taskAggregate(db, context) {
  const version = db.prepare(`SELECT v.* FROM runtime_task_versions v
    JOIN runtime_task_plans p ON p.id=v.plan_id WHERE p.context_key=?
    AND v.status IN ('published','revoked','superseded')
    ORDER BY COALESCE(v.published_at,v.updated_at) DESC,v.version_no DESC LIMIT 1`).get(context);
  if (!version) return { summary: null, sourceRef: null };
  const rows = db.prepare(`SELECT tier_code,COUNT(*) assigned,
    SUM(CASE WHEN completion_status='completed' THEN 1 ELSE 0 END) completed
    FROM runtime_task_assignments WHERE task_version_id=? GROUP BY tier_code`).all(version.id);
  const byTier = {
    extension: { assigned: 0, completed: 0 },
    improvement: { assigned: 0, completed: 0 },
    consolidation: { assigned: 0, completed: 0 },
  };
  for (const row of rows) byTier[row.tier_code] = { assigned: row.assigned, completed: row.completed };
  const assignedCount = rows.reduce((sum, row) => sum + row.assigned, 0);
  const completedCount = rows.reduce((sum, row) => sum + row.completed, 0);
  return {
    summary: {
      versionNo: version.version_no, status: version.status, assignedCount, completedCount,
      completionRate: assignedCount ? Math.round(completedCount / assignedCount * 1000) / 10 : 0,
      byTier,
    },
    sourceRef: version.id,
  };
}

function teachingSuggestions(result) {
  const source = result.teaching_suggestions || {};
  return {
    classUniversal: Array.isArray(source.class_universal) ? source.class_universal.map(String) : [],
    individualGuidance: Array.isArray(source.individual_guidance) ? source.individual_guidance.map(String) : [],
    nextTeachingFocus: String(source.next_teaching_focus || ""),
  };
}

function knowledgeAnalysis(result) {
  return (Array.isArray(result.knowledge_analysis) ? result.knowledge_analysis : []).map((item) => ({
    knowledgePoint: String(item.knowledge_point || ""),
    masteryRate: String(item.mastery_rate || ""),
    mainErrorType: String(item.main_error_type || ""),
    causeAnalysis: String(item.cause_analysis || ""),
  }));
}

function tierCounts(result) {
  const tiers = result.student_stratification || {};
  return {
    extension: Array.isArray(tiers.excellent_students) ? tiers.excellent_students.length : 0,
    improvement: Array.isArray(tiers.potential_students) ? tiers.potential_students.length : 0,
    consolidation: Array.isArray(tiers.struggling_students) ? tiers.struggling_students.length : 0,
  };
}

function buildTeacherReport(db, baseDb, scope) {
  const analysis = latestAnalysis(db, scope.context);
  if (!analysis) throw new ExportError("EXPORT_DATA_NOT_FOUND", "当前授权范围还没有正式研判数据。", 404);
  const result = analysis.result;
  const overall = result.overall_summary || {};
  const task = taskAggregate(db, scope.context);
  const dto = {
    scope: { ...courseScope(baseDb, scope.offeringId, scope.classId), dataClassification: "protected_synthetic_runtime" },
    analysis: {
      analysisRunId: analysis.row.id, generatedAt: analysis.row.generated_at,
      sampleSize: Number(overall.total_students || 0), averageScore: Number(overall.average_score || 0),
      passRate: String(overall.pass_rate || "0%"), excellentRate: String(overall.excellent_rate || "0%"),
      knowledgeAnalysis: knowledgeAnalysis(result), tierCounts: tierCounts(result),
      teachingSuggestions: teachingSuggestions(result),
    },
    evidence: {
      batchId: analysis.row.batch_id, fileSha256: analysis.row.file_sha256,
      validRows: analysis.row.valid_rows, excludedRows: analysis.row.invalid_rows,
      skillId: analysis.row.skill_id, skillVersion: analysis.row.skill_version,
    },
    taskSummary: task.summary,
  };
  return {
    dto, recordCount: Number(overall.total_students || 0),
    sourceRefs: { analysisRunId: analysis.row.id, batchId: analysis.row.batch_id, taskVersionId: task.sourceRef },
  };
}

function safeEvidence(raw) {
  return (Array.isArray(raw) ? raw : []).map((item) => ({
    title: String(item.title || ""), locator: String(item.locator || ""),
    version: String(item.version || ""), sourceLabel: String(item.sourceLabel || item.source_label || "合成演示课程资料"),
  }));
}

function buildTeacherQuestions(db, baseDb, scope) {
  const rows = db.prepare(`SELECT id,student_no,question_text_redacted,answer_status,
    assistant_answer,evidence_json,teacher_reply,created_at,replied_at
    FROM runtime_qa_records WHERE offering_id=? AND class_id=?
    ORDER BY created_at DESC,rowid DESC LIMIT 5001`).all(scope.offeringId, scope.classId);
  if (rows.length > 5000) throw new ExportError("EXPORT_TOO_LARGE", "答疑记录过多，请缩小范围后重新导出。", 413);
  return {
    dto: {
      scope: courseScope(baseDb, scope.offeringId, scope.classId),
      questions: rows.map((row) => ({
        questionId: row.id, studentRef: maskStudentRef(row.student_no),
        question: String(row.question_text_redacted || ""), status: row.answer_status,
        assistantAnswer: String(row.assistant_answer || ""), evidence: safeEvidence(safeJson(row.evidence_json, [])),
        teacherReply: String(row.teacher_reply || ""), createdAt: row.created_at, repliedAt: row.replied_at,
      })),
    },
    recordCount: rows.length,
    sourceRefs: { questionCount: rows.length },
  };
}

function buildTeacherReview(db, baseDb, scope) {
  const analysis = latestAnalysis(db, scope.context);
  if (!analysis) throw new ExportError("EXPORT_DATA_NOT_FOUND", "当前授权范围还没有正式研判数据。", 404);
  const result = analysis.result;
  const points = knowledgeAnalysis(result);
  const weakest = [...points].sort((a, b) => parseFloat(a.masteryRate) - parseFloat(b.masteryRate))[0];
  const task = taskAggregate(db, scope.context);
  const qa = db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN answer_status='pending_teacher' THEN 1 ELSE 0 END) pending,
    SUM(CASE WHEN answer_status='teacher_replied' THEN 1 ELSE 0 END) replied
    FROM runtime_qa_records WHERE offering_id=? AND class_id=?`).get(scope.offeringId, scope.classId);
  const suggestions = teachingSuggestions(result);
  return {
    dto: {
      scope: courseScope(baseDb, scope.offeringId, scope.classId),
      analysisSummary: {
        analysisRunId: analysis.row.id, weakestKnowledgePoint: weakest?.knowledgePoint || "",
        sampleSize: Number(result.overall_summary?.total_students || 0),
      },
      teachingSuggestions: suggestions,
      taskReview: task.summary,
      qaSummary: { totalQuestions: qa.total || 0, pendingTeacher: qa.pending || 0, teacherReplied: qa.replied || 0 },
      nextActions: [...suggestions.classUniversal, suggestions.nextTeachingFocus].filter(Boolean).slice(0, 6),
    },
    recordCount: task.summary?.assignedCount || 0,
    sourceRefs: { analysisRunId: analysis.row.id, taskVersionId: task.sourceRef, questionCount: qa.total || 0 },
  };
}

function studentCourses(baseDb, session, offeringId) {
  if (offeringId !== undefined && offeringId !== null && offeringId !== "") {
    const id = authorizeStudentOffering(baseDb, session, offeringId);
    return baseDb.prepare(`SELECT o.id offering_id,c.course_code,c.course_name FROM enrollments e
      JOIN course_offerings o ON o.id=e.offering_id JOIN courses c ON c.id=o.course_id
      WHERE e.student_id=? AND e.offering_id=? AND e.status<>'退选'`).all(session.actorRefId, id);
  }
  return baseDb.prepare(`SELECT o.id offering_id,c.course_code,c.course_name FROM enrollments e
    JOIN course_offerings o ON o.id=e.offering_id JOIN courses c ON c.id=o.course_id
    WHERE e.student_id=? AND e.status<>'退选' ORDER BY c.course_name`).all(session.actorRefId);
}

function buildStudentLearningRecord(db, baseDb, session, offeringId) {
  const courses = studentCourses(baseDb, session, offeringId);
  const studentContext = `student:${session.actorRefCode}`;
  let total = 0;
  const items = courses.map((course) => {
    const qa = db.prepare(`SELECT id,question_text_redacted,answer_status,assistant_answer,
      evidence_json,teacher_reply,created_at,replied_at FROM runtime_qa_records
      WHERE student_context=? AND offering_id=? ORDER BY created_at DESC,rowid DESC LIMIT 5000`)
      .all(studentContext, course.offering_id).map((row) => ({
        questionId: row.id, question: String(row.question_text_redacted || ""), status: row.answer_status,
        assistantAnswer: String(row.assistant_answer || ""), evidence: safeEvidence(safeJson(row.evidence_json, [])),
        teacherReply: String(row.teacher_reply || ""), createdAt: row.created_at, repliedAt: row.replied_at,
      }));
    const tasks = db.prepare(`SELECT a.id assignment_id,a.tier_code,a.completion_status,a.completed_at,
      a.feedback_text,v.version_no,v.status version_status,v.due_at,v.task_content_json,v.weakest_knowledge_point
      FROM runtime_task_assignments a JOIN runtime_task_versions v ON v.id=a.task_version_id
      JOIN runtime_task_plans p ON p.id=v.plan_id WHERE a.student_id=? AND p.offering_id=?
      ORDER BY v.created_at DESC LIMIT 5000`).all(session.actorRefId, course.offering_id).map((row) => {
        const content = safeJson(row.task_content_json, {}), task = content[row.tier_code] || {};
        return {
          assignmentId: row.assignment_id, versionNo: row.version_no, versionStatus: row.version_status,
          tierCode: row.tier_code, title: String(task.title || ""), detail: String(task.detail || ""),
          dueAt: row.due_at, completionStatus: row.completion_status, completedAt: row.completed_at,
          feedback: String(row.feedback_text || ""), weakestKnowledgePoint: row.weakest_knowledge_point,
        };
      });
    total += qa.length + tasks.length;
    return {
      courseCode: course.course_code, courseName: course.course_name, qa, tasks,
      learningSummary: {
        questionCount: qa.length, taskCount: tasks.length,
        completedTaskCount: tasks.filter((task) => task.completionStatus === "completed").length,
      },
    };
  });
  return {
    dto: {
      student: { studentRef: maskStudentRef(session.actorRefCode), dataClassification: "protected_synthetic_runtime" },
      courses: items,
    },
    recordCount: total,
    sourceRefs: { offeringIds: courses.map((course) => course.offering_id), courseCount: courses.length },
  };
}

function flattenRows(value) {
  const rows = [];
  function visit(item, path) {
    if (Array.isArray(item)) return item.forEach((child, index) => visit(child, [...path, String(index + 1)]));
    if (item && typeof item === "object") return Object.entries(item).forEach(([key, child]) => visit(child, [...path, key]));
    rows.push({ path: path.join("."), value: item === null || item === undefined ? "" : String(item) });
  }
  visit(value, []);
  return rows;
}

export function spreadsheetSafe(value) {
  const text = String(value ?? "");
  return /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text;
}

function csvCell(value) {
  const text = spreadsheetSafe(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function escapeXml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function toCsv(dto) {
  const meta = dto.exportMeta;
  const rows = flattenRows(dto);
  const lines = [
    ["导出编号", meta.exportId], ["水印编号", meta.watermarkId], ["生成时间", meta.generatedAt],
    ["数据性质", "合成演示"], ["脱敏状态", "已脱敏"], [], ["字段", "值"],
    ...rows.map((row) => [row.path, row.value]),
  ];
  return `\uFEFF${lines.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function toExcelXml(dto) {
  const rows = flattenRows(dto).map((row) => [row.path, row.value]);
  const all = [
    ["导出编号", dto.exportMeta.exportId], ["水印编号", dto.exportMeta.watermarkId],
    ["生成时间", dto.exportMeta.generatedAt], ["数据性质", "合成演示"],
    ["脱敏状态", "已脱敏"], ["字段", "值"], ...rows,
  ];
  const xmlRows = all.map((row) => `<Row>${row.map((cell) => `<Cell><Data ss:Type="String">${escapeXml(spreadsheetSafe(cell))}</Data></Cell>`).join("")}</Row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="受控导出"><Table>${xmlRows}</Table></Worksheet></Workbook>`;
}

export function toPrintHtml(dto, kind) {
  const rows = flattenRows(dto).map((row) => `<tr><th>${escapeXml(row.path)}</th><td>${escapeXml(row.value)}</td></tr>`).join("");
  const meta = dto.exportMeta;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>智学双擎受控导出</title><style>body{font-family:"Microsoft YaHei",sans-serif;padding:32px;color:#14213d}header{border-bottom:2px solid #3568ff;margin-bottom:20px}table{width:100%;border-collapse:collapse}th,td{padding:8px;border:1px solid #cbd5e1;text-align:left;vertical-align:top}th{width:34%;background:#f1f5f9}.watermark{position:fixed;inset:42% auto auto 8%;transform:rotate(-24deg);font-size:42px;color:rgba(37,99,235,.10);pointer-events:none}@media print{body{padding:12px}}</style></head><body><header><h1>智学双擎受控导出 · ${escapeXml(kind)}</h1><p>生成时间：${escapeXml(meta.generatedAt)}<br>导出编号：${escapeXml(meta.exportId)}<br>水印编号：${escapeXml(meta.watermarkId)}<br>数据性质：合成演示 / 受保护业务数据<br>请使用浏览器打印功能另存 PDF。</p></header><table>${rows}</table><div class="watermark">智学双擎 · 合成演示 · ${escapeXml(meta.watermarkId)}</div></body></html>`;
}

function serialize(dto, format, kind) {
  if (format === "json") return Buffer.from(JSON.stringify(dto, null, 2), "utf8");
  if (format === "csv") return Buffer.from(toCsv(dto), "utf8");
  if (format === "excel") return Buffer.from(toExcelXml(dto), "utf8");
  return Buffer.from(toPrintHtml(dto, kind), "utf8");
}

function formatInfo(format) {
  if (format === "json") return { ext: "json", type: "application/json; charset=utf-8", disposition: "attachment" };
  if (format === "csv") return { ext: "csv", type: "text/csv; charset=utf-8", disposition: "attachment" };
  if (format === "excel") return { ext: "xls", type: "application/vnd.ms-excel; charset=utf-8", disposition: "attachment" };
  return { ext: "html", type: "text/html; charset=utf-8", disposition: "inline" };
}

function normalizeError(error) {
  if (error instanceof ExportError || error?.code?.startsWith("AUTH_")) return error;
  return new ExportError("EXPORT_SERVICE_UNAVAILABLE", "导出服务暂不可用，本次未生成文件。", 503);
}

export function createExportService({ baseDb, runtimeStore, secondaryAudit = async () => {}, options = {} }) {
  const db = runtimeStore.taskDatabase;
  const strictWrite = options.auditWriter || ((row) => runtimeStore.writeExportAudit(row));
  const maxBytes = options.maxBytes || MAX_EXPORT_BYTES;

  async function generate(session, request) {
    const kind = String(request?.kind || "");
    const format = String(request?.format || "");
    if (![...TEACHER_KINDS, ...STUDENT_KINDS].includes(kind)) throw new ExportError("EXPORT_KIND_INVALID", "导出类型不受支持。", 400);
    if (!FORMATS.has(format)) throw new ExportError("EXPORT_FORMAT_INVALID", "导出格式不受支持。", 400);
    const allowed = session.role === "teacher" ? TEACHER_KINDS : STUDENT_KINDS;
    if (!allowed.has(kind)) throw new ExportError("EXPORT_KIND_FORBIDDEN", "当前身份不能导出该类型。", 403);

    let scope, built;
    if (session.role === "teacher") {
      requireRole(session, "teacher");
      const context = String(request?.scope?.context || "");
      if (!context) throw new ExportError("EXPORT_SCOPE_INVALID", "请选择要导出的授权课程与班级。", 400);
      const parsed = authorizeTeacherContext(baseDb, session, context);
      scope = { ...parsed, scopeType: "teacher_context", scopeRef: parsed.context };
      built = kind === "report" ? buildTeacherReport(db, baseDb, scope)
        : kind === "questions" ? buildTeacherQuestions(db, baseDb, scope)
          : buildTeacherReview(db, baseDb, scope);
    } else {
      requireRole(session, "student");
      const offeringId = request?.scope?.offeringId;
      scope = { scopeType: "student_self", scopeRef: "self" };
      built = buildStudentLearningRecord(db, baseDb, session, offeringId);
    }

    let safeBody = redactExportValue(built.dto);
    if (options.transformDto) safeBody = options.transformDto(safeBody);
    assertSafeDto(safeBody);
    const generatedAt = new Date().toISOString();
    const exportId = `exp_${randomUUID()}`;
    const watermarkId = `ZX-${generatedAt.slice(0, 10).replaceAll("-", "")}-${randomBytes(4).toString("hex").toUpperCase()}`;
    const dto = {
      exportMeta: {
        exportId, watermarkId, generatedAt, policyVersion: EXPORT_POLICY_VERSION,
        redacted: true, syntheticData: true, usage: "参赛演示与教学复盘", recordCount: built.recordCount,
      },
      ...safeBody,
    };
    assertSafeDto(dto);

    const baseAudit = {
      id: `exa_${randomUUID()}`, exportId, accountId: session.accountId,
      actorRole: session.role, actorRefCode: session.actorRefCode,
      scopeType: scope.scopeType, scopeRef: scope.scopeRef, exportKind: kind,
      exportFormat: format, watermarkId, policyVersion: EXPORT_POLICY_VERSION,
      sourceRefs: built.sourceRefs, recordCount: built.recordCount, generatedAt,
      createdAt: new Date().toISOString(),
    };
    let bytes;
    try {
      bytes = options.serializer ? options.serializer(dto, format, kind) : serialize(dto, format, kind);
      if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
      assertSerializedSafe(bytes.toString("utf8"));
      if (bytes.length > maxBytes) throw new ExportError("EXPORT_TOO_LARGE", "导出文件超过 5 MiB，请缩小范围后重试。", 413);
    } catch (error) {
      const failure = error instanceof ExportError ? error : new ExportError("EXPORT_SERIALIZATION_FAILED", "文件生成失败，本次未产生下载。", 500);
      try { strictWrite({ ...baseAudit, result: "failed", failureCode: failure.code, contentSizeBytes: bytes?.length ?? null, contentDigest: null }); } catch {}
      throw failure;
    }

    const contentDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    try {
      strictWrite({ ...baseAudit, result: "generated", failureCode: null, contentSizeBytes: bytes.length, contentDigest });
    } catch {
      throw new ExportError("EXPORT_AUDIT_UNAVAILABLE", "导出审计暂不可用，为避免产生未审查文件，本次未生成下载。", 503);
    }

    await secondaryAudit({
      actorRole: session.role, accountId: session.accountId, action: "export_generated",
      objectType: "export", objectRef: exportId, exportId, watermarkId,
      kind, format, scopeRef: scope.scopeRef, result: "generated",
    });
    const info = formatInfo(format);
    const shortId = watermarkId.slice(-8);
    const filename = `zhixue-${kind}-${generatedAt.slice(0, 10).replaceAll("-", "")}-${shortId}.${info.ext}`;
    return {
      bytes, exportId, watermarkId, generatedAt, contentDigest, filename,
      headers: {
        "content-type": info.type,
        "content-disposition": `${info.disposition}; filename="${filename}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "x-zhixue-export-id": exportId,
        "x-zhixue-watermark": watermarkId,
        ...(format === "print" ? { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; frame-ancestors 'none'" } : {}),
      },
    };
  }

  return { generate, normalizeError };
}
