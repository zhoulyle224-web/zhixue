import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCHEMA_PATH = resolve(ROOT, "db", "runtime-schema.sql");
export const DEFAULT_RUNTIME_DB = resolve(ROOT, "data", "runtime", "zhixue_runtime.sqlite");

function mapBatch(row) {
  if (!row) return null;
  return {
    batchId: row.id,
    context: row.context_key,
    status: row.status,
    file: {
      name: row.file_name,
      format: row.file_format,
      sizeBytes: row.file_size_bytes,
      sha256: row.file_sha256,
    },
    quality: {
      totalRows: row.total_rows,
      validRows: row.valid_rows,
      invalidRows: row.invalid_rows,
      duplicateRows: row.duplicate_rows,
      warningRows: row.warning_rows,
      blockingIssueCount: row.blocking_issue_count,
      warningIssueCount: row.warning_issue_count,
      validRate: row.total_rows
        ? Math.round((row.valid_rows / row.total_rows) * 1000) / 10
        : 0,
    },
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    confirmedByContext: row.confirmed_by_context,
  };
}

function mapIssue(row) {
  return {
    rowNumber: row.row_number,
    field: row.field_name,
    code: row.issue_code,
    type: row.issue_type,
    severity: row.severity,
    message: row.message,
    rawValue: row.raw_value_redacted,
  };
}

function mapAnalysis(row, batch) {
  if (!row) return null;
  const saved = JSON.parse(row.result_json);
  const evidence = {
    ...saved._evidence,
    analysisRunId: row.id,
    batchId: row.batch_id,
    context: row.context_key,
    fileName: batch.file.name,
    fileHash: batch.file.sha256,
    fileSha256: batch.file.sha256,
    sha256: batch.file.sha256,
    validRows: batch.quality.validRows,
    excludedRows: batch.quality.invalidRows,
    studentCount: saved.overall_summary?.total_students ?? saved._evidence?.studentCount ?? 0,
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    analyzedAt: row.generated_at,
    generatedAt: row.generated_at,
  };
  return {
    analysisRunId: row.id,
    analysisId: row.id,
    batchId: row.batch_id,
    context: row.context_key,
    status: row.status,
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    inputDigest: row.input_digest,
    analyzedAt: row.generated_at,
    generatedAt: row.generated_at,
    result: { ...saved, _evidence: evidence },
    _evidence: evidence,
  };
}

function mapQa(row) {
  if (!row) return null;
  return {
    questionId: row.id, clientRequestId: row.client_request_id,
    studentContext: row.student_context, studentNo: row.student_no,
    classId: row.class_id, offeringId: row.offering_id,
    course: { offeringId: row.offering_id, courseId: row.course_id, courseCode: row.course_code, courseName: row.course_name },
    question: row.question_text_redacted, status: row.answer_status,
    assistantAnswer: row.assistant_answer, evidence: JSON.parse(row.evidence_json),
    relatedKnowledge: JSON.parse(row.related_knowledge_json),
    guideQuestions: JSON.parse(row.guide_questions_json),
    knowledgeVersion: row.knowledge_version, skillId: row.skill_id, skillVersion: row.skill_version,
    handoffStatus: row.handoff_status, teacherContext: row.teacher_context,
    teacherReply: row.teacher_reply, createdAt: row.created_at,
    answeredAt: row.answered_at, repliedAt: row.replied_at, updatedAt: row.updated_at,
    sessionId: row.session_id || null,
    answerState: row.answer_state || (row.answer_status === "answered" ? "已解答" : "建议转教师"),
    answerSourceType: row.answer_source_type || "当前课程资料",
    modelProvider: row.model_provider || "offline",
    confidence: row.confidence || "中",
    personalizationBasis: JSON.parse(row.personalization_basis_json || "[]"),
  };
}

export function createRuntimeStore(dbPath = DEFAULT_RUNTIME_DB) {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  // Compatibility migration: older M2 runs were successful but lacked run status.
  db.exec("BEGIN IMMEDIATE");
  try {
    const columns = db.prepare("PRAGMA table_info(runtime_analysis_runs)").all();
    if (!columns.some((column) => column.name === "status")) {
      db.exec("ALTER TABLE runtime_analysis_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('running', 'completed', 'failed'))");
    }
    const qaColumns = db.prepare("PRAGMA table_info(runtime_qa_records)").all();
    const ensureQaColumn = (name, sql) => { if (!qaColumns.some(column => column.name === name)) db.exec(`ALTER TABLE runtime_qa_records ADD COLUMN ${sql}`); };
    ensureQaColumn("session_id", "session_id TEXT");
    ensureQaColumn("answer_state", "answer_state TEXT");
    ensureQaColumn("answer_source_type", "answer_source_type TEXT");
    ensureQaColumn("model_provider", "model_provider TEXT");
    ensureQaColumn("confidence", "confidence TEXT");
    ensureQaColumn("personalization_basis_json", "personalization_basis_json TEXT NOT NULL DEFAULT '[]'");
    // 'analyzed' was a presentation state in M2; confirmation remains the batch fact.
    db.prepare("UPDATE runtime_import_batches SET status = 'confirmed' WHERE status = 'analyzed' AND confirmed_at IS NOT NULL").run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }

  const insertBatch = db.prepare(`
    INSERT INTO runtime_import_batches
      (id, context_key, file_name, file_format, file_size_bytes, file_sha256,
       total_rows, valid_rows, invalid_rows, duplicate_rows, warning_rows,
       blocking_issue_count, warning_issue_count, status, schema_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'validated', 1, ?)
  `);
  const insertRecord = db.prepare(`
    INSERT INTO runtime_import_records
      (batch_id, row_number, anonymous_id, knowledge_point, score, completed_at,
       is_valid, excluded_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertIssue = db.prepare(`
    INSERT INTO runtime_quality_issues
      (batch_id, row_number, field_name, issue_code, issue_type, severity,
       message, raw_value_redacted, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function writeBatch({ batch, records, issues }) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const q = batch.quality;
      insertBatch.run(
        batch.batchId, batch.context, batch.file.name, batch.file.format,
        batch.file.sizeBytes, batch.file.sha256, q.totalRows, q.validRows,
        q.invalidRows, q.duplicateRows, q.warningRows, q.blockingIssueCount,
        q.warningIssueCount, batch.createdAt,
      );
      for (const record of records) {
        insertRecord.run(
          batch.batchId, record.rowNumber, record.anonymousId,
          record.knowledgePoint, record.score, record.completedAt,
          record.isValid ? 1 : 0, record.excludedReason,
        );
      }
      for (const issue of issues) {
        insertIssue.run(
          batch.batchId, issue.rowNumber, issue.field, issue.code, issue.type,
          issue.severity, issue.message, issue.rawValue, batch.createdAt,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return getBatch(batch.batchId);
  }

  function getBatch(batchId) {
    return mapBatch(db.prepare("SELECT * FROM runtime_import_batches WHERE id = ?").get(batchId));
  }

  function getLatest(context) {
    const row = db.prepare(`
      SELECT * FROM runtime_import_batches
      WHERE context_key = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(context);
    return mapBatch(row);
  }

  function getIssues(batchId, limit = 500) {
    return db.prepare(`
      SELECT * FROM runtime_quality_issues
      WHERE batch_id = ?
      ORDER BY row_number, id LIMIT ?
    `).all(batchId, limit).map(mapIssue);
  }

  function getValidRecords(batchId) {
    return db.prepare(`
      SELECT row_number AS rowNumber, anonymous_id AS anonymousId,
             knowledge_point AS knowledgePoint, score, completed_at AS completedAt
      FROM runtime_import_records
      WHERE batch_id = ? AND is_valid = 1
      ORDER BY row_number
    `).all(batchId);
  }

  function confirmBatch(batchId, context) {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE runtime_import_batches
      SET status = 'confirmed', confirmed_at = ?, confirmed_by_context = ?
      WHERE id = ? AND context_key = ? AND status = 'validated' AND valid_rows > 0
    `).run(now, context, batchId, context);
    return getBatch(batchId);
  }

  function writeAnalysis({ batchId, context, skillId, skillVersion, inputDigest, result, evidence }) {
    const analyzedAt = new Date().toISOString();
    const analysisRunId = `analysis_${randomUUID()}`;
    db.exec("BEGIN IMMEDIATE");
    try {
      const batch = db.prepare("SELECT status, context_key, confirmed_at FROM runtime_import_batches WHERE id = ?").get(batchId);
      if (!batch || batch.status !== "confirmed" || !batch.confirmed_at || batch.context_key !== context) {
        throw new Error("BATCH_NOT_CONFIRMED");
      }
      const persistedResult = { ...result, _evidence: {
        ...evidence, analysisRunId, batchId, context, skillId, skillVersion,
        analyzedAt, generatedAt: analyzedAt,
      } };
      db.prepare(`
        INSERT INTO runtime_analysis_runs
          (id, batch_id, context_key, status, skill_id, skill_version, input_digest,
           result_json, generated_at)
        VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?)
      `).run(
        analysisRunId, batchId, context, skillId, skillVersion, inputDigest,
        JSON.stringify(persistedResult), analyzedAt,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return getAnalysisRun(analysisRunId);
  }

  function getLatestAnalysis(batchId) {
    const batch = getBatch(batchId);
    if (!batch || batch.status !== "confirmed" || !batch.confirmedAt) return null;
    const row = db.prepare(`
      SELECT * FROM runtime_analysis_runs
      WHERE batch_id = ? AND context_key = ? AND status = 'completed'
      ORDER BY generated_at DESC, rowid DESC LIMIT 1
    `).get(batchId, batch.context);
    return row ? mapAnalysis(row, batch) : null;
  }

  function getLatestCompletedAnalysis(context) {
    const row = db.prepare(`
      SELECT a.* FROM runtime_analysis_runs a
      JOIN runtime_import_batches b ON b.id = a.batch_id
      WHERE a.context_key = ? AND a.status = 'completed'
        AND b.context_key = ? AND b.status = 'confirmed' AND b.confirmed_at IS NOT NULL
      ORDER BY b.confirmed_at DESC, b.rowid DESC, a.generated_at DESC, a.rowid DESC LIMIT 1
    `).get(context, context);
    return row ? mapAnalysis(row, getBatch(row.batch_id)) : null;
  }

  function getAnalysisRun(analysisRunId) {
    const row = db.prepare("SELECT * FROM runtime_analysis_runs WHERE id = ?").get(analysisRunId);
    return row ? mapAnalysis(row, getBatch(row.batch_id)) : null;
  }

  function getQa(questionId) {
    return mapQa(db.prepare("SELECT * FROM runtime_qa_records WHERE id = ?").get(questionId));
  }

  function getQaByRequest(studentContext, clientRequestId) {
    return mapQa(db.prepare("SELECT * FROM runtime_qa_records WHERE student_context = ? AND client_request_id = ?")
      .get(studentContext, clientRequestId));
  }

  function writeQa(record) {
    const now = new Date().toISOString();
    const id = `qa_${randomUUID()}`;
    db.prepare(`INSERT INTO runtime_qa_records
      (id, client_request_id, student_context, student_no, class_id, offering_id,
       course_id, course_code, course_name, question_text_redacted, answer_status,
       assistant_answer, evidence_json, related_knowledge_json, guide_questions_json,
       knowledge_version, skill_id, skill_version, handoff_status, teacher_context,
       created_at, answered_at, updated_at, session_id, answer_state,
       answer_source_type, model_provider, confidence, personalization_basis_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, record.clientRequestId, record.studentContext, record.studentNo,
      record.classId, record.offeringId, record.courseId, record.courseCode,
      record.courseName, record.question, record.status, record.assistantAnswer,
      JSON.stringify(record.evidence), JSON.stringify(record.relatedKnowledge),
      JSON.stringify(record.guideQuestions), record.knowledgeVersion,
      record.skillId, record.skillVersion, record.handoffStatus,
      record.teacherContext, now, record.status === "answered" ? now : null, now,
      record.sessionId || null, record.answerState || null, record.answerSourceType || null,
      record.modelProvider || "offline", record.confidence || null,
      JSON.stringify(record.personalizationBasis || []),
    );
    return getQa(id);
  }

  function getStudentQa(studentContext, offeringId, limit = 20) {
    return db.prepare(`SELECT * FROM runtime_qa_records
      WHERE student_context = ? AND offering_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(studentContext, offeringId, limit).map(mapQa);
  }

  function createQaSession(studentContext, offeringId, title = "新对话") {
    const now = new Date().toISOString(), sessionId = `qs_${randomUUID()}`;
    db.prepare("INSERT INTO runtime_qa_sessions_v2(id,student_context,offering_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(sessionId, studentContext, offeringId, String(title).slice(0, 80), now, now);
    return { sessionId, studentContext, offeringId, title: String(title).slice(0, 80), createdAt: now, updatedAt: now };
  }

  function getQaSession(sessionId) {
    return db.prepare("SELECT * FROM runtime_qa_sessions_v2 WHERE id=?").get(sessionId) || null;
  }

  function getQaSessionHistory(sessionId, limit = 8) {
    return db.prepare("SELECT * FROM runtime_qa_records WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?")
      .all(sessionId, limit).reverse().map(mapQa);
  }

  function getTeacherQa(offeringId, classId, status = "all", limit = 50) {
    const where = status === "pending" ? " AND answer_status = 'pending_teacher'" :
      status === "replied" ? " AND answer_status = 'teacher_replied'" :
      status === "answered" ? " AND answer_status = 'answered'" : "";
    return db.prepare(`SELECT * FROM runtime_qa_records WHERE offering_id = ? AND class_id = ?${where}
      ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(offeringId, classId, limit).map(mapQa);
  }

  function replyQa(questionId, teacherContext, reply) {
    const now = new Date().toISOString();
    db.prepare(`UPDATE runtime_qa_records SET teacher_reply = ?, answer_status = 'teacher_replied',
      handoff_status = 'replied', replied_at = ?, updated_at = ?
      WHERE id = ? AND teacher_context = ? AND answer_status IN ('pending_teacher','teacher_replied')`)
      .run(reply, now, now, questionId, teacherContext);
    return getQa(questionId);
  }

  function handoffQa(questionId, studentContext) {
    const now = new Date().toISOString();
    db.prepare(`UPDATE runtime_qa_records SET answer_status='pending_teacher',handoff_status='pending',
      answer_state='已转教师',updated_at=? WHERE id=? AND student_context=?
      AND answer_status='answered' AND handoff_status='not_required'`).run(now, questionId, studentContext);
    return getQa(questionId);
  }

  function writeExportAudit(row) {
    db.prepare(`INSERT INTO runtime_export_audits
      (id,export_id,account_id,actor_role,actor_ref_code,scope_type,scope_ref,
       export_kind,export_format,watermark_id,policy_version,source_refs_json,
       record_count,content_size_bytes,content_digest,result,failure_code,
       generated_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.id, row.exportId ?? null, row.accountId ?? null, row.actorRole || "unknown",
      row.actorRefCode ?? null, row.scopeType, row.scopeRef, row.exportKind,
      row.exportFormat, row.watermarkId ?? null, row.policyVersion,
      JSON.stringify(row.sourceRefs || {}), Number(row.recordCount || 0),
      row.contentSizeBytes ?? null, row.contentDigest ?? null, row.result,
      row.failureCode ?? null, row.generatedAt ?? null, row.createdAt,
    );
    return getExportAudit(row.exportId);
  }

  function getExportAudit(exportId) {
    return db.prepare("SELECT * FROM runtime_export_audits WHERE export_id=?").get(exportId) || null;
  }

  return {
    writeBatch,
    getBatch,
    getLatest,
    getIssues,
    getValidRecords,
    confirmBatch,
    writeAnalysis,
    getLatestAnalysis,
    getLatestCompletedAnalysis,
    getAnalysisRun,
    getQa,
    getQaByRequest,
    writeQa,
    getStudentQa,
    getTeacherQa,
    replyQa,
    handoffQa,
    createQaSession,
    getQaSession,
    getQaSessionHistory,
    writeExportAudit,
    getExportAudit,
    // Internal server services share this connection so multi-table M3 writes
    // can be committed in one SQLite transaction. It is never exposed by HTTP.
    taskDatabase: db,
    close: () => db.close(),
  };
}
