"""Build the anonymized Zhixue Dual Engine demo database.

The generated records are synthetic. They are shaped to look like plausible
computer-major learning data, but they never represent real people.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import sqlite3
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path


SEED = 20260825
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "data" / "zhixue_demo.sqlite"
SCHEMA_PATH = ROOT / "db" / "schema.sql"


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def iso(day: date, hour: int = 9, minute: int = 0) -> str:
    return datetime(day.year, day.month, day.day, hour, minute).isoformat(timespec="seconds")


def score_to_gpa(score: float) -> float:
    if score < 60:
        return 0.0
    return round(min(4.0, (score - 50) / 10), 1)


def choose_weighted(rng: random.Random, values: list[tuple[object, float]]):
    total = sum(weight for _, weight in values)
    point = rng.random() * total
    for value, weight in values:
        point -= weight
        if point <= 0:
            return value
    return values[-1][0]


def build_database(output_path: Path) -> dict[str, int]:
    rng = random.Random(SEED)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists():
        output_path.unlink()

    db = sqlite3.connect(output_path)
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))

    # Organization and curriculum metadata.
    db.execute("INSERT INTO departments(id, code, name) VALUES(1, 'D-COMP', '信息工程学院')")
    majors = [
        (1, 1, "080901", "计算机科学与技术", "工学", 4),
        (2, 1, "080902", "软件工程", "工学", 4),
        (3, 1, "080903", "网络工程", "工学", 4),
        (4, 1, "080904K", "信息安全", "工学", 4),
        (5, 1, "080907T", "智能科学与技术", "工学", 4),
        (6, 1, "080910T", "数据科学与大数据技术", "工学", 4),
    ]
    db.executemany("INSERT INTO majors VALUES(?, ?, ?, ?, ?, ?)", majors)

    teacher_titles = ["教授", "副教授", "讲师", "副教授", "讲师", "教授", "讲师", "副教授", "讲师", "实验师"]
    teacher_names = ["教师甲", "教师乙", "教师丙", "教师丁", "教师戊", "教师己", "教师庚", "教师辛", "教师壬", "教师癸"]
    teachers = []
    for idx, (name, title) in enumerate(zip(teacher_names, teacher_titles), 1):
        teachers.append((idx, f"T{idx:04d}", name, 1, title, f"t{idx:04d}@***.edu.cn", 1))
    db.executemany(
        "INSERT INTO teachers(id, teacher_no, display_name, department_id, title, email_masked, active) VALUES(?, ?, ?, ?, ?, ?, ?)",
        teachers,
    )

    class_rows = []
    major_short = ["计科", "软工", "网工", "信安", "智能", "数科"]
    for idx, short in enumerate(major_short, 1):
        class_rows.append((idx, f"C2024{idx:02d}", f"2024级{short}1班", idx, 2024, ((idx - 1) % 10) + 1, 30))
    db.executemany("INSERT INTO classes VALUES(?, ?, ?, ?, ?, ?, ?)", class_rows)

    latent: dict[int, dict[str, float]] = {}
    student_rows = []
    sid = 1
    for class_id in range(1, 7):
        for seq in range(1, 31):
            ability = clamp(rng.gauss(0.68, 0.15), 0.25, 0.96)
            engagement = clamp(0.55 * ability + 0.45 * rng.random(), 0.18, 0.98)
            consistency = clamp(rng.gauss(0.72, 0.16), 0.25, 0.98)
            tags = []
            if ability >= 0.82:
                tags.append("高潜力")
            if engagement >= 0.8:
                tags.append("高参与")
            if consistency < 0.48:
                tags.append("波动关注")
            if not tags:
                tags.append("稳定学习")
            gender = "男" if rng.random() < 0.67 else "女"
            student_rows.append(
                (sid, f"S24{class_id:02d}{seq:02d}", f"学生{sid:03d}", gender, class_id, 2024, "在读", json.dumps(tags, ensure_ascii=False), 2)
            )
            latent[sid] = {"ability": ability, "engagement": engagement, "consistency": consistency}
            sid += 1
    db.executemany(
        "INSERT INTO students(id, student_no, display_name, gender, class_id, admission_year, status, profile_tags, privacy_level) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
        student_rows,
    )

    terms = [
        (1, "2024-2025-2", "2024—2025学年第二学期", "2025-02-17", "2025-07-06", 0),
        (2, "2025-2026-1", "2025—2026学年第一学期", "2025-09-01", "2026-01-18", 0),
        (3, "2025-2026-2", "2025—2026学年第二学期", "2026-02-23", "2026-07-12", 1),
    ]
    db.executemany("INSERT INTO terms VALUES(?, ?, ?, ?, ?, ?)", terms)

    courses = [
        (1, "CS201", "数据结构", "专业核心", 4.0, 64, 48, 16, 3, "考试", "线性表、树、图、查找与排序"),
        (2, "CS202", "计算机组成原理", "专业核心", 3.5, 56, 44, 12, 3, "考试", "数据表示、CPU、存储与输入输出系统"),
        (3, "CS203", "数据库系统", "专业核心", 4.0, 64, 48, 16, 4, "混合", "关系模型、SQL、规范化、事务与数据库设计"),
        (4, "CS204", "操作系统", "专业核心", 4.0, 64, 48, 16, 4, "考试", "进程、内存、文件与并发控制"),
        (5, "CS205", "计算机网络", "专业核心", 4.0, 64, 48, 16, 4, "考试", "协议分层、路由、传输与应用层协议"),
        (6, "SE201", "软件工程", "专业核心", 3.0, 48, 32, 16, 4, "项目", "需求、设计、测试与项目管理"),
        (7, "AI201", "人工智能导论", "专业选修", 3.0, 48, 32, 16, 4, "混合", "搜索、知识表示、机器学习与智能体"),
        (8, "AI202", "机器学习基础", "专业选修", 3.0, 48, 32, 16, 5, "项目", "监督学习、模型评估与特征工程"),
        (9, "IS201", "网络空间安全基础", "专业核心", 3.0, 48, 36, 12, 4, "混合", "密码学、身份认证、系统与网络安全"),
        (10, "DS201", "大数据技术基础", "专业核心", 3.0, 48, 28, 20, 4, "项目", "分布式存储、批处理与流处理"),
        (11, "CS206", "算法设计与分析", "专业核心", 3.0, 48, 40, 8, 4, "考试", "分治、动态规划、贪心与复杂度"),
        (12, "SE202", "Web应用开发", "实践教学", 2.5, 48, 20, 28, 4, "项目", "前后端、接口、数据库与部署"),
    ]
    db.executemany("INSERT INTO courses VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", courses)

    offering_class_map = {
        1: [1, 2, 3, 4, 5, 6],
        2: [1, 3, 4],
        3: [1, 2, 3, 4, 5, 6],
        4: [1, 2, 4],
        5: [1, 3, 4],
        6: [1, 2],
        7: [1, 5, 6],
        8: [5, 6],
        9: [3, 4],
        10: [6],
        11: [1, 2, 5, 6],
        12: [1, 2, 3],
    }
    offerings = []
    for course_id in range(1, 13):
        schedule = {"weekday": (course_id % 5) + 1, "period": [3, 4] if course_id % 2 else [5, 6], "weeks": "1-16"}
        offerings.append((course_id, course_id, 3, ((course_id - 1) % 10) + 1, f"SEC-{course_id:02d}", 180, json.dumps(schedule, ensure_ascii=False)))
    db.executemany(
        "INSERT INTO course_offerings(id, course_id, term_id, teacher_id, section_code, capacity, schedule_json) VALUES(?, ?, ?, ?, ?, ?, ?)",
        offerings,
    )
    for offering_id, class_ids in offering_class_map.items():
        db.executemany("INSERT INTO offering_classes VALUES(?, ?)", [(offering_id, cid) for cid in class_ids])

    enrollment_ids_by_offering: dict[int, list[tuple[int, int]]] = defaultdict(list)
    enrollment_id = 1
    for offering_id, class_ids in offering_class_map.items():
        for student_id, row in enumerate(student_rows, 1):
            class_id = row[4]
            if class_id in class_ids:
                db.execute(
                    "INSERT INTO enrollments(id, offering_id, student_id, enrolled_at, status) VALUES(?, ?, ?, ?, '修读中')",
                    (enrollment_id, offering_id, student_id, "2026-02-20T10:00:00"),
                )
                enrollment_ids_by_offering[offering_id].append((enrollment_id, student_id))
                enrollment_id += 1

    # Chapters, knowledge graph and course resources.
    knowledge_templates = {
        1: ["线性表与复杂度", "栈与队列", "树与二叉树", "图与图遍历", "查找与排序"],
        2: ["数据表示", "指令系统", "CPU数据通路", "存储层次", "输入输出系统"],
        3: ["关系模型", "SQL查询", "数据库设计", "规范化理论", "事务与并发控制"],
        4: ["进程与线程", "处理机调度", "同步与死锁", "虚拟内存", "文件系统"],
        5: ["协议分层", "IP编址与子网", "路由算法", "可靠传输", "HTTP与DNS"],
        6: ["需求工程", "软件建模", "架构设计", "软件测试", "项目管理"],
        7: ["智能体与搜索", "知识表示", "机器学习概念", "自然语言处理", "AI伦理"],
        8: ["数据预处理", "线性模型", "决策树", "模型评估", "特征工程"],
        9: ["安全基础", "对称密码", "公钥密码", "身份认证", "网络攻防"],
        10: ["分布式文件系统", "MapReduce", "Spark计算", "流处理", "数据治理"],
        11: ["渐进复杂度", "分治", "动态规划", "贪心算法", "回溯与分支限界"],
        12: ["HTML与CSS", "前端交互", "REST接口", "后端服务", "部署与运维"],
    }
    kp_ids_by_course: dict[int, list[int]] = defaultdict(list)
    chapter_id = 1
    kp_id = 1
    resource_id = 1
    resource_ids_by_course: dict[int, list[int]] = defaultdict(list)
    for course in courses:
        course_id, course_code, course_name = course[0], course[1], course[2]
        chapters = ["基础概念与方法", "核心机制与算法", "综合实践与应用"]
        chapter_ids = []
        for chapter_no, title in enumerate(chapters, 1):
            db.execute(
                "INSERT INTO course_chapters VALUES(?, ?, ?, ?, ?)",
                (chapter_id, course_id, chapter_no, f"第{chapter_no}章 {title}", f"{course_name}的{title}"),
            )
            chapter_ids.append(chapter_id)
            chapter_id += 1
        for pos, name in enumerate(knowledge_templates[course_id], 1):
            difficulty = 2 + (pos % 4)
            prereq = [] if pos == 1 else [kp_id - 1]
            db.execute(
                "INSERT INTO knowledge_points VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (kp_id, course_id, chapter_ids[min(2, (pos - 1) // 2)], f"{course_code}-KP{pos:02d}", name, difficulty, round(0.7 + 0.05 * (pos % 4), 2), json.dumps(prereq), f"{course_name}中的{name}"),
            )
            kp_ids_by_course[course_id].append(kp_id)
            kp_id += 1
        for kind, suffix, duration in [("课件", "核心课件", None), ("视频", "微课视频", 900 + course_id * 30), ("实验指导", "实践手册", None)]:
            title = f"{course_name}{suffix}"
            digest = hashlib.sha256(title.encode("utf-8")).digest()
            db.execute(
                "INSERT INTO learning_resources VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (resource_id, course_id, chapter_ids[(resource_id - 1) % 3], title, kind, f"/kb/{course_code.lower()}/{resource_id}", duration, f"面向{name}等核心内容的学习材料", digest, "2026-02-20T08:00:00"),
            )
            resource_ids_by_course[course_id].append(resource_id)
            resource_id += 1

    # Assessments, fine-grained item scores, attendance, learning events and interactions.
    assessment_id = 1
    item_id = 1
    submission_id = 1
    item_score_id = 1
    attendance_id = 1
    interaction_id = 1
    event_id = 1
    wrong_id = 1
    assessment_ids_by_offering: dict[int, list[int]] = defaultdict(list)
    assessment_items: dict[int, list[tuple[int, int]]] = defaultdict(list)
    student_course_scores: dict[tuple[int, int], list[tuple[float, float]]] = defaultdict(list)
    weak_points_by_student_offering: dict[tuple[int, int], list[tuple[int, float]]] = defaultdict(list)
    base_day = date(2026, 3, 2)
    assessment_specs = [
        ("第一次作业", "作业", 0.10, 10),
        ("阶段测验", "随堂测验", 0.15, 25),
        ("综合实验", "实验", 0.20, 45),
        ("期中考试", "期中考试", 0.25, 65),
        ("课程项目", "课程项目", 0.30, 95),
    ]
    item_types = ["单选", "判断", "简答", "编程"]

    for offering_id in range(1, 13):
        course_id = offering_id
        for title, assessment_type, weight, day_offset in assessment_specs:
            published = base_day + timedelta(days=day_offset - 7)
            due = base_day + timedelta(days=day_offset)
            db.execute(
                "INSERT INTO assessments VALUES(?, ?, ?, ?, 100, ?, ?, ?, ?)",
                (assessment_id, offering_id, f"{courses[course_id - 1][2]}·{title}", assessment_type, weight, iso(published), iso(due, 23, 59), 1 if assessment_type in ("作业", "实验") else 0),
            )
            assessment_ids_by_offering[offering_id].append(assessment_id)
            for item_no in range(1, 5):
                kp = kp_ids_by_course[course_id][(item_no + assessment_id) % 5]
                item_type = item_types[(item_no + assessment_id) % len(item_types)]
                db.execute(
                    "INSERT INTO assessment_items VALUES(?, ?, ?, ?, ?, 25, ?, ?, ?)",
                    (item_id, assessment_id, item_no, item_type, f"围绕“{knowledge_templates[course_id][(item_no + assessment_id) % 5]}”完成第{item_no}题", 1 + ((item_no + assessment_id) % 5), "示例参考答案", json.dumps({"知识准确": 0.5, "过程完整": 0.3, "表达规范": 0.2}, ensure_ascii=False)),
                )
                db.execute("INSERT INTO item_knowledge_points VALUES(?, ?, 1.0)", (item_id, kp))
                assessment_items[assessment_id].append((item_id, kp))
                item_id += 1
            assessment_id += 1

        for enrollment_pk, student_id in enrollment_ids_by_offering[offering_id]:
            traits = latent[student_id]
            weighted_scores = []
            for a_idx, aid in enumerate(assessment_ids_by_offering[offering_id]):
                _, _, weight, day_offset = assessment_specs[a_idx]
                due = base_day + timedelta(days=day_offset)
                miss_probability = 0.01 + (1 - traits["engagement"]) * 0.12
                if rng.random() < miss_probability:
                    db.execute(
                        "INSERT INTO submissions(id, assessment_id, student_id, attempt_no, status, feedback, attachment_meta) VALUES(?, ?, ?, 1, '未提交', ?, '{}')",
                        (submission_id, aid, student_id, "系统提醒：尚未提交，请及时联系教师。"),
                    )
                    raw_score = 0.0
                else:
                    item_total = 0.0
                    item_details = []
                    for current_item_id, kp in assessment_items[aid]:
                        difficulty = db.execute("SELECT difficulty FROM knowledge_points WHERE id=?", (kp,)).fetchone()[0]
                        expected = 0.46 + 0.55 * traits["ability"] + 0.18 * traits["engagement"] - 0.055 * difficulty
                        ratio = clamp(rng.gauss(expected, 0.12 * (1.15 - traits["consistency"])), 0, 1)
                        earned = round(25 * ratio, 1)
                        item_total += earned
                        correct = 1 if ratio >= 0.72 else 0
                        error_type = None if correct else choose_weighted(rng, [("概念混淆", 3), ("步骤遗漏", 2), ("边界条件", 2), ("计算错误", 1)])
                        item_details.append((current_item_id, kp, earned, correct, error_type))
                    raw_score = round(clamp(item_total + rng.gauss(0, 2), 0, 100), 1)
                    teacher_score = round(clamp(raw_score + rng.gauss(0, 1.2), 0, 100), 1)
                    late = rng.random() < (1 - traits["engagement"]) * 0.18
                    submit_day = due + timedelta(days=1) if late else due - timedelta(days=rng.randint(0, 2))
                    status = "迟交" if late else "已批改"
                    db.execute(
                        "INSERT INTO submissions VALUES(?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (submission_id, aid, student_id, iso(submit_day, 23 if late else rng.randint(17, 22), rng.randint(0, 59)), status, raw_score, raw_score, teacher_score, round(rng.uniform(0.84, 0.98), 3), "已给出知识点级反馈与改进建议。", json.dumps({"type": "online", "files": rng.randint(0, 2)}, ensure_ascii=False)),
                    )
                    for current_item_id, kp, earned, correct, error_type in item_details:
                        db.execute(
                            "INSERT INTO item_scores VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                            (item_score_id, submission_id, current_item_id, earned, correct, "匿名作答内容", error_type, json.dumps({"rule_score": earned, "manual_review": earned < 10}, ensure_ascii=False)),
                        )
                        mastery = clamp(earned / 25 * 0.88 + traits["engagement"] * 0.12, 0.05, 0.99)
                        weak_points_by_student_offering[(student_id, offering_id)].append((kp, mastery))
                        if not correct and rng.random() < 0.75:
                            db.execute(
                                "INSERT INTO wrong_book_entries VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                (wrong_id, student_id, item_score_id, kp, iso(submit_day), error_type or "需复盘", round(mastery, 3), round(clamp(mastery + rng.uniform(0.05, 0.25), 0, 1), 3) if rng.random() < 0.45 else None, choose_weighted(rng, [("待复习", 4), ("复习中", 3), ("已掌握", 2)]), iso(submit_day + timedelta(days=rng.randint(3, 12)))),
                            )
                            wrong_id += 1
                        item_score_id += 1
                weighted_scores.append((raw_score, weight))
                student_course_scores[(student_id, offering_id)].append((raw_score, weight))
                submission_id += 1
            final_score = round(sum(s * w for s, w in weighted_scores), 1)
            db.execute("UPDATE enrollments SET final_score=?, grade_point=? WHERE id=?", (final_score, score_to_gpa(final_score), enrollment_pk))

            for week in range(1, 13):
                lesson_day = base_day + timedelta(days=(offering_id % 5) + 7 * (week - 1))
                absent_chance = 0.015 + (1 - traits["engagement"]) * 0.13
                status = choose_weighted(rng, [("缺勤", absent_chance), ("迟到", absent_chance * 0.7), ("请假", 0.025), ("出勤", 1 - absent_chance * 1.7 - 0.025)])
                checkin = None if status in ("缺勤", "请假") else iso(lesson_day, 8, rng.randint(0, 12))
                db.execute(
                    "INSERT INTO attendance_records VALUES(?, ?, ?, ?, 1, ?, ?, ?)",
                    (attendance_id, offering_id, student_id, lesson_day.isoformat(), status, checkin, choose_weighted(rng, [("扫码", 6), ("教师录入", 2), ("系统同步", 2)])),
                )
                attendance_id += 1
                if rng.random() < 0.30 + 0.45 * traits["engagement"]:
                    interaction_type = choose_weighted(rng, [("随堂练习", 4), ("回答", 2), ("投票", 2), ("提问", 1), ("讨论", 1)])
                    correct = None if interaction_type in ("提问", "讨论") else int(rng.random() < traits["ability"])
                    db.execute(
                        "INSERT INTO classroom_interactions VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (interaction_id, offering_id, student_id, iso(lesson_day, 9, rng.randint(5, 50)), interaction_type, f"关于{rng.choice(knowledge_templates[course_id])}的课堂互动", "匿名互动结果", correct, round(rng.uniform(0.5, 2.0), 2), "困惑" if interaction_type == "提问" and rng.random() < 0.6 else "积极"),
                    )
                    interaction_id += 1

            for _ in range(6):
                resource = rng.choice(resource_ids_by_course[course_id])
                event_day = base_day + timedelta(days=rng.randint(0, 110))
                progress = clamp(rng.gauss(traits["engagement"], 0.18), 0.05, 1)
                db.execute(
                    "INSERT INTO learning_events VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (event_id, student_id, resource, "完成" if progress > 0.92 else "学习", iso(event_day, rng.randint(7, 23), rng.randint(0, 59)), rng.randint(90, 1800), round(progress, 3), choose_weighted(rng, [("网页端", 5), ("移动端", 4), ("平板", 1)]), json.dumps({"network": "campus_or_home"})),
                )
                event_id += 1

    # Three mastery snapshots per learner/knowledge point to support trend charts.
    mastery_id = 1
    for (student_id, offering_id), evidence in weak_points_by_student_offering.items():
        grouped: dict[int, list[float]] = defaultdict(list)
        for kp, value in evidence:
            grouped[kp].append(value)
        for kp, values in grouped.items():
            latest = clamp(sum(values) / len(values), 0.05, 0.99)
            slope = rng.uniform(-0.08, 0.14)
            snapshots = [clamp(latest - slope * 2, 0.05, 0.99), clamp(latest - slope, 0.05, 0.99), latest]
            trend = "上升" if slope > 0.025 else "下降" if slope < -0.025 else "稳定"
            for idx, value in enumerate(snapshots):
                db.execute(
                    "INSERT INTO mastery_snapshots VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                    (mastery_id, student_id, kp, iso(base_day + timedelta(days=35 * idx)), round(value, 3), len(values), round(min(0.98, 0.55 + len(values) * 0.08), 3), trend),
                )
                mastery_id += 1

    # Question-answer traces link student activity back to teacher analytics.
    session_id = 1
    message_id = 1
    qa_point_counts: dict[tuple[int, int], int] = defaultdict(int)
    for student_id in range(1, len(student_rows) + 1):
        available_offerings = [oid for oid, rows in enrollment_ids_by_offering.items() if any(sid == student_id for _, sid in rows)]
        for _ in range(rng.randint(1, 4)):
            offering_id = rng.choice(available_offerings)
            course_id = offering_id
            kp = rng.choice(kp_ids_by_course[course_id])
            kp_name = db.execute("SELECT name FROM knowledge_points WHERE id=?", (kp,)).fetchone()[0]
            started = base_day + timedelta(days=rng.randint(5, 112))
            satisfaction = choose_weighted(rng, [(3, 2), (4, 5), (5, 3)])
            resolved = 1 if satisfaction >= 4 else int(rng.random() < 0.5)
            db.execute(
                "INSERT INTO qa_sessions VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                (session_id, student_id, course_id, iso(started, rng.randint(18, 23), rng.randint(0, 59)), iso(started, 23, rng.randint(0, 59)), choose_weighted(rng, [("文字", 7), ("图片", 2), ("语音", 1)]), satisfaction, resolved),
            )
            db.execute("INSERT INTO qa_knowledge_points VALUES(?, ?, ?)", (session_id, kp, round(rng.uniform(0.75, 0.99), 3)))
            question = f"{kp_name}这一部分我没有理解，能结合课程例题分步骤解释吗？"
            answer = f"先回顾{kp_name}的定义，再按课程资料中的方法拆解，并给出一道相似练习。"
            db.execute("INSERT INTO qa_messages VALUES(?, ?, 'student', ?, ?, '[]', NULL, NULL)", (message_id, session_id, question, iso(started, 21, 10)))
            message_id += 1
            db.execute(
                "INSERT INTO qa_messages VALUES(?, ?, 'assistant', ?, ?, ?, ?, NULL)",
                (message_id, session_id, answer, iso(started, 21, 10), json.dumps([{"course_id": course_id, "knowledge_point": kp_name}], ensure_ascii=False), rng.randint(650, 2400)),
            )
            message_id += 1
            qa_point_counts[(course_id, kp)] += 1
            session_id += 1

    # Risks, adaptive tasks and recommendations.
    alert_id = 1
    task_id = 1
    recommendation_id = 1
    report_id = 1
    teacher_by_offering = {row[0]: row[3] for row in offerings}
    for offering_id in range(1, 13):
        course_id = offering_id
        students_in_offering = [student_id for _, student_id in enrollment_ids_by_offering[offering_id]]
        scored = []
        for student_id in students_in_offering:
            final = db.execute("SELECT final_score FROM enrollments WHERE offering_id=? AND student_id=?", (offering_id, student_id)).fetchone()[0]
            scored.append((student_id, final))
            traits = latent[student_id]
            risk_components = {
                "成绩下滑": clamp((68 - final) / 45, 0, 1),
                "学习活跃度低": clamp((0.58 - traits["engagement"]) / 0.5, 0, 1),
                "作业拖延": clamp((0.52 - traits["consistency"]) / 0.45, 0, 1),
            }
            risk_type, risk_score = max(risk_components.items(), key=lambda pair: pair[1])
            if risk_score >= 0.28:
                level = "高" if risk_score >= 0.7 else "中" if risk_score >= 0.48 else "低"
                db.execute(
                    "INSERT INTO risk_alerts VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (alert_id, student_id, offering_id, "2026-06-20T09:00:00", risk_type, level, round(risk_score, 3), json.dumps({"final_score": final, "engagement": round(traits["engagement"], 3)}, ensure_ascii=False), "跟进中" if level == "高" else "待处理", teacher_by_offering[offering_id] if level == "高" else None, "2026-06-21T10:00:00" if level == "高" else None),
                )
                alert_id += 1

        sorted_scores = sorted(scored, key=lambda pair: pair[1])
        groups = {
            "基础巩固": sorted_scores[: max(8, len(sorted_scores) // 4)],
            "标准提升": sorted_scores[len(sorted_scores) // 4 : 3 * len(sorted_scores) // 4],
            "拔高挑战": sorted_scores[3 * len(sorted_scores) // 4 :],
        }
        for level, members in groups.items():
            weak_kp = kp_ids_by_course[course_id][0 if level == "基础巩固" else 2 if level == "标准提升" else 4]
            db.execute(
                "INSERT INTO learning_tasks VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (task_id, offering_id, teacher_by_offering[offering_id], f"{courses[course_id - 1][2]}·{level}任务", "分层练习" if level != "拔高挑战" else "拓展项目", level, json.dumps({"knowledge_point_id": weak_kp, "question_count": 8 if level == "基础巩固" else 5, "adaptive": True}, ensure_ascii=False), "2026-06-22T08:00:00", "2026-06-29T23:59:00"),
            )
            for student_id, final in members:
                progress = clamp(rng.gauss(0.68 if level == "基础巩固" else 0.76, 0.22), 0, 1)
                status = "已完成" if progress >= 0.95 else "进行中" if progress > 0.05 else "待开始"
                db.execute(
                    "INSERT INTO task_assignments VALUES(?, ?, ?, ?, ?, ?)",
                    (task_id, student_id, f"依据课程综合得分{final:.1f}及知识点掌握度自动分层", status, round(progress, 3), "2026-06-27T20:00:00" if status == "已完成" else None),
                )
                db.execute(
                    "INSERT INTO recommendations VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (recommendation_id, student_id, offering_id, weak_kp, "2026-06-22T08:05:00", "练习题" if level != "拔高挑战" else "课程资源", f"{level}个性化学习建议", f"结合综合得分{final:.1f}、答疑和错题记录生成", 5 if level == "基础巩固" else 3, json.dumps({"task_id": task_id, "estimated_minutes": 35}, ensure_ascii=False), int(rng.random() < 0.68)),
                )
                recommendation_id += 1
            task_id += 1

        all_scores = [value for _, value in scored]
        class_average = round(sum(all_scores) / len(all_scores), 2)
        pass_rate = round(sum(value >= 60 for value in all_scores) / len(all_scores), 3)
        hot = sorted(
            [(kp, qa_point_counts[(course_id, kp)]) for kp in kp_ids_by_course[course_id]],
            key=lambda pair: pair[1],
            reverse=True,
        )[:3]
        weak = []
        for kp in kp_ids_by_course[course_id]:
            row = db.execute("SELECT AVG(mastery) FROM v_latest_mastery WHERE knowledge_point_id=?", (kp,)).fetchone()
            weak.append((kp, round(row[0] or 0, 3)))
        weak.sort(key=lambda pair: pair[1])
        db.execute(
            "INSERT INTO teaching_reports VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (report_id, offering_id, "2026-06-22T07:30:00", "2026-05-25", "2026-06-21", class_average, pass_rate, json.dumps([{"knowledge_point_id": kp, "mastery": mastery} for kp, mastery in weak[:3]], ensure_ascii=False), json.dumps([{"knowledge_point_id": kp, "question_count": count} for kp, count in hot], ensure_ascii=False), json.dumps({level: len(members) for level, members in groups.items()}, ensure_ascii=False), json.dumps(["优先复讲薄弱知识点", "将高频答疑问题转为随堂练习", "发布分层复习任务"], ensure_ascii=False), teacher_by_offering[offering_id], "2026-06-22T10:00:00"),
        )
        report_id += 1

    # Import history deliberately contains data-quality examples for the cleaning workflow.
    batches = [
        (1, "2024级匿名成绩.xlsx", "成绩", 1, "2026-06-21T18:00:00", 180, 174, 6, 2, "部分成功"),
        (2, "课堂互动_第16周.csv", "课堂互动", 2, "2026-06-21T18:10:00", 1240, 1238, 2, 0, "部分成功"),
        (3, "课程资源清单.xlsx", "课程资源", 3, "2026-06-21T18:20:00", 36, 36, 0, 0, "成功"),
    ]
    for batch in batches:
        digest = hashlib.sha256(batch[1].encode("utf-8")).digest()
        db.execute(
            "INSERT INTO data_import_batches VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (*batch, digest, json.dumps({"student_no": "学号", "score": "成绩"}, ensure_ascii=False)),
        )
    issues = [
        (1, 1, 17, "score", "空值", "", "待教师确认", "待处理"),
        (2, 1, 39, "student_no", "重复", "S240105", "保留首次记录", "自动修复"),
        (3, 1, 40, "student_no", "重复", "S240105", "删除重复记录", "自动修复"),
        (4, 1, 76, "score", "范围异常", "118", "100", "人工确认"),
        (5, 1, 121, "score", "格式错误", "八十五", "85", "自动修复"),
        (6, 1, 155, "student_no", "外键缺失", "S249999", None, "待处理"),
        (7, 2, 212, "occurred_at", "格式错误", "2026/13/42", None, "待处理"),
        (8, 2, 608, "student_no", "空值", "", "匿名课堂记录", "人工确认"),
    ]
    db.executemany("INSERT INTO data_quality_issues VALUES(?, ?, ?, ?, ?, ?, ?, ?)", issues)

    audit_rows = [
        (1, "system", None, "批量导入并校验", "data_import_batch", 1, "2026-06-21T18:00:05", "10.***.***.21", {"result": "partial"}),
        (2, "teacher", 1, "确认学情报告", "teaching_report", 1, "2026-06-22T10:00:00", "10.***.***.35", {"approved": True}),
        (3, "system", None, "生成分层学习任务", "learning_task", 1, "2026-06-22T08:00:00", None, {"model": "rule_v1"}),
    ]
    for row in audit_rows:
        db.execute("INSERT INTO audit_logs VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)", (*row[:8], json.dumps(row[8], ensure_ascii=False)))

    db.commit()
    integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise RuntimeError(f"SQLite integrity check failed: {integrity}")
    table_names = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    counts = {table: db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] for table in table_names}
    counts["views"] = db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='view'").fetchone()[0]
    db.close()
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description="生成智学双擎匿名演示数据库")
    parser.add_argument("--output", type=Path, default=DEFAULT_DB, help="SQLite 输出路径")
    args = parser.parse_args()
    counts = build_database(args.output.resolve())
    summary_path = args.output.resolve().with_suffix(".summary.json")
    summary_path.write_text(json.dumps(counts, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"DATABASE_OK: {args.output.resolve()}")
    print(f"SUMMARY_OK: {summary_path}")
    print(json.dumps(counts, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
