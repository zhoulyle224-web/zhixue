import { createHash, randomUUID } from "node:crypto";
import { parseCsv, CsvParseError } from "./csv-parser.mjs";

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const SKILL_ID = "academic-performance-analyzer";
export const SKILL_VERSION = "local-m2-20260917";
const FIELDS = {
  anonymous_id: ["anonymous_id", "匿名编号"],
  knowledge_point: ["knowledge_point", "知识点"],
  score: ["score", "得分"],
  completed_at: ["completed_at", "完成时间"],
};
const PHONE = /(?:^|\D)1[3-9]\d{9}(?:\D|$)/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const ID_CARD = /(?:^|\D)\d{17}[\dXx](?:\D|$)/;

export class ImportError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = {
      rowNumber: 0,
      issues: [{ rowNumber: 0, field: "file", code, type: "文件错误", severity: "blocking", message, rawValue: null }],
      ...details,
    };
  }
}

function safeName(value) {
  return String(value ?? "").replace(/[\\/\x00-\x1f]/g, "_").trim().slice(0, 160);
}

function formatFromName(fileName) {
  const extension = /\.([^.]+)$/.exec(fileName)?.[1]?.toLowerCase();
  if (extension !== "csv" && extension !== "json") {
    throw new ImportError("IMPORT_UNSUPPORTED_FILE", "仅支持 CSV 或 JSON 文件。", 400);
  }
  return extension;
}

function extractRows(format, content) {
  if (format === "csv") {
    let rows;
    try {
      rows = parseCsv(content);
    } catch (error) {
      if (error instanceof CsvParseError) {
        throw new ImportError("IMPORT_INVALID_CSV", error.message, 400, { rowNumber: 0 });
      }
      throw error;
    }
    if (!rows.length) throw new ImportError("IMPORT_EMPTY_FILE", "文件没有可读取的数据。", 400);
    const headings = rows[0].cells.map((item) => item.trim());
    const indices = Object.fromEntries(Object.entries(FIELDS).map(([field, aliases]) => [
      field, headings.findIndex((heading) => aliases.includes(heading)),
    ]));
    if ([indices.anonymous_id, indices.knowledge_point, indices.score].some((index) => index < 0)) {
      throw new ImportError("IMPORT_SCHEMA_MISMATCH", "缺少必需列：匿名编号、知识点、得分。完成时间可选。", 400);
    }
    return rows.slice(1).map((row) => ({
      rowNumber: row.rowNumber,
      values: Object.fromEntries(Object.entries(indices).map(([field, index]) => [field, row.cells[index] ?? ""])),
      lengthMismatch: row.cells.length !== headings.length,
    }));
  }
  let parsed;
  try {
    parsed = JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);
  } catch {
    throw new ImportError("IMPORT_INVALID_JSON", "JSON 格式错误。", 400, { rowNumber: 0 });
  }
  if (!Array.isArray(parsed)) {
    throw new ImportError("IMPORT_SCHEMA_MISMATCH", "JSON 顶层必须是对象数组。", 400, { rowNumber: 0 });
  }
  if (!parsed.length) throw new ImportError("IMPORT_EMPTY_FILE", "文件没有可读取的数据。", 400);
  const keys = new Set(parsed.flatMap((row) => row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : []));
  if ([FIELDS.anonymous_id, FIELDS.knowledge_point, FIELDS.score].some((aliases) => !aliases.some((alias) => keys.has(alias)))) {
    throw new ImportError("IMPORT_SCHEMA_MISMATCH", "缺少必需字段：匿名编号、知识点、得分。完成时间可选。", 400);
  }
  return parsed.map((row, index) => ({
    rowNumber: index + 1,
    values: row && typeof row === "object" && !Array.isArray(row)
      ? Object.fromEntries(Object.entries(FIELDS).map(([field, aliases]) => [
        field, row[aliases.find((alias) => Object.hasOwn(row, alias))] ?? "",
      ]))
      : {},
    lengthMismatch: false,
  }));
}

function validTimestamp(text) {
  if (!text) return true;
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(text)) return false;
  const time = Date.parse(text);
  if (!Number.isFinite(time)) return false;
  const [year, month, day] = text.slice(0, 10).split("-").map(Number);
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= maxDay;
}

export function validateImport({ context, fileName, content }) {
  if (typeof content !== "string") {
    throw new ImportError("IMPORT_EMPTY_FILE", "请提供文件文本内容。", 400);
  }
  const file = safeName(fileName);
  const format = formatFromName(file);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_IMPORT_BYTES) throw new ImportError("IMPORT_FILE_TOO_LARGE", "文件不得超过 10 MiB。", 413);
  if (!content.trim()) throw new ImportError("IMPORT_EMPTY_FILE", "文件内容为空。", 400);
  if (content.includes("\uFFFD")) {
    throw new ImportError(format === "csv" ? "IMPORT_INVALID_CSV" : "IMPORT_INVALID_JSON", "文件包含无法安全解码的字符，请使用 UTF-8。", 400);
  }
  const rows = extractRows(format, content);
  if (!rows.length) throw new ImportError("IMPORT_EMPTY_FILE", "文件没有数据行。", 400);

  const issues = [];
  const records = [];
  const preview = [];
  const seen = new Set();
  const quality = {
    totalRows: rows.length, validRows: 0, invalidRows: 0, duplicateRows: 0,
    warningRows: 0, blockingIssueCount: 0, warningIssueCount: 0, validRate: 0,
  };
  function issue(rowNumber, field, code, severity, message) {
    if (severity === "blocking") quality.blockingIssueCount += 1;
    else quality.warningIssueCount += 1;
    if (issues.length < 500) {
      const type = code === "EMPTY_REQUIRED_VALUE" ? "空值" : code === "SCORE_OUT_OF_RANGE" ? "范围异常" : code === "DUPLICATE_RECORD" ? "重复" : code === "PII_VALUE_DETECTED" ? "安全" : "格式错误";
      issues.push({ rowNumber, field, code, type, severity, message, rawValue: null });
    }
  }

  for (const row of rows) {
    const values = row.values;
    const anonymousId = String(values.anonymous_id ?? "").trim();
    const knowledgePoint = String(values.knowledge_point ?? "").trim();
    const rawScore = values.score;
    const scoreText = String(rawScore ?? "").trim();
    const completedText = String(values.completed_at ?? "").trim();
    let blocked = false;
    let warned = false;
    let pii = false;
    if (row.lengthMismatch) {
      issue(row.rowNumber, "row", "ROW_COLUMN_MISMATCH", "blocking", "列数与表头不一致，已排除。 ");
      blocked = true;
    }
    for (const [field, value] of [["anonymous_id", anonymousId], ["knowledge_point", knowledgePoint], ["score", scoreText]]) {
      if (!value) {
        issue(row.rowNumber, field, "EMPTY_REQUIRED_VALUE", "blocking", `${field} 不能为空，已排除。`);
        blocked = true;
      }
    }
    if ((values.anonymous_id !== undefined && values.anonymous_id !== null && typeof values.anonymous_id !== "string") ||
        (values.knowledge_point !== undefined && values.knowledge_point !== null && typeof values.knowledge_point !== "string")) {
      issue(row.rowNumber, "row", "INVALID_FIELD_TYPE", "blocking", "匿名编号和知识点必须为文本，已排除。 ");
      blocked = true;
    }
    if (anonymousId.length > 64 || knowledgePoint.length > 120 || completedText.length > 80) {
      issue(row.rowNumber, "row", "FIELD_TOO_LONG", "blocking", "字段过长，已排除。 ");
      blocked = true;
    }
    if (PHONE.test(anonymousId) || EMAIL.test(anonymousId) || ID_CARD.test(anonymousId)) {
      issue(row.rowNumber, "anonymous_id", "PII_VALUE_DETECTED", "blocking", "匿名编号疑似包含个人信息，已脱敏并排除。 ");
      blocked = true;
      pii = true;
    }
    const score = Number(scoreText);
    if (scoreText && (typeof rawScore === "boolean" || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(scoreText) || !Number.isFinite(score))) {
      issue(row.rowNumber, "score", "INVALID_SCORE_TYPE", "blocking", "得分必须为数字，已排除。 ");
      blocked = true;
    } else if (scoreText && (score < 0 || score > 100)) {
      issue(row.rowNumber, "score", "SCORE_OUT_OF_RANGE", "blocking", "得分必须在 0–100，已排除。 ");
      blocked = true;
    }
    let completedAt = completedText || null;
    if (completedText && (typeof values.completed_at !== "string" || !validTimestamp(completedText))) {
      issue(row.rowNumber, "completed_at", "INVALID_COMPLETED_AT", "warning", "完成时间无效，已置空；该行仍可参与研判。 ");
      completedAt = null;
      warned = true;
    }
    if (anonymousId && knowledgePoint && !pii) {
      const duplicateKey = JSON.stringify([anonymousId, knowledgePoint]);
      if (seen.has(duplicateKey)) {
        issue(row.rowNumber, "row", "DUPLICATE_RECORD", "blocking", "匿名编号与知识点重复，保留首条。 ");
        quality.duplicateRows += 1;
        blocked = true;
      } else if (!blocked) {
        seen.add(duplicateKey);
      }
    }
    if (warned) quality.warningRows += 1;
    if (blocked) quality.invalidRows += 1;
    else quality.validRows += 1;
    const record = {
      rowNumber: row.rowNumber,
      anonymousId: pii ? null : anonymousId.slice(0, 64),
      knowledgePoint: knowledgePoint.slice(0, 120),
      score: Number.isFinite(score) && scoreText ? score : null,
      completedAt,
      isValid: !blocked,
      excludedReason: blocked ? "质检阻断" : null,
    };
    records.push(record);
    if (preview.length < 20) preview.push({ ...record, anonymousId: pii ? "[已脱敏]" : record.anonymousId });
  }
  quality.validRate = Math.round((quality.validRows / quality.totalRows) * 1000) / 10;
  if (!quality.validRows) {
    throw new ImportError("IMPORT_NO_VALID_ROWS", "没有可用于研判的有效数据行。", 400, {
      quality,
      issues: [{ rowNumber: 0, field: "file", code: "IMPORT_NO_VALID_ROWS", type: "文件错误", severity: "blocking", message: "没有有效数据行。", rawValue: null }, ...issues].slice(0, 500),
      issuesTruncated: quality.blockingIssueCount + quality.warningIssueCount + 1 > 500,
    });
  }
  const batch = {
    batchId: `b_${randomUUID()}`,
    context,
    status: "validated",
    file: { name: file, format, sizeBytes: bytes, sha256: createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex") },
    quality,
    createdAt: new Date().toISOString(),
  };
  return { batch, records, issues, preview, issuesTruncated: quality.blockingIssueCount + quality.warningIssueCount > issues.length };
}

export function buildAnalysisInput(records, batch) {
  const students = new Map();
  const points = new Map();
  for (const row of records) {
    const student = students.get(row.anonymousId) || { total: 0, count: 0 };
    student.total += row.score;
    student.count += 1;
    students.set(row.anonymousId, student);
    const point = points.get(row.knowledgePoint) || { total: 0, count: 0 };
    point.total += row.score;
    point.count += 1;
    points.set(row.knowledgePoint, point);
  }
  const scores = [...students].map(([name, item]) => ({ name, score: item.total / item.count }));
  const knowledge_points = [...points].map(([name, item]) => ({ name, mastery_rate: item.total / item.count }));
  const input = {
    scores, knowledge_points, exam_name: batch.file.name,
    class_name: batch.context, full_score: 100, pass_score: 60, excellent_score: 85,
  };
  return { input, studentCount: students.size, inputDigest: createHash("sha256").update(JSON.stringify(input)).digest("hex") };
}
