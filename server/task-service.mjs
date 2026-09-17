import { createHash, randomUUID } from "node:crypto";

const TIERS = Object.freeze({
  extension: { label: "拓展组", source: "excellent_students", suffix: "迁移应用", minutes: 35 },
  improvement: { label: "提升组", source: "potential_students", suffix: "方法巩固", minutes: 25 },
  consolidation: { label: "巩固组", source: "struggling_students", suffix: "概念补偿", minutes: 20 },
});

export class TaskError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${randomUUID()}`;
const json = (value, fallback = {}) => {
  try { return JSON.parse(value); } catch { return fallback; }
};
const clean = (value, limit) => String(value ?? "")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .trim().slice(0, limit);
const redactFeedback = (value) => clean(value, 500)
  .replace(/1[3-9]\d{9}/g, "手机号已脱敏")
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "邮箱已脱敏")
  .replace(/\b\d{17}[\dXx]\b/g, "证件号已脱敏");
const studentRef = (value) => value.length > 5 ? `${value.slice(0, 3)}***${value.slice(-2)}` : "***";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function parseTeacherContext(context) {
  const match = /^teacher:(\d+):(\d+)$/.exec(String(context || ""));
  if (!match) throw new TaskError("TASK_TEACHER_CONTEXT_INVALID", "教师课程与班级上下文不合法。", 400);
  return { context, offeringId: Number(match[1]), classId: Number(match[2]) };
}

function parseStudentContext(context) {
  const match = /^student:(S\d{6,})$/.exec(String(context || ""));
  if (!match) throw new TaskError("TASK_STUDENT_CONTEXT_INVALID", "学生上下文不合法。", 400);
  return { context, studentNo: match[1] };
}

function contextInfo(baseDb, context) {
  const parsed = parseTeacherContext(context);
  const row = baseDb.prepare(`
    SELECT co.id AS offering_id, c.id AS class_id, cr.id AS course_id,
           cr.course_code, cr.course_name, c.class_name,
           COUNT(DISTINCT s.id) AS class_students
    FROM course_offerings co
    JOIN courses cr ON cr.id = co.course_id
    JOIN classes c ON c.id = ?
    LEFT JOIN students s ON s.class_id = c.id
    WHERE co.id = ?
    GROUP BY co.id, c.id, cr.id
  `).get(parsed.classId, parsed.offeringId);
  if (!row) throw new TaskError("TASK_CONTEXT_NOT_FOUND", "课程或班级不存在。", 404);
  return { ...parsed, courseId: row.course_id, courseCode: row.course_code,
    courseName: row.course_name, className: row.class_name, classStudents: row.class_students };
}

function studentCourse(baseDb, studentContext, offeringId) {
  const parsed = parseStudentContext(studentContext);
  const row = baseDb.prepare(`
    SELECT s.id AS student_id, s.student_no, s.class_id, co.id AS offering_id,
           cr.id AS course_id, cr.course_code, cr.course_name
    FROM students s
    JOIN enrollments e ON e.student_id = s.id AND e.status = '修读中'
    JOIN course_offerings co ON co.id = e.offering_id
    JOIN courses cr ON cr.id = co.course_id
    WHERE s.student_no = ? AND co.id = ?
  `).get(parsed.studentNo, Number(offeringId));
  if (!row) throw new TaskError("TASK_STUDENT_COURSE_FORBIDDEN", "当前学生未选修该课程。", 403);
  return { ...parsed, ...row };
}

function stratification(run) {
  const source = run?.result?.student_stratification;
  if (!source) throw new TaskError("TASK_ANALYSIS_RESULT_INVALID", "研判结果缺少学生分层。", 409);
  const snapshot = {};
  const seen = new Set();
  for (const [tierCode, config] of Object.entries(TIERS)) {
    const values = source[config.source];
    if (!Array.isArray(values)) throw new TaskError("TASK_ANALYSIS_RESULT_INVALID", "研判结果分层格式不完整。", 409);
    snapshot[tierCode] = values.map((value) => clean(value, 80)).filter(Boolean);
    for (const studentNo of snapshot[tierCode]) {
      if (seen.has(studentNo)) throw new TaskError("TASK_STRATIFICATION_INVALID", "同一学生不能同时属于多个任务层次。", 409);
      seen.add(studentNo);
    }
  }
  if (!seen.size) throw new TaskError("TASK_ANALYSIS_RESULT_INVALID", "研判结果没有可发布学生。", 409);
  return snapshot;
}

function weakestPoint(run) {
  const values = run?.result?.knowledge_analysis;
  if (!Array.isArray(values) || !values.length) throw new TaskError("TASK_ANALYSIS_RESULT_INVALID", "研判结果缺少知识点分析。", 409);
  const ranked = values.map((item) => ({ name: clean(item.knowledge_point, 120), value: Number.parseFloat(item.mastery_rate) }))
    .filter((item) => item.name && Number.isFinite(item.value)).sort((a, b) => a.value - b.value);
  if (!ranked.length) throw new TaskError("TASK_ANALYSIS_RESULT_INVALID", "研判结果无法确定薄弱知识点。", 409);
  return ranked[0].name;
}

function defaultTasks(point) {
  return {
    extension: { title: `${point} · 迁移应用`, detail: `围绕“${point}”完成 1 道新情境迁移任务，说明你选择策略的理由，并比较至少两种可行方案。`, durationMinutes: 35 },
    improvement: { title: `${point} · 方法巩固`, detail: `完成 4 道“${point}”变式练习，逐步写出状态、目标与策略选择依据，并检查关键步骤。`, durationMinutes: 25 },
    consolidation: { title: `${point} · 概念补偿`, detail: `复习“${point}”的核心概念，完成 3 道基础练习，并提交 1 个仍不理解的问题。`, durationMinutes: 20 },
  };
}

function validateTasks(tasks) {
  const saved = {};
  for (const tierCode of Object.keys(TIERS)) {
    const item = tasks?.[tierCode] || {};
    const title = clean(item.title, 81);
    const detail = clean(item.detail, 1001);
    const durationMinutes = Number(item.durationMinutes);
    if (!title || title.length > 80 || !detail || detail.length > 1000 ||
        !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 180) {
      throw new TaskError("TASK_CONTENT_INVALID", `${TIERS[tierCode].label}任务内容不合法。`, 400);
    }
    saved[tierCode] = { title, detail, durationMinutes };
  }
  return saved;
}

function normalizeDueAt(value, required = false) {
  if (!value && !required) return null;
  const parsed = new Date(value);
  const max = Date.now() + 180 * 24 * 60 * 60 * 1000;
  if (!value || Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now() || parsed.getTime() > max) {
    throw new TaskError("TASK_DUE_DATE_INVALID", "截止时间必须晚于当前时间且不超过 180 天。", 400);
  }
  return parsed.toISOString();
}

function mapVersion(row) {
  if (!row) return null;
  return {
    planId: row.plan_id, versionId: row.id, versionNo: row.version_no, status: row.status,
    sourceAnalysisRunId: row.source_analysis_run_id, sourceBatchId: row.source_batch_id,
    source: json(row.source_evidence_json), stratification: json(row.stratification_snapshot_json),
    tasks: json(row.task_content_json), weakestKnowledgePoint: row.weakest_knowledge_point,
    dueAt: row.due_at, contentDigest: row.content_digest, draftSource: row.draft_source,
    createdAt: row.created_at, updatedAt: row.updated_at, publishedAt: row.published_at,
    revokedAt: row.revoked_at, revokeReason: row.revoke_reason, supersededAt: row.superseded_at,
  };
}

function mapping(baseDb, info, snapshot) {
  const requested = Object.entries(snapshot).flatMap(([tierCode, values]) => values.map((studentNo) => ({ studentNo, tierCode })));
  const map = new Map(baseDb.prepare(`
    SELECT s.id AS student_id, s.student_no
    FROM students s JOIN enrollments e ON e.student_id = s.id AND e.status = '修读中'
    WHERE s.class_id = ? AND e.offering_id = ?
  `).all(info.classId, info.offeringId).map((row) => [row.student_no, row]));
  const resolved = requested.filter((item) => map.has(item.studentNo)).map((item) => ({ ...item, studentId: map.get(item.studentNo).student_id }));
  const unmapped = requested.filter((item) => !map.has(item.studentNo)).map((item) => item.studentNo);
  return { requested, resolved, unmapped };
}

function coverage(baseDb, info, snapshot) {
  const mapped = mapping(baseDb, info, snapshot);
  return { analysisStudents: mapped.requested.length, classStudents: info.classStudents,
    mappableStudents: mapped.resolved.length, unmappedStudents: mapped.unmapped.length,
    unmappedIdentifiers: mapped.unmapped };
}

function tierCounts(snapshot) {
  return Object.fromEntries(Object.keys(TIERS).map((tier) => [tier, snapshot[tier]?.length || 0]));
}

function draftResponse(baseDb, version, info) {
  return { ...version, source: { ...version.source, analysisRunId: version.sourceAnalysisRunId,
      batchId: version.sourceBatchId, weakestKnowledgePoint: version.weakestKnowledgePoint },
    coverage: coverage(baseDb, info, version.stratification), tiers: tierCounts(version.stratification) };
}

function event(db, planId, versionId, assignmentId, eventType, actorContext, metadata = {}) {
  db.prepare(`INSERT INTO runtime_task_events
    (id,plan_id,task_version_id,assignment_id,event_type,actor_context,metadata_json,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(id("te"), planId, versionId, assignmentId, eventType,
      actorContext, JSON.stringify(metadata), now());
}

export function createTaskService({ baseDb, runtimeStore, audit = async () => {} }) {
  const db = runtimeStore.taskDatabase;

  function getVersion(versionId) {
    return mapVersion(db.prepare("SELECT * FROM runtime_task_versions WHERE id = ?").get(versionId));
  }

  function requireOwnedVersion(versionId, context) {
    const row = db.prepare(`SELECT v.*,p.context_key,p.offering_id,p.class_id
      FROM runtime_task_versions v JOIN runtime_task_plans p ON p.id=v.plan_id WHERE v.id=?`).get(versionId);
    if (!row) throw new TaskError("TASK_VERSION_NOT_FOUND", "任务版本不存在。", 404);
    if (row.context_key !== context) throw new TaskError("TASK_VERSION_FORBIDDEN", "该任务版本不属于当前班级。", 403);
    return row;
  }

  function createDraft({ context, analysisRunId }) {
    const info = contextInfo(baseDb, context);
    if (!analysisRunId) throw new TaskError("TASK_ANALYSIS_REQUIRED", "请先完成一次已确认的学情研判。", 409);
    const run = runtimeStore.getAnalysisRun(clean(analysisRunId, 120));
    if (!run) throw new TaskError("TASK_ANALYSIS_RUN_NOT_FOUND", "研判记录不存在。", 404);
    if (run.context !== context) throw new TaskError("TASK_ANALYSIS_CONTEXT_MISMATCH", "研判不属于当前班级。", 403);
    const batch = runtimeStore.getBatch(run.batchId);
    if (run.status !== "completed" || !batch || batch.status !== "confirmed" || !batch.confirmedAt) {
      throw new TaskError("TASK_ANALYSIS_REQUIRED", "研判来源批次尚未确认或研判未完成。", 409);
    }
    const existing = db.prepare(`SELECT v.* FROM runtime_task_versions v
      JOIN runtime_task_plans p ON p.id=v.plan_id
      WHERE p.context_key=? AND v.source_analysis_run_id=?
      ORDER BY CASE v.status WHEN 'draft' THEN 0 WHEN 'published' THEN 1 ELSE 2 END,
               v.version_no DESC LIMIT 1`).get(context, run.analysisRunId);
    if (existing) return draftResponse(baseDb, mapVersion(existing), info);
    const snapshot = stratification(run);
    const point = weakestPoint(run);
    const tasks = defaultTasks(point);
    const planId = id("tp"), versionId = id("tv"), createdAt = now();
    const evidence = { analysisRunId: run.analysisRunId, batchId: run.batchId,
      fileName: batch.file.name, fileSha256: batch.file.sha256, validRows: batch.quality.validRows,
      studentCount: run.result.overall_summary?.total_students || 0, skillId: run.skillId,
      skillVersion: run.skillVersion, analysisGeneratedAt: run.generatedAt };
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`INSERT INTO runtime_task_plans
        (id,context_key,offering_id,class_id,created_by_context,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?)`).run(planId, context, info.offeringId, info.classId, context, createdAt, createdAt);
      db.prepare(`INSERT INTO runtime_task_versions
        (id,plan_id,version_no,status,source_analysis_run_id,source_batch_id,
         source_evidence_json,stratification_snapshot_json,task_content_json,
         weakest_knowledge_point,draft_source,created_by_context,created_at,updated_at)
        VALUES (?,?,1,'draft',?,?,?,?,?,?,'analysis_template',?,?,?)`).run(
          versionId, planId, run.analysisRunId, run.batchId, JSON.stringify(evidence),
          JSON.stringify(snapshot), JSON.stringify(tasks), point, context, createdAt, createdAt);
      event(db, planId, versionId, null, "draft_created", context,
        { versionNo: 1, tierCounts: tierCounts(snapshot), sourceAnalysisRunId: run.analysisRunId });
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    audit({ actorRole: "teacher", context, action: "task_draft_created", objectType: "task_version",
      objectRef: versionId, result: "success", planId, versionId, versionNo: 1 });
    return draftResponse(baseDb, getVersion(versionId), info);
  }

  function updateDraft(versionId, { context, tasks, dueAt }) {
    const info = contextInfo(baseDb, context);
    const row = requireOwnedVersion(versionId, context);
    if (row.status !== "draft") throw new TaskError("TASK_VERSION_IMMUTABLE", "已发布或历史版本不可编辑。", 409);
    const savedTasks = validateTasks(tasks);
    const savedDueAt = normalizeDueAt(dueAt, true);
    const updatedAt = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`UPDATE runtime_task_versions SET task_content_json=?,due_at=?,updated_at=? WHERE id=? AND status='draft'`)
        .run(JSON.stringify(savedTasks), savedDueAt, updatedAt, versionId);
      event(db, row.plan_id, versionId, null, "draft_updated", context, { versionNo: row.version_no });
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    audit({ actorRole: "teacher", context, action: "task_draft_updated", objectType: "task_version",
      objectRef: versionId, result: "success", planId: row.plan_id, versionId, versionNo: row.version_no });
    return draftResponse(baseDb, getVersion(versionId), info);
  }

  function publish(versionId, { context, clientRequestId }) {
    const info = contextInfo(baseDb, context);
    const requestId = clean(clientRequestId, 120);
    if (!requestId) throw new TaskError("TASK_PUBLISH_CONFLICT", "发布请求缺少幂等标识。", 409);
    const prior = db.prepare("SELECT * FROM runtime_task_versions WHERE publish_client_request_id=?").get(requestId);
    if (prior) {
      if (prior.id !== versionId) throw new TaskError("TASK_PUBLISH_CONFLICT", "发布请求标识已被其他版本使用。", 409);
      return publishResult(prior);
    }
    const row = requireOwnedVersion(versionId, context);
    if (row.status !== "draft") throw new TaskError("TASK_PUBLISH_CONFLICT", "当前版本不是可发布草案。", 409);
    const tasks = validateTasks(json(row.task_content_json));
    const dueAt = normalizeDueAt(row.due_at, true);
    const snapshot = json(row.stratification_snapshot_json);
    const mapped = mapping(baseDb, info, snapshot);
    if (mapped.unmapped.length) throw new TaskError("TASK_ASSIGNMENT_MAPPING_INCOMPLETE",
      `有 ${mapped.unmapped.length} 个学生标识无法映射到当前班级与课程，不能发布。`, 409,
      { unmappedCount: mapped.unmapped.length, unmappedIdentifiers: mapped.unmapped });
    const publishedAt = now();
    const contentDigest = digest({ tasks, dueAt, snapshot, analysisRunId: row.source_analysis_run_id });
    db.exec("BEGIN IMMEDIATE");
    try {
      const previous = db.prepare("SELECT * FROM runtime_task_versions WHERE plan_id=? AND status='published'").get(row.plan_id);
      if (previous) {
        const transition = db.prepare("UPDATE runtime_task_versions SET status='superseded',superseded_at=?,updated_at=? WHERE id=? AND plan_id=? AND status='published'")
          .run(publishedAt, publishedAt, previous.id, row.plan_id);
        if (transition.changes === 1) {
          event(db, row.plan_id, previous.id, null, "superseded", context,
            { versionNo: previous.version_no, supersededByVersionNo: row.version_no });
        }
      }
      db.prepare(`UPDATE runtime_task_versions SET status='published',due_at=?,content_digest=?,
        published_at=?,published_by_context=?,publish_client_request_id=?,updated_at=? WHERE id=? AND status='draft'`)
        .run(dueAt, contentDigest, publishedAt, context, requestId, publishedAt, versionId);
      const insert = db.prepare(`INSERT INTO runtime_task_assignments
        (id,task_version_id,student_id,student_no,tier_code,assigned_reason,
         completion_status,created_at,updated_at) VALUES (?,?,?,?,?,?,'pending',?,?)`);
      for (const item of mapped.resolved) {
        const assignmentId = id("ta");
        insert.run(assignmentId, versionId, item.studentId, item.studentNo, item.tierCode,
          `本轮研判分层：${TIERS[item.tierCode].label}`, publishedAt, publishedAt);
      }
      event(db, row.plan_id, versionId, null, "published", context,
        { versionNo: row.version_no, assignedCount: mapped.resolved.length, tierCounts: tierCounts(snapshot) });
      db.prepare("UPDATE runtime_task_plans SET updated_at=? WHERE id=?").run(publishedAt, row.plan_id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    audit({ actorRole: "teacher", context, action: "task_published", objectType: "task_version",
      objectRef: versionId, result: "success", planId: row.plan_id, versionId,
      versionNo: row.version_no, assignedCount: mapped.resolved.length });
    return publishResult(db.prepare("SELECT * FROM runtime_task_versions WHERE id=?").get(versionId));
  }

  function publishResult(row) {
    const snapshot = json(row.stratification_snapshot_json);
    const assignedCount = db.prepare("SELECT COUNT(*) AS count FROM runtime_task_assignments WHERE task_version_id=?").get(row.id).count;
    return { planId: row.plan_id, versionId: row.id, versionNo: row.version_no, status: row.status,
      publishedAt: row.published_at, dueAt: row.due_at, assignedCount, tierCounts: tierCounts(snapshot),
      contentDigest: row.content_digest };
  }

  function revise(versionId, { context }) {
    contextInfo(baseDb, context);
    const row = requireOwnedVersion(versionId, context);
    if (row.status === "draft") return mapVersion(row);
    const existing = db.prepare("SELECT * FROM runtime_task_versions WHERE plan_id=? AND status='draft' ORDER BY version_no DESC LIMIT 1").get(row.plan_id);
    if (existing) return mapVersion(existing);
    const next = db.prepare("SELECT COALESCE(MAX(version_no),0)+1 AS n FROM runtime_task_versions WHERE plan_id=?").get(row.plan_id).n;
    const version = id("tv"), createdAt = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`INSERT INTO runtime_task_versions
        (id,plan_id,version_no,status,source_analysis_run_id,source_batch_id,
         source_evidence_json,stratification_snapshot_json,task_content_json,
         weakest_knowledge_point,due_at,draft_source,created_by_context,created_at,updated_at)
        VALUES (?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?)`).run(version, row.plan_id, next,
          row.source_analysis_run_id, row.source_batch_id, row.source_evidence_json,
          row.stratification_snapshot_json, row.task_content_json, row.weakest_knowledge_point,
          row.due_at, row.draft_source, context, createdAt, createdAt);
      event(db, row.plan_id, version, null, "draft_created", context, { versionNo: next, revisedFrom: row.version_no });
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return mapVersion(db.prepare("SELECT * FROM runtime_task_versions WHERE id=?").get(version));
  }

  function revoke(versionId, { context, reason }) {
    contextInfo(baseDb, context);
    const row = requireOwnedVersion(versionId, context);
    if (row.status !== "published") throw new TaskError("TASK_VERSION_NOT_ACTIVE", "只有当前已发布版本可以撤回。", 409);
    const savedReason = clean(reason, 201);
    if (!savedReason || savedReason.length > 200) throw new TaskError("TASK_REVOKE_REASON_INVALID", "撤回理由需为 1–200 字。", 400);
    const revokedAt = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`UPDATE runtime_task_versions SET status='revoked',revoked_at=?,revoked_by_context=?,
        revoke_reason=?,updated_at=? WHERE id=? AND status='published'`)
        .run(revokedAt, context, savedReason, revokedAt, versionId);
      const completed = db.prepare("SELECT COUNT(*) AS count FROM runtime_task_assignments WHERE task_version_id=? AND completion_status='completed'").get(versionId).count;
      event(db, row.plan_id, versionId, null, "revoked", context,
        { versionNo: row.version_no, completedCount: completed, reason: savedReason.slice(0, 80) });
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    audit({ actorRole: "teacher", context, action: "task_revoked", objectType: "task_version",
      objectRef: versionId, result: "success", planId: row.plan_id, versionId, versionNo: row.version_no });
    return mapVersion(db.prepare("SELECT * FROM runtime_task_versions WHERE id=?").get(versionId));
  }

  function assignmentView(row) {
    const tasks = json(row.task_content_json);
    const item = tasks[row.tier_code] || {};
    return { assignmentId: row.assignment_id, planId: row.plan_id, versionId: row.version_id,
      versionNo: row.version_no, versionStatus: row.version_status, tierCode: row.tier_code,
      tierLabel: TIERS[row.tier_code]?.label || row.tier_code, title: item.title, detail: item.detail,
      durationMinutes: item.durationMinutes, dueAt: row.due_at, completionStatus: row.completion_status,
      completedAt: row.completed_at, feedback: row.feedback_text, publishedAt: row.published_at,
      revokedAt: row.revoked_at, source: { analysisRunId: row.source_analysis_run_id,
        weakestKnowledgePoint: row.weakest_knowledge_point } };
  }

  const assignmentSelect = `
    SELECT a.id AS assignment_id,a.tier_code,a.completion_status,a.completed_at,a.feedback_text,
      v.id AS version_id,v.version_no,v.status AS version_status,v.task_content_json,v.due_at,
      v.published_at,v.revoked_at,v.source_analysis_run_id,v.weakest_knowledge_point,
      p.id AS plan_id,p.offering_id
    FROM runtime_task_assignments a
    JOIN runtime_task_versions v ON v.id=a.task_version_id
    JOIN runtime_task_plans p ON p.id=v.plan_id`;

  function studentTasks({ studentContext, offeringId, history = false }) {
    const student = studentCourse(baseDb, studentContext, offeringId);
    const statusClause = history ? "" : " AND v.status='published'";
    const rows = db.prepare(`${assignmentSelect}
      WHERE a.student_id=? AND p.offering_id=?${statusClause}
      ORDER BY v.created_at DESC LIMIT ?`).all(student.student_id, Number(offeringId), history ? 50 : 20);
    return { course: { offeringId: student.offering_id, courseCode: student.course_code, courseName: student.course_name },
      [history ? "history" : "activeAssignments"]: rows.map(assignmentView) };
  }

  function complete(assignmentId, { studentContext, feedback, clientRequestId }) {
    const parsed = parseStudentContext(studentContext);
    const requestId = clean(clientRequestId, 120);
    if (!requestId) throw new TaskError("TASK_COMPLETION_REQUEST_INVALID", "完成请求缺少幂等标识。", 400);
    const rawFeedback = String(feedback ?? "");
    if (rawFeedback.length > 500) throw new TaskError("TASK_FEEDBACK_TOO_LONG", "完成反馈不能超过 500 字。", 400);
    const safeFeedback = redactFeedback(rawFeedback);
    const row = db.prepare(`${assignmentSelect} WHERE a.id=?`).get(assignmentId);
    if (!row) throw new TaskError("TASK_ASSIGNMENT_NOT_FOUND", "本人任务不存在。", 404);
    const student = studentCourse(baseDb, studentContext, row.offering_id);
    const owner = db.prepare("SELECT student_id,student_no,completion_client_request_id FROM runtime_task_assignments WHERE id=?").get(assignmentId);
    if (owner.student_id !== student.student_id || owner.student_no !== parsed.studentNo) {
      throw new TaskError("TASK_ASSIGNMENT_FORBIDDEN", "该任务不属于当前学生。", 403);
    }
    if (row.version_status === "revoked") throw new TaskError("TASK_VERSION_REVOKED", "该任务版本已撤回，不能继续提交。", 409);
    if (row.version_status !== "published") throw new TaskError("TASK_VERSION_NOT_ACTIVE", "该任务版本当前不可提交。", 409);
    if (row.completion_status === "completed") return { ...assignmentView(row), idempotent: true };
    const completedAt = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`UPDATE runtime_task_assignments SET completion_status='completed',completed_at=?,
        feedback_text=?,feedback_redacted=?,completion_client_request_id=?,updated_at=?
        WHERE id=? AND completion_status='pending'`).run(completedAt, safeFeedback || null,
          safeFeedback !== rawFeedback ? 1 : 0, requestId, completedAt, assignmentId);
      event(db, row.plan_id, row.version_id, assignmentId, "assignment_completed", studentContext,
        { versionNo: row.version_no, tierCode: row.tier_code });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      const prior = db.prepare("SELECT id FROM runtime_task_assignments WHERE completion_client_request_id=?").get(requestId);
      if (prior?.id === assignmentId) return { ...assignmentView(db.prepare(`${assignmentSelect} WHERE a.id=?`).get(assignmentId)), idempotent: true };
      throw error;
    }
    audit({ actorRole: "student", context: studentContext, action: "task_assignment_completed",
      objectType: "task_assignment", objectRef: assignmentId, result: "success",
      planId: row.plan_id, versionId: row.version_id, versionNo: row.version_no });
    return assignmentView(db.prepare(`${assignmentSelect} WHERE a.id=?`).get(assignmentId));
  }

  function feedback(versionId, context) {
    const row = requireOwnedVersion(versionId, context);
    const counts = db.prepare(`SELECT tier_code,COUNT(*) AS assigned,
      SUM(CASE WHEN completion_status='completed' THEN 1 ELSE 0 END) AS completed
      FROM runtime_task_assignments WHERE task_version_id=? GROUP BY tier_code`).all(versionId);
    const byTier = Object.fromEntries(Object.keys(TIERS).map((tier) => [tier, { assigned: 0, completed: 0 }]));
    for (const count of counts) byTier[count.tier_code] = { assigned: count.assigned, completed: count.completed };
    const assignedCount = counts.reduce((sum, item) => sum + item.assigned, 0);
    const completedCount = counts.reduce((sum, item) => sum + item.completed, 0);
    const recentFeedback = db.prepare(`SELECT student_no,tier_code,feedback_text,completed_at
      FROM runtime_task_assignments WHERE task_version_id=? AND completion_status='completed'
      AND feedback_text IS NOT NULL ORDER BY completed_at DESC LIMIT 20`).all(versionId)
      .map((item) => ({ studentRef: studentRef(item.student_no), tierCode: item.tier_code,
        feedback: item.feedback_text, completedAt: item.completed_at }));
    audit({ actorRole: "teacher", context, action: "read_task_feedback", objectType: "task_version",
      objectRef: versionId, result: "success", planId: row.plan_id, versionId, versionNo: row.version_no });
    return { versionId, versionNo: row.version_no, status: row.status, assignedCount, completedCount,
      pendingCount: assignedCount - completedCount,
      completionRate: assignedCount ? Math.round(completedCount / assignedCount * 1000) / 10 : 0,
      byTier, recentFeedback };
  }

  function teacherTasks(context) {
    const info = contextInfo(baseDb, context);
    const plans = db.prepare("SELECT * FROM runtime_task_plans WHERE context_key=? ORDER BY created_at DESC").all(context);
    return plans.map((plan) => {
      const versions = db.prepare("SELECT * FROM runtime_task_versions WHERE plan_id=? ORDER BY version_no DESC").all(plan.id)
        .map((row) => ({ ...mapVersion(row), ...feedback(row.id, context) }));
      return { planId: plan.id, context, course: { offeringId: info.offeringId, courseCode: info.courseCode,
        courseName: info.courseName }, currentVersion: versions.find((item) => item.status === "published") || versions[0] || null,
        versions };
    });
  }

  function feedbackSummary(context) {
    contextInfo(baseDb, context);
    const row = db.prepare(`SELECT v.id FROM runtime_task_versions v JOIN runtime_task_plans p ON p.id=v.plan_id
      WHERE p.context_key=? AND v.status IN ('published','revoked','superseded')
      ORDER BY COALESCE(v.published_at,v.updated_at) DESC LIMIT 1`).get(context);
    if (!row) return null;
    return { ...feedback(row.id, context), generatedAt: now(),
      note: "上一轮任务反馈，仅作为辅助证据，不参与本次分数计算" };
  }

  function versionScope(versionId) {
    return db.prepare(`SELECT p.context_key AS context,p.offering_id AS offeringId,p.class_id AS classId
      FROM runtime_task_versions v JOIN runtime_task_plans p ON p.id=v.plan_id
      WHERE v.id=?`).get(versionId) || null;
  }

  function assignmentScope(assignmentId) {
    return db.prepare(`SELECT p.context_key AS context,p.offering_id AS offeringId,p.class_id AS classId,
      a.student_id AS studentId,a.student_no AS studentNo
      FROM runtime_task_assignments a
      JOIN runtime_task_versions v ON v.id=a.task_version_id
      JOIN runtime_task_plans p ON p.id=v.plan_id
      WHERE a.id=?`).get(assignmentId) || null;
  }

  return { createDraft, updateDraft, publish, revise, revoke, studentTasks, complete,
    feedback, teacherTasks, feedbackSummary, getVersion, versionScope, assignmentScope };
}

export { TIERS };
