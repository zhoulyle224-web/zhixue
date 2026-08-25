PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS majors (
  id INTEGER PRIMARY KEY,
  department_id INTEGER NOT NULL REFERENCES departments(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  degree_type TEXT NOT NULL DEFAULT '工学',
  duration_years INTEGER NOT NULL DEFAULT 4 CHECK (duration_years BETWEEN 2 AND 8)
);

CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY,
  teacher_no TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  department_id INTEGER NOT NULL REFERENCES departments(id),
  title TEXT NOT NULL,
  email_masked TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY,
  class_code TEXT NOT NULL UNIQUE,
  class_name TEXT NOT NULL,
  major_id INTEGER NOT NULL REFERENCES majors(id),
  entry_year INTEGER NOT NULL,
  advisor_teacher_id INTEGER REFERENCES teachers(id),
  expected_size INTEGER NOT NULL CHECK (expected_size > 0)
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  student_no TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  gender TEXT CHECK (gender IN ('男', '女', '未说明')),
  class_id INTEGER NOT NULL REFERENCES classes(id),
  admission_year INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT '在读' CHECK (status IN ('在读', '休学', '交流', '毕业')),
  profile_tags TEXT NOT NULL DEFAULT '[]',
  privacy_level INTEGER NOT NULL DEFAULT 2 CHECK (privacy_level BETWEEN 1 AND 3),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS terms (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1))
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  course_code TEXT NOT NULL UNIQUE,
  course_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('通识基础', '学科基础', '专业核心', '专业选修', '实践教学')),
  credits REAL NOT NULL CHECK (credits > 0),
  total_hours INTEGER NOT NULL CHECK (total_hours > 0),
  theory_hours INTEGER NOT NULL DEFAULT 0,
  lab_hours INTEGER NOT NULL DEFAULT 0,
  recommended_semester INTEGER CHECK (recommended_semester BETWEEN 1 AND 8),
  assessment_method TEXT NOT NULL CHECK (assessment_method IN ('考试', '考查', '项目', '混合')),
  description TEXT
);

CREATE TABLE IF NOT EXISTS course_offerings (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  term_id INTEGER NOT NULL REFERENCES terms(id),
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  section_code TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  schedule_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(term_id, section_code)
);

CREATE TABLE IF NOT EXISTS offering_classes (
  offering_id INTEGER NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  PRIMARY KEY (offering_id, class_id)
);

CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY,
  offering_id INTEGER NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  enrolled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '修读中' CHECK (status IN ('修读中', '已完成', '退选')),
  final_score REAL CHECK (final_score BETWEEN 0 AND 100),
  grade_point REAL CHECK (grade_point BETWEEN 0 AND 4.0),
  UNIQUE(offering_id, student_id)
);

CREATE TABLE IF NOT EXISTS course_chapters (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  chapter_no INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  UNIQUE(course_id, chapter_no)
);

CREATE TABLE IF NOT EXISTS knowledge_points (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  chapter_id INTEGER REFERENCES course_chapters(id) ON DELETE SET NULL,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
  importance REAL NOT NULL DEFAULT 1.0 CHECK (importance BETWEEN 0 AND 1),
  prerequisite_ids TEXT NOT NULL DEFAULT '[]',
  description TEXT
);

CREATE TABLE IF NOT EXISTS learning_resources (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  chapter_id INTEGER REFERENCES course_chapters(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('课件', '视频', '教材章节', '实验指导', '习题', '代码示例', '外部文章')),
  url_or_path TEXT,
  duration_seconds INTEGER,
  content_summary TEXT,
  content_hash BLOB,
  published_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY,
  offering_id INTEGER NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  assessment_type TEXT NOT NULL CHECK (assessment_type IN ('作业', '随堂测验', '实验', '期中考试', '期末考试', '课程项目')),
  max_score REAL NOT NULL DEFAULT 100 CHECK (max_score > 0),
  weight REAL NOT NULL CHECK (weight BETWEEN 0 AND 1),
  published_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  allow_late INTEGER NOT NULL DEFAULT 0 CHECK (allow_late IN (0, 1))
);

CREATE TABLE IF NOT EXISTS assessment_items (
  id INTEGER PRIMARY KEY,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  item_no INTEGER NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('单选', '多选', '判断', '填空', '简答', '编程', '实验报告')),
  prompt TEXT NOT NULL,
  max_score REAL NOT NULL CHECK (max_score > 0),
  difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
  answer_key TEXT,
  rubric_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(assessment_id, item_no)
);

CREATE TABLE IF NOT EXISTS item_knowledge_points (
  item_id INTEGER NOT NULL REFERENCES assessment_items(id) ON DELETE CASCADE,
  knowledge_point_id INTEGER NOT NULL REFERENCES knowledge_points(id),
  contribution REAL NOT NULL DEFAULT 1.0 CHECK (contribution > 0),
  PRIMARY KEY(item_id, knowledge_point_id)
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL DEFAULT 1,
  submitted_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('未提交', '已提交', '迟交', '已批改')),
  score REAL CHECK (score BETWEEN 0 AND 100),
  ai_score REAL CHECK (ai_score BETWEEN 0 AND 100),
  teacher_score REAL CHECK (teacher_score BETWEEN 0 AND 100),
  grading_confidence REAL CHECK (grading_confidence BETWEEN 0 AND 1),
  feedback TEXT,
  attachment_meta TEXT NOT NULL DEFAULT '{}',
  UNIQUE(assessment_id, student_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS item_scores (
  id INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES assessment_items(id) ON DELETE CASCADE,
  earned_score REAL NOT NULL CHECK (earned_score >= 0),
  is_correct INTEGER CHECK (is_correct IN (0, 1)),
  answer_text TEXT,
  error_type TEXT,
  grading_details TEXT NOT NULL DEFAULT '{}',
  UNIQUE(submission_id, item_id)
);

CREATE TABLE IF NOT EXISTS attendance_records (
  id INTEGER PRIMARY KEY,
  offering_id INTEGER NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  lesson_date TEXT NOT NULL,
  lesson_no INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('出勤', '迟到', '请假', '缺勤')),
  checkin_at TEXT,
  source TEXT NOT NULL CHECK (source IN ('扫码', '教师录入', '系统同步')),
  UNIQUE(offering_id, student_id, lesson_date, lesson_no)
);

CREATE TABLE IF NOT EXISTS classroom_interactions (
  id INTEGER PRIMARY KEY,
  offering_id INTEGER NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
  occurred_at TEXT NOT NULL,
  interaction_type TEXT NOT NULL CHECK (interaction_type IN ('提问', '回答', '投票', '讨论', '抢答', '随堂练习')),
  content TEXT,
  response_value TEXT,
  is_correct INTEGER CHECK (is_correct IN (0, 1)),
  participation_score REAL NOT NULL DEFAULT 0 CHECK (participation_score >= 0),
  sentiment TEXT CHECK (sentiment IN ('积极', '中性', '困惑'))
);

CREATE TABLE IF NOT EXISTS learning_events (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  resource_id INTEGER NOT NULL REFERENCES learning_resources(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('打开', '学习', '暂停', '完成', '下载', '收藏')),
  occurred_at TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  progress REAL NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
  device_type TEXT NOT NULL CHECK (device_type IN ('网页端', '移动端', '平板')),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS qa_sessions (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('文字', '图片', '语音')),
  satisfaction INTEGER CHECK (satisfaction BETWEEN 1 AND 5),
  resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1))
);

CREATE TABLE IF NOT EXISTS qa_messages (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES qa_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('student', 'assistant', 'teacher')),
  content TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  latency_ms INTEGER,
  safety_flag TEXT
);

CREATE TABLE IF NOT EXISTS qa_knowledge_points (
  session_id INTEGER NOT NULL REFERENCES qa_sessions(id) ON DELETE CASCADE,
  knowledge_point_id INTEGER NOT NULL REFERENCES knowledge_points(id),
  relevance REAL NOT NULL CHECK (relevance BETWEEN 0 AND 1),
  PRIMARY KEY(session_id, knowledge_point_id)
);

CREATE TABLE IF NOT EXISTS wrong_book_entries (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  item_score_id INTEGER REFERENCES item_scores(id) ON DELETE SET NULL,
  knowledge_point_id INTEGER NOT NULL REFERENCES knowledge_points(id),
  added_at TEXT NOT NULL,
  error_reason TEXT NOT NULL,
  mastery_before REAL NOT NULL CHECK (mastery_before BETWEEN 0 AND 1),
  mastery_after REAL CHECK (mastery_after BETWEEN 0 AND 1),
  review_status TEXT NOT NULL CHECK (review_status IN ('待复习', '复习中', '已掌握')),
  next_review_at TEXT
);

CREATE TABLE IF NOT EXISTS mastery_snapshots (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  knowledge_point_id INTEGER NOT NULL REFERENCES knowledge_points(id),
  measured_at TEXT NOT NULL,
  mastery REAL NOT NULL CHECK (mastery BETWEEN 0 AND 1),
  evidence_count INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  trend TEXT NOT NULL CHECK (trend IN ('上升', '稳定', '下降')),
  UNIQUE(student_id, knowledge_point_id, measured_at)
);

CREATE TABLE IF NOT EXISTS risk_alerts (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  offering_id INTEGER REFERENCES course_offerings(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  risk_type TEXT NOT NULL CHECK (risk_type IN ('成绩下滑', '缺勤风险', '作业拖延', '知识点薄弱', '学习活跃度低')),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('低', '中', '高')),
  risk_score REAL NOT NULL CHECK (risk_score BETWEEN 0 AND 1),
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('待处理', '跟进中', '已关闭')),
  handled_by INTEGER REFERENCES teachers(id),
  handled_at TEXT
);

CREATE TABLE IF NOT EXISTS learning_tasks (
  id INTEGER PRIMARY KEY,
  offering_id INTEGER NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES teachers(id),
  title TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK (task_type IN ('分层练习', '复习任务', '补充讲义', '拓展项目')),
  target_level TEXT NOT NULL CHECK (target_level IN ('基础巩固', '标准提升', '拔高挑战')),
  content_json TEXT NOT NULL,
  published_at TEXT NOT NULL,
  due_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_assignments (
  task_id INTEGER NOT NULL REFERENCES learning_tasks(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  assigned_reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('待开始', '进行中', '已完成', '已逾期')),
  progress REAL NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
  completed_at TEXT,
  PRIMARY KEY(task_id, student_id)
);

CREATE TABLE IF NOT EXISTS teaching_reports (
  id INTEGER PRIMARY KEY,
  offering_id INTEGER NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  generated_at TEXT NOT NULL,
  report_period_start TEXT NOT NULL,
  report_period_end TEXT NOT NULL,
  class_average REAL,
  pass_rate REAL CHECK (pass_rate BETWEEN 0 AND 1),
  weak_points_json TEXT NOT NULL,
  hot_questions_json TEXT NOT NULL,
  student_layers_json TEXT NOT NULL,
  recommendations_json TEXT NOT NULL,
  confirmed_by INTEGER REFERENCES teachers(id),
  confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY,
  student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  offering_id INTEGER NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  knowledge_point_id INTEGER REFERENCES knowledge_points(id),
  created_at TEXT NOT NULL,
  recommendation_type TEXT NOT NULL CHECK (recommendation_type IN ('课程资源', '练习题', '复习计划', '教师干预')),
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 5),
  payload_json TEXT NOT NULL,
  accepted INTEGER CHECK (accepted IN (0, 1))
);

CREATE TABLE IF NOT EXISTS data_import_batches (
  id INTEGER PRIMARY KEY,
  file_name TEXT NOT NULL,
  data_type TEXT NOT NULL CHECK (data_type IN ('学生名册', '成绩', '作业', '课堂互动', '学习行为', '课程资源')),
  imported_by INTEGER NOT NULL REFERENCES teachers(id),
  imported_at TEXT NOT NULL,
  total_rows INTEGER NOT NULL,
  valid_rows INTEGER NOT NULL,
  invalid_rows INTEGER NOT NULL,
  duplicate_rows INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('待校验', '部分成功', '成功', '失败')),
  source_digest BLOB,
  mapping_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS data_quality_issues (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES data_import_batches(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  field_name TEXT,
  issue_type TEXT NOT NULL CHECK (issue_type IN ('空值', '重复', '格式错误', '范围异常', '外键缺失')),
  raw_value TEXT,
  suggested_value TEXT,
  resolution TEXT NOT NULL CHECK (resolution IN ('待处理', '自动修复', '人工确认', '忽略'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('student', 'teacher', 'system')),
  actor_ref INTEGER,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_ref INTEGER,
  occurred_at TEXT NOT NULL,
  ip_masked TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_offering ON enrollments(offering_id);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id);
CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance_records(student_id, lesson_date);
CREATE INDEX IF NOT EXISTS idx_learning_events_student_time ON learning_events(student_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_qa_sessions_course_time ON qa_sessions(course_id, started_at);
CREATE INDEX IF NOT EXISTS idx_mastery_student_point ON mastery_snapshots(student_id, knowledge_point_id);
CREATE INDEX IF NOT EXISTS idx_risk_status_level ON risk_alerts(status, risk_level);

CREATE VIEW IF NOT EXISTS v_student_course_profile AS
SELECT
  e.student_id,
  e.offering_id,
  c.course_name,
  ROUND(AVG(s.score), 2) AS average_score,
  ROUND(AVG(CASE WHEN a.status = '出勤' THEN 1.0 ELSE 0.0 END), 3) AS attendance_rate,
  COUNT(DISTINCT q.id) AS qa_count,
  COUNT(DISTINCT r.id) AS active_risk_count
FROM enrollments e
JOIN course_offerings o ON o.id = e.offering_id
JOIN courses c ON c.id = o.course_id
LEFT JOIN assessments ass ON ass.offering_id = e.offering_id
LEFT JOIN submissions s ON s.assessment_id = ass.id AND s.student_id = e.student_id
LEFT JOIN attendance_records a ON a.offering_id = e.offering_id AND a.student_id = e.student_id
LEFT JOIN qa_sessions q ON q.course_id = o.course_id AND q.student_id = e.student_id
LEFT JOIN risk_alerts r ON r.offering_id = e.offering_id AND r.student_id = e.student_id AND r.status <> '已关闭'
GROUP BY e.student_id, e.offering_id, c.course_name;

CREATE VIEW IF NOT EXISTS v_class_course_dashboard AS
SELECT
  cl.id AS class_id,
  cl.class_name,
  o.id AS offering_id,
  c.course_name,
  COUNT(DISTINCT e.student_id) AS student_count,
  ROUND(AVG(s.score), 2) AS average_score,
  ROUND(AVG(CASE WHEN s.score >= 60 THEN 1.0 ELSE 0.0 END), 3) AS pass_rate,
  ROUND(AVG(CASE WHEN ar.status = '出勤' THEN 1.0 ELSE 0.0 END), 3) AS attendance_rate
FROM offering_classes oc
JOIN classes cl ON cl.id = oc.class_id
JOIN course_offerings o ON o.id = oc.offering_id
JOIN courses c ON c.id = o.course_id
JOIN enrollments e ON e.offering_id = o.id
JOIN students st ON st.id = e.student_id AND st.class_id = cl.id
LEFT JOIN assessments ass ON ass.offering_id = o.id
LEFT JOIN submissions s ON s.assessment_id = ass.id AND s.student_id = st.id
LEFT JOIN attendance_records ar ON ar.offering_id = o.id AND ar.student_id = st.id
GROUP BY cl.id, cl.class_name, o.id, c.course_name;

CREATE VIEW IF NOT EXISTS v_hot_qa_topics AS
SELECT
  q.course_id,
  c.course_name,
  kp.id AS knowledge_point_id,
  kp.name AS knowledge_point,
  COUNT(*) AS question_count,
  ROUND(AVG(q.satisfaction), 2) AS average_satisfaction
FROM qa_sessions q
JOIN courses c ON c.id = q.course_id
JOIN qa_knowledge_points qk ON qk.session_id = q.id
JOIN knowledge_points kp ON kp.id = qk.knowledge_point_id
GROUP BY q.course_id, c.course_name, kp.id, kp.name;

CREATE VIEW IF NOT EXISTS v_latest_mastery AS
SELECT ms.*
FROM mastery_snapshots ms
JOIN (
  SELECT student_id, knowledge_point_id, MAX(measured_at) AS latest_at
  FROM mastery_snapshots
  GROUP BY student_id, knowledge_point_id
) latest
ON latest.student_id = ms.student_id
AND latest.knowledge_point_id = ms.knowledge_point_id
AND latest.latest_at = ms.measured_at;
