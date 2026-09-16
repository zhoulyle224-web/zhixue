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

  function getAnalysisRun(analysisRunId) {
    const row = db.prepare("SELECT * FROM runtime_analysis_runs WHERE id = ?").get(analysisRunId);
    return row ? mapAnalysis(row, getBatch(row.batch_id)) : null;
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
    getAnalysisRun,
    close: () => db.close(),
  };
}
