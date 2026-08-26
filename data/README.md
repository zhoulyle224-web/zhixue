# 智学双擎校园学情数据库

## 1. 文件说明

- `zhixue_demo.sqlite`：可直接使用的 SQLite 数据库。
- `zhixue_demo.summary.json`：每张表的记录数量。
- `../db/schema.sql`：完整建表、索引和统计视图定义，兼容 SQLite / Cloudflare D1 的常用语法。
- `../scripts/build_demo_database.py`：确定性数据生成器，使用固定随机种子，每次可重建同一套数据。
- `../scripts/check_demo_database.py`：完整性、外键、分数范围和业务闭环检查。

全部学生、教师、班级和行为记录均为匿名合成数据，不对应任何真实个人或院校。

## 2. 数据依据

课程专业范围参考教育部《普通高等学校本科专业目录》中的 0809 计算机类；课程结构参考高校公开的计算机科学与技术培养方案，选取数据结构、计算机组成原理、数据库、操作系统、计算机网络、软件工程、人工智能、机器学习、网络安全、大数据、算法和 Web 开发等常见课程。

参考链接：

- 教育部专业目录：https://www.moe.gov.cn/srcsite/A08/moe_1034/s3882/202604/W020260427440749576927.pdf
- 贵州大学计算机科学与技术培养方案：https://cs.gzu.edu.cn/2025/1002/c16263a258913/page.htm
- 海南大学计算机科学与技术培养方案：https://cs.hainanu.edu.cn/info/1066/12900.htm

这些公开资料只用于确定专业与课程结构。成绩、学习行为、提问、预警等数值是按可解释的统计规则生成的，不是抓取的真实学生记录。

## 3. 已覆盖的业务数据

| 数据域 | 主要表 | 可支持的功能 |
|---|---|---|
| 组织与身份 | `departments`、`majors`、`classes`、`teachers`、`students` | 学院、专业、班级和角色筛选 |
| 教学安排 | `terms`、`courses`、`course_offerings`、`offering_classes`、`enrollments` | 学期、课程、教学班和选课 |
| 课程知识图谱 | `course_chapters`、`knowledge_points`、`item_knowledge_points` | 章节、知识点、先修关系、题目映射 |
| 课程资源 | `learning_resources` | 课件、视频、教材、实验、习题、代码和文章 |
| 考核成绩 | `assessments`、`assessment_items`、`submissions`、`item_scores` | 作业、测验、实验、考试、项目和题目级得分 |
| 课堂过程 | `attendance_records`、`classroom_interactions` | 出勤、迟到、提问、回答、投票和随堂练习 |
| 在线学习 | `learning_events` | 学习时长、资源进度、终端类型和学习事件 |
| 智能答疑 | `qa_sessions`、`qa_messages`、`qa_knowledge_points` | 多轮问答、资料依据、满意度和热问知识点 |
| 个体学习画像 | `wrong_book_entries`、`mastery_snapshots` | 错题本、掌握度、趋势和证据数 |
| 学情干预 | `risk_alerts`、`learning_tasks`、`task_assignments`、`recommendations` | 风险预警、分层任务、资源和练习推荐 |
| 教师研判 | `teaching_reports` | 均分、及格率、薄弱点、热问榜、分层与教学建议 |
| 数据治理 | `data_import_batches`、`data_quality_issues`、`audit_logs` | 导入、空值、重复、格式、异常、外键检查与审计 |

## 4. SQL 数据类型覆盖

SQLite 的五种存储类型均有体现：

- `INTEGER`：主键、人数、时长、布尔状态和等级。
- `REAL`：成绩、学分、掌握度、置信度、权重和进度。
- `TEXT`：名称、枚举、日期时间、说明和答案文本。
- `BLOB`：资源内容哈希与导入文件摘要。
- `NULL`：未提交时间、未评分成绩、未处理人员等合理缺失值。

JSON 数组或对象采用 `TEXT` 保存，例如课程表、画像标签、评分细则、证据、分层和推荐载荷；日期、日期时间采用 ISO 8601 文本，便于 SQLite、Python、JavaScript 和 D1 共同读取。

## 5. 规模与特征

- 6 个计算机类专业、6 个班级、180 名学生、10 名教师。
- 12 门课程、60 个知识点、36 份课程资源。
- 1,140 条选课、5,700 份提交、21,600 条题目级得分。
- 13,680 条考勤、约 7,900 条课堂互动、6,840 条在线学习事件。
- 440 次答疑、错题本、三阶段掌握度快照、风险预警和 1,000 余份个性化任务。
- 刻意包含空值、重复、中文成绩、超范围成绩、日期格式错误和外键缺失等导入异常样本，供“数据清洗”流程演示。

数据生成时为每名学生设定匿名的能力、参与度和稳定性参数，使成绩、出勤、学习时长、答疑、错题、风险和任务分层之间具有相关性，而不是完全随机的无意义数字。

## 6. 常用查询

班级课程看板：

```sql
SELECT *
FROM v_class_course_dashboard
ORDER BY class_id, offering_id;
```

答疑热问榜：

```sql
SELECT course_name, knowledge_point, question_count
FROM v_hot_qa_topics
ORDER BY question_count DESC
LIMIT 10;
```

学生最新知识点掌握度：

```sql
SELECT s.display_name, c.course_name, kp.name, m.mastery, m.trend
FROM v_latest_mastery m
JOIN students s ON s.id = m.student_id
JOIN knowledge_points kp ON kp.id = m.knowledge_point_id
JOIN courses c ON c.id = kp.course_id
WHERE s.student_no = 'S240101'
ORDER BY c.course_name, m.mastery;
```

教师端待处理高风险学生：

```sql
SELECT s.student_no, s.display_name, c.course_name,
       r.risk_type, r.risk_level, r.risk_score
FROM risk_alerts r
JOIN students s ON s.id = r.student_id
LEFT JOIN course_offerings o ON o.id = r.offering_id
LEFT JOIN courses c ON c.id = o.course_id
WHERE r.status <> '已关闭'
ORDER BY CASE r.risk_level WHEN '高' THEN 1 WHEN '中' THEN 2 ELSE 3 END,
         r.risk_score DESC;
```

## 7. 重建与检查

在项目目录执行：

```powershell
python scripts\build_demo_database.py
python scripts\check_demo_database.py
```

生成器只覆盖 `data/zhixue_demo.sqlite` 和对应汇总文件，不会修改前端页面。

## 8. 前端与线上数据库

公开网站采用两层数据结构：

1. `zhixue_demo.sqlite` 保存完整的匿名教学明细，是离线分析和 Skill 调用的数据源。
2. `web_snapshots.json` 是从完整库生成的脱敏前端读模型；部署时写入 Cloudflare D1，由 `/api/catalog`、`/api/dashboard` 和 `/api/health` 提供只读查询。

公开端不发布题目答案、原始作答正文和内部文件内容。若在 GitHub Pages 等不支持 D1 的纯静态环境打开，页面会自动读取 `assets/demo-data.json`，保证数据展示与 D1 版本一致。

数据库内容发生变化时，依次运行：

```powershell
python scripts\export_frontend_snapshots.py
python scripts\build_d1_migration.py
npm run build:demo
```
