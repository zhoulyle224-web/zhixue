PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runtime_schema_meta (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

INSERT OR IGNORE INTO runtime_schema_meta(version, applied_at)
VALUES (4, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO runtime_schema_meta(version, applied_at)
VALUES (5, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO runtime_schema_meta(version, applied_at)
VALUES (6, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO runtime_schema_meta(version, applied_at)
VALUES (7, CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS runtime_auth_accounts (
  id TEXT PRIMARY KEY,
  account_name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('teacher','student')),
  actor_ref_id INTEGER NOT NULL,
  actor_ref_code TEXT NOT NULL,
  password_algo TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
  can_manage_ai INTEGER NOT NULL DEFAULT 0 CHECK (can_manage_ai IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_auth_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES runtime_auth_accounts(id),
  session_token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  remember_login INTEGER NOT NULL DEFAULT 0 CHECK (remember_login IN (0,1)),
  user_agent_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_runtime_auth_sessions_account
  ON runtime_auth_sessions(account_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_auth_sessions_active
  ON runtime_auth_sessions(session_token_hash, revoked_at, expires_at);

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

-- Third-round data governance zones. Raw keeps only immutable source metadata and
-- a digest; parsed content is redacted before it enters staging/quarantine.
CREATE TABLE IF NOT EXISTS runtime_raw_batches (
  batch_id TEXT PRIMARY KEY REFERENCES runtime_import_batches(id),
  environment TEXT NOT NULL CHECK (environment IN ('demo','test','production')),
  namespace TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0,1)),
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_staging_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES runtime_import_batches(id),
  row_number INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  record_fingerprint TEXT NOT NULL,
  quality_status TEXT NOT NULL CHECK (quality_status IN ('valid','warning','invalid')),
  UNIQUE(batch_id, row_number)
);

CREATE TABLE IF NOT EXISTS runtime_quarantine_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES runtime_import_batches(id),
  row_number INTEGER NOT NULL,
  reason_codes_json TEXT NOT NULL,
  record_json TEXT NOT NULL,
  quarantined_at TEXT NOT NULL,
  UNIQUE(batch_id, row_number)
);

CREATE TABLE IF NOT EXISTS runtime_data_versions (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('demo','test','production')),
  namespace TEXT NOT NULL,
  context_key TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES runtime_import_batches(id),
  status TEXT NOT NULL CHECK (status IN ('building','active','inactive','failed')),
  rule_version TEXT NOT NULL,
  parent_version_id TEXT,
  activated_at TEXT,
  activated_by_context TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_one_active_data_version
  ON runtime_data_versions(environment, namespace, context_key) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS runtime_curated_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_version_id TEXT NOT NULL REFERENCES runtime_data_versions(id),
  environment TEXT NOT NULL CHECK (environment IN ('demo','test','production')),
  namespace TEXT NOT NULL,
  context_key TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(data_version_id, source_event_id)
);

CREATE TABLE IF NOT EXISTS runtime_serving_snapshots (
  id TEXT PRIMARY KEY,
  data_version_id TEXT NOT NULL REFERENCES runtime_data_versions(id),
  environment TEXT NOT NULL CHECK (environment IN ('demo','test','production')),
  namespace TEXT NOT NULL,
  context_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','stale','failed')),
  payload_json TEXT NOT NULL,
  generated_at TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS runtime_qa_records (
  id TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL,
  student_context TEXT NOT NULL,
  student_no TEXT NOT NULL,
  class_id INTEGER NOT NULL,
  offering_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  course_code TEXT NOT NULL,
  course_name TEXT NOT NULL,
  question_text_redacted TEXT NOT NULL,
  answer_status TEXT NOT NULL CHECK (answer_status IN ('answered','pending_teacher','teacher_replied')),
  assistant_answer TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  related_knowledge_json TEXT NOT NULL DEFAULT '[]',
  guide_questions_json TEXT NOT NULL DEFAULT '[]',
  knowledge_version TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  handoff_status TEXT NOT NULL CHECK (handoff_status IN ('not_required','pending','replied','failed')),
  teacher_context TEXT NOT NULL,
  teacher_reply TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  replied_at TEXT,
  updated_at TEXT NOT NULL,
  ai_run_id TEXT,
  generation_status TEXT NOT NULL DEFAULT 'degraded_offline',
  ai_generated INTEGER NOT NULL DEFAULT 0 CHECK (ai_generated IN (0,1)),
  UNIQUE (student_context, client_request_id)
);

CREATE TABLE IF NOT EXISTS runtime_ai_config (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  secret_ref TEXT NOT NULL,
  key_last_four TEXT NOT NULL,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('verified','failed','unconfigured')),
  verified_at TEXT,
  updated_by_account_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_ai_provider_configs (
  provider_id TEXT PRIMARY KEY,
  secret_ref TEXT NOT NULL,
  key_last_four TEXT NOT NULL,
  model TEXT NOT NULL,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('verified','failed','unconfigured')),
  verified_at TEXT,
  updated_by_account_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_ai_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  active_provider_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_ai_runs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  course_id INTEGER,
  session_id TEXT,
  provider_id TEXT,
  model TEXT,
  model_revision TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'received','redacted','retrieving','generating','validating',
    'completed_persisted','degraded_offline','failed_retryable','failed_terminal'
  )),
  input_digest TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  token_usage_json TEXT NOT NULL DEFAULT '{}',
  safety_flags_json TEXT NOT NULL DEFAULT '[]',
  provider_request_id TEXT,
  error_code TEXT,
  latency_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  persisted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runtime_ai_runs_actor
  ON runtime_ai_runs(actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_qa_student
  ON runtime_qa_records(student_context, offering_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_qa_inbox
  ON runtime_qa_records(offering_id, class_id, answer_status, created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_task_plans (
  id TEXT PRIMARY KEY,
  context_key TEXT NOT NULL,
  offering_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  created_by_context TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_task_plans_context
  ON runtime_task_plans(context_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS runtime_task_versions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES runtime_task_plans(id),
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published','superseded','revoked')),
  source_analysis_run_id TEXT NOT NULL REFERENCES runtime_analysis_runs(id),
  source_batch_id TEXT NOT NULL REFERENCES runtime_import_batches(id),
  source_evidence_json TEXT NOT NULL,
  stratification_snapshot_json TEXT NOT NULL,
  task_content_json TEXT NOT NULL,
  weakest_knowledge_point TEXT NOT NULL,
  due_at TEXT,
  content_digest TEXT,
  draft_source TEXT NOT NULL DEFAULT 'analysis_template',
  created_by_context TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  published_by_context TEXT,
  publish_client_request_id TEXT,
  revoked_at TEXT,
  revoked_by_context TEXT,
  revoke_reason TEXT,
  superseded_at TEXT,
  UNIQUE(plan_id, version_no),
  UNIQUE(publish_client_request_id)
);

CREATE INDEX IF NOT EXISTS idx_runtime_task_versions_plan_status
  ON runtime_task_versions(plan_id, status);

CREATE INDEX IF NOT EXISTS idx_runtime_task_versions_analysis
  ON runtime_task_versions(source_analysis_run_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_task_one_published
  ON runtime_task_versions(plan_id) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS runtime_task_assignments (
  id TEXT PRIMARY KEY,
  task_version_id TEXT NOT NULL REFERENCES runtime_task_versions(id),
  student_id INTEGER NOT NULL,
  student_no TEXT NOT NULL,
  tier_code TEXT NOT NULL CHECK (tier_code IN ('extension','improvement','consolidation')),
  assigned_reason TEXT NOT NULL,
  completion_status TEXT NOT NULL DEFAULT 'pending' CHECK (completion_status IN ('pending','completed')),
  completed_at TEXT,
  feedback_text TEXT,
  feedback_redacted INTEGER NOT NULL DEFAULT 0 CHECK (feedback_redacted IN (0,1)),
  completion_client_request_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_version_id, student_id),
  UNIQUE(completion_client_request_id)
);

CREATE INDEX IF NOT EXISTS idx_runtime_task_assignments_student
  ON runtime_task_assignments(student_id, task_version_id);

CREATE INDEX IF NOT EXISTS idx_runtime_task_assignments_status
  ON runtime_task_assignments(completion_status);

CREATE TABLE IF NOT EXISTS runtime_task_events (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES runtime_task_plans(id),
  task_version_id TEXT REFERENCES runtime_task_versions(id),
  assignment_id TEXT REFERENCES runtime_task_assignments(id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'draft_created','draft_updated','published','superseded',
    'assignment_completed','revoked'
  )),
  actor_context TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_task_events_version
  ON runtime_task_events(task_version_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_export_audits (
  id TEXT PRIMARY KEY,
  export_id TEXT UNIQUE,
  account_id TEXT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('teacher','student','unknown')),
  actor_ref_code TEXT,
  scope_type TEXT NOT NULL,
  scope_ref TEXT NOT NULL,
  export_kind TEXT NOT NULL,
  export_format TEXT NOT NULL,
  watermark_id TEXT UNIQUE,
  policy_version TEXT NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '{}',
  record_count INTEGER NOT NULL DEFAULT 0,
  content_size_bytes INTEGER,
  content_digest TEXT,
  result TEXT NOT NULL CHECK (result IN ('generated','denied','failed')),
  failure_code TEXT,
  generated_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_export_audits_account
  ON runtime_export_audits(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_export_audits_scope
  ON runtime_export_audits(scope_ref, created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_qa_sessions_v2 (
  id TEXT PRIMARY KEY,
  student_context TEXT NOT NULL,
  offering_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_qa_sessions_v2_student
  ON runtime_qa_sessions_v2(student_context, offering_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS runtime_student_sharing_preferences (
  student_id INTEGER NOT NULL,
  offering_id INTEGER NOT NULL,
  behavior_details INTEGER NOT NULL DEFAULT 0 CHECK (behavior_details IN (0,1)),
  answer_text INTEGER NOT NULL DEFAULT 0 CHECK (answer_text IN (0,1)),
  qa_content INTEGER NOT NULL DEFAULT 0 CHECK (qa_content IN (0,1)),
  goals_preferences INTEGER NOT NULL DEFAULT 0 CHECK (goals_preferences IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(student_id, offering_id)
);

CREATE TABLE IF NOT EXISTS runtime_personal_plans (
  id TEXT PRIMARY KEY,
  student_id INTEGER NOT NULL,
  student_no TEXT NOT NULL,
  offering_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  teacher_context TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published','superseded','revoked')),
  goal TEXT NOT NULL,
  route TEXT NOT NULL,
  due_at TEXT NOT NULL,
  tasks_json TEXT NOT NULL,
  basis_json TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE(student_id, offering_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_runtime_personal_plans_scope
  ON runtime_personal_plans(student_id, offering_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS runtime_observation_audits (
  id TEXT PRIMARY KEY,
  teacher_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  offering_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  fields_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
