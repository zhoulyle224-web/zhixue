import { createHash, randomUUID } from "node:crypto";
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
    aiRunId: row.ai_run_id || null,
    generationStatus: row.generation_status || "degraded_offline",
    aiGenerated: Number(row.ai_generated || 0) === 1,
  };
}

function stableDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mapAiRun(row) {
  if (!row) return null;
  return {
    aiRunId: row.id, requestId: row.request_id, purpose: row.purpose,
    skillId: row.skill_id, skillVersion: row.skill_version,
    actorId: row.actor_id, tenantId: row.tenant_id, courseId: row.course_id,
    sessionId: row.session_id, providerId: row.provider_id, model: row.model,
    modelRevision: row.model_revision, status: row.status,
    evidence: JSON.parse(row.evidence_json || "[]"),
    tokenUsage: JSON.parse(row.token_usage_json || "{}"),
    safetyFlags: JSON.parse(row.safety_flags_json || "[]"),
    providerRequestId: row.provider_request_id, errorCode: row.error_code,
    latencyMs: row.latency_ms, createdAt: row.created_at,
    updatedAt: row.updated_at, persistedAt: row.persisted_at,
  };
}

export function createRuntimeStore(dbPath = DEFAULT_RUNTIME_DB, {
  environment = process.env.ZHIXUE_ENVIRONMENT || "demo",
  namespace = "learning-events",
} = {}) {
  if (!['demo', 'test', 'production'].includes(environment)) throw new Error("RUNTIME_ENVIRONMENT_INVALID");
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
    ensureQaColumn("ai_run_id", "ai_run_id TEXT");
    ensureQaColumn("generation_status", "generation_status TEXT NOT NULL DEFAULT 'degraded_offline'");
    ensureQaColumn("ai_generated", "ai_generated INTEGER NOT NULL DEFAULT 0 CHECK (ai_generated IN (0,1))");
    const accountColumns = db.prepare("PRAGMA table_info(runtime_auth_accounts)").all();
    if (!accountColumns.some((column) => column.name === "can_manage_ai")) {
      db.exec("ALTER TABLE runtime_auth_accounts ADD COLUMN can_manage_ai INTEGER NOT NULL DEFAULT 0 CHECK (can_manage_ai IN (0,1))");
    }
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
      db.prepare(`INSERT INTO runtime_raw_batches
        (batch_id,environment,namespace,source_type,source_digest,synthetic,received_at)
        VALUES(?,?,?,?,?,?,?)`).run(
        batch.batchId, environment, namespace, `file:${batch.file.format}`,
        batch.file.sha256, environment === "demo" ? 1 : 0, batch.createdAt,
      );
      const issueCodes = new Map();
      for (const issue of issues) {
        const codes = issueCodes.get(issue.rowNumber) || [];
        codes.push(issue.code);
        issueCodes.set(issue.rowNumber, codes);
      }
      for (const record of records) {
        insertRecord.run(
          batch.batchId, record.rowNumber, record.anonymousId,
          record.knowledgePoint, record.score, record.completedAt,
          record.isValid ? 1 : 0, record.excludedReason,
        );
        const safeRecord = {
          anonymousId: record.anonymousId, knowledgePoint: record.knowledgePoint,
          score: record.score, completedAt: record.completedAt,
        };
        const codes = issueCodes.get(record.rowNumber) || [];
        const qualityStatus = record.isValid ? (codes.length ? "warning" : "valid") : "invalid";
        db.prepare(`INSERT INTO runtime_staging_records
          (batch_id,row_number,record_json,record_fingerprint,quality_status)
          VALUES(?,?,?,?,?)`).run(batch.batchId, record.rowNumber, JSON.stringify(safeRecord), stableDigest(safeRecord), qualityStatus);
        if (!record.isValid) db.prepare(`INSERT INTO runtime_quarantine_records
          (batch_id,row_number,reason_codes_json,record_json,quarantined_at)
          VALUES(?,?,?,?,?)`).run(batch.batchId, record.rowNumber, JSON.stringify(codes), JSON.stringify(safeRecord), batch.createdAt);
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
    db.exec("BEGIN IMMEDIATE");
    try {
      const update = db.prepare(`UPDATE runtime_import_batches
        SET status = 'confirmed', confirmed_at = ?, confirmed_by_context = ?
        WHERE id = ? AND context_key = ? AND status = 'validated' AND valid_rows > 0`)
        .run(now, context, batchId, context);
      if (update.changes) {
        const previous = db.prepare(`SELECT id FROM runtime_data_versions
          WHERE environment=? AND namespace=? AND context_key=? AND status='active'`).get(environment, namespace, context);
        const versionId = `dv_${randomUUID()}`;
        db.prepare(`INSERT INTO runtime_data_versions
          (id,environment,namespace,context_key,batch_id,status,rule_version,parent_version_id,created_at)
          VALUES(?,?,?,?,?,'building','round3-v1',?,?)`).run(versionId, environment, namespace, context, batchId, previous?.id || null, now);
        const rows = db.prepare(`SELECT row_number,anonymous_id,knowledge_point,score,completed_at
          FROM runtime_import_records WHERE batch_id=? AND is_valid=1 ORDER BY row_number`).all(batchId);
        const insertCurated = db.prepare(`INSERT OR IGNORE INTO runtime_curated_records
          (data_version_id,environment,namespace,context_key,source_event_id,record_json,synthetic,created_at)
          VALUES(?,?,?,?,?,?,?,?)`);
        for (const row of rows) {
          const record = { anonymousId: row.anonymous_id, knowledgePoint: row.knowledge_point, score: row.score, completedAt: row.completed_at };
          insertCurated.run(versionId, environment, namespace, context, stableDigest(record), JSON.stringify(record), environment === 'demo' ? 1 : 0, now);
        }
        if (previous) db.prepare("UPDATE runtime_data_versions SET status='inactive' WHERE id=?").run(previous.id);
        db.prepare(`UPDATE runtime_data_versions SET status='active',activated_at=?,activated_by_context=? WHERE id=?`).run(now, context, versionId);
        db.prepare(`UPDATE runtime_serving_snapshots SET status='stale'
          WHERE environment=? AND namespace=? AND context_key=? AND status='active'`).run(environment, namespace, context);
        const effectiveCount = db.prepare(`SELECT COUNT(*) count FROM runtime_curated_records
          WHERE data_version_id=? AND synthetic=?`).get(versionId, environment === 'production' ? 0 : 1).count;
        db.prepare(`INSERT INTO runtime_serving_snapshots
          (id,data_version_id,environment,namespace,context_key,status,payload_json,generated_at)
          VALUES(?,?,?,?,?,'active',?,?)`).run(`sv_${randomUUID()}`, versionId, environment, namespace, context, JSON.stringify({ effectiveRecordCount: effectiveCount, sourceVersion: versionId }), now);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return getBatch(batchId);
  }

  function getGovernanceStatus(context) {
    const active = db.prepare(`SELECT * FROM runtime_data_versions
      WHERE environment=? AND namespace=? AND context_key=? AND status='active'`).get(environment, namespace, context);
    const counts = active ? db.prepare(`SELECT
      (SELECT COUNT(*) FROM runtime_staging_records WHERE batch_id=?) staging,
      (SELECT COUNT(*) FROM runtime_quarantine_records WHERE batch_id=?) quarantine,
      (SELECT COUNT(*) FROM runtime_curated_records WHERE data_version_id=?) curated`).get(active.batch_id, active.batch_id, active.id) : { staging: 0, quarantine: 0, curated: 0 };
    return { environment, namespace, activeDataVersion: active?.id || null, sourceBatchId: active?.batch_id || null, counts };
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
       answer_source_type, model_provider, confidence, personalization_basis_json,
       ai_run_id, generation_status, ai_generated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
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
      record.aiRunId || null, record.generationStatus || "degraded_offline",
      record.aiGenerated ? 1 : 0,
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

  function mapAiConfig(row) {
    return row ? {
      providerId: row.provider_id || "qwen", secretRef: row.secret_ref,
      keyLastFour: row.key_last_four, model: row.model || "qwen-plus",
      verificationStatus: row.verification_status, verifiedAt: row.verified_at,
      updatedByAccountId: row.updated_by_account_id, updatedAt: row.updated_at,
    } : null;
  }

  function listAiConfigs() {
    return db.prepare("SELECT * FROM runtime_ai_provider_configs ORDER BY provider_id").all().map(mapAiConfig);
  }

  function getAiConfig(providerId = null) {
    let row;
    if (providerId) row = db.prepare("SELECT * FROM runtime_ai_provider_configs WHERE provider_id=?").get(providerId);
    else row = db.prepare(`SELECT c.* FROM runtime_ai_provider_configs c
      JOIN runtime_ai_settings s ON s.id='default' AND s.active_provider_id=c.provider_id`).get();
    if (row) return mapAiConfig(row);
    const legacy = db.prepare("SELECT * FROM runtime_ai_config WHERE id='default'").get();
    return legacy ? mapAiConfig({ ...legacy, provider_id: "qwen", model: "qwen-plus" }) : null;
  }

  function saveAiConfig({ providerId = "qwen", secretRef, keyLastFour, model = "qwen-plus", accountId }) {
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`INSERT INTO runtime_ai_provider_configs
        (provider_id,secret_ref,key_last_four,model,verification_status,verified_at,updated_by_account_id,updated_at)
        VALUES(?,?,?,?,'verified',?,?,?)
        ON CONFLICT(provider_id) DO UPDATE SET secret_ref=excluded.secret_ref,
          key_last_four=excluded.key_last_four,model=excluded.model,verification_status='verified',
          verified_at=excluded.verified_at,updated_by_account_id=excluded.updated_by_account_id,
          updated_at=excluded.updated_at`).run(providerId, secretRef, keyLastFour, model, now, accountId, now);
      db.prepare(`INSERT INTO runtime_ai_settings (id,active_provider_id,updated_at)
        VALUES('default',?,?) ON CONFLICT(id) DO UPDATE SET
        active_provider_id=excluded.active_provider_id,updated_at=excluded.updated_at`).run(providerId, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return getAiConfig(providerId);
  }

  function createAiRun(row) {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO runtime_ai_runs
      (id,request_id,purpose,skill_id,skill_version,actor_id,tenant_id,course_id,
       session_id,status,input_digest,evidence_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'received',?,?,?,?)`).run(
      row.aiRunId, row.requestId, row.purpose, row.skillId, row.skillVersion,
      row.actorId, row.tenantId, row.courseId, row.sessionId,
      row.inputDigest, JSON.stringify(row.evidence || []), now, now,
    );
    return getAiRun(row.aiRunId);
  }

  function updateAiRun(aiRunId, patch) {
    const current = db.prepare("SELECT * FROM runtime_ai_runs WHERE id=?").get(aiRunId);
    if (!current) return null;
    const now = new Date().toISOString();
    db.prepare(`UPDATE runtime_ai_runs SET status=?,provider_id=?,model=?,model_revision=?,
      token_usage_json=?,safety_flags_json=?,provider_request_id=?,error_code=?,latency_ms=?,
      updated_at=?,persisted_at=? WHERE id=?`).run(
      patch.status || current.status,
      patch.providerId ?? current.provider_id, patch.model ?? current.model,
      patch.modelRevision ?? current.model_revision,
      patch.tokenUsage ? JSON.stringify(patch.tokenUsage) : current.token_usage_json,
      patch.safetyFlags ? JSON.stringify(patch.safetyFlags) : current.safety_flags_json,
      patch.providerRequestId ?? current.provider_request_id,
      patch.errorCode ?? current.error_code, patch.latencyMs ?? current.latency_ms,
      now, patch.persisted ? now : current.persisted_at, aiRunId,
    );
    return getAiRun(aiRunId);
  }

  function getAiRun(aiRunId) {
    return mapAiRun(db.prepare("SELECT * FROM runtime_ai_runs WHERE id=?").get(aiRunId));
  }

  return {
    writeBatch,
    getBatch,
    getLatest,
    getIssues,
    getValidRecords,
    confirmBatch,
    getGovernanceStatus,
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
    getAiConfig,
    listAiConfigs,
    saveAiConfig,
    createAiRun,
    updateAiRun,
    getAiRun,
    // Internal server services share this connection so multi-table M3 writes
    // can be committed in one SQLite transaction. It is never exposed by HTTP.
    taskDatabase: db,
    close: () => db.close(),
  };
}
