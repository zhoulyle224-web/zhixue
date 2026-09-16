PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runtime_import_batches (
  id TEXT PRIMARY KEY,
  context_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_format TEXT NOT NULL CHECK (file_format IN ('csv', 'json')),
  file_size_bytes INTEGER NOT NULL,
  file_sha256 TEXT NOT NULL,
  total_rows INTEGER NOT NULL,
  valid_rows INTEGER NOT NULL,
  invalid_rows INTEGER NOT NULL,
  duplicate_rows INTEGER NOT NULL,
  warning_rows INTEGER NOT NULL,
  blocking_issue_count INTEGER NOT NULL,
  warning_issue_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('validated', 'confirmed', 'analyzed', 'failed')),
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  confirmed_by_context TEXT
);

CREATE TABLE IF NOT EXISTS runtime_import_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES runtime_import_batches(id),
  row_number INTEGER NOT NULL,
  anonymous_id TEXT,
  knowledge_point TEXT,
  score REAL,
  completed_at TEXT,
  is_valid INTEGER NOT NULL CHECK (is_valid IN (0, 1)),
  excluded_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_runtime_records_batch_valid
  ON runtime_import_records(batch_id, is_valid);

CREATE TABLE IF NOT EXISTS runtime_quality_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES runtime_import_batches(id),
  row_number INTEGER NOT NULL,
  field_name TEXT NOT NULL,
  issue_code TEXT NOT NULL,
  issue_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('blocking', 'warning')),
  message TEXT NOT NULL,
  raw_value_redacted TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_issues_batch
  ON runtime_quality_issues(batch_id);

CREATE TABLE IF NOT EXISTS runtime_analysis_runs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES runtime_import_batches(id),
  context_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('running', 'completed', 'failed')),
  skill_id TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  result_json TEXT NOT NULL,
  generated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_analysis_batch
  ON runtime_analysis_runs(batch_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_analysis_context
  ON runtime_analysis_runs(context_key, generated_at DESC);
