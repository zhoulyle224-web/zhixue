"""Export privacy-preserving dashboard snapshots from the full SQLite model."""

from __future__ import annotations

import json
import sqlite3
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "zhixue_demo.sqlite"
OUTPUTS = [ROOT / "data" / "web_snapshots.json", ROOT / "github-pages" / "assets" / "demo-data.json"]
SOURCE_VERSION = "2026-08-25-v1"
COLORS = ["#46dfa1", "#43d8ff", "#617fff", "#ffb45e", "#ff8e7c"]


def rows(db: sqlite3.Connection, sql: str, params=()):
    return [dict(row) for row in db.execute(sql, params)]


def scalar(db: sqlite3.Connection, sql: str, params=(), default=0):
    row = db.execute(sql, params).fetchone()
    return default if row is None or row[0] is None else row[0]


def pct(value: float) -> int:
    return round(float(value) * 100)


def mastery_rows(db: sqlite3.Connection, course_id: int, student_ids: list[int] | None = None):
    where = "kp.course_id = ?"
    params: list[object] = [course_id]
    if student_ids:
        marks = ",".join("?" for _ in student_ids)
        where += f" AND m.student_id IN ({marks})"
        params.extend(student_ids)
    data = rows(
        db,
        f"""
        SELECT kp.id, kp.name, AVG(m.mastery) AS mastery, COUNT(*) AS evidence_count
        FROM v_latest_mastery m
        JOIN knowledge_points kp ON kp.id = m.knowledge_point_id
        WHERE {where}
        GROUP BY kp.id, kp.name
        ORDER BY mastery ASC
        """,
        params,
    )
    return [
        {
            "id": item["id"],
            "name": item["name"],
            "value": pct(item["mastery"]),
            "evidenceCount": item["evidence_count"],
            "color": COLORS[index % len(COLORS)],
        }
        for index, item in enumerate(data)
    ]


def build_teacher_context(db: sqlite3.Connection, offering_id: int, class_id: int):
    context = dict(
        db.execute(
            """
            SELECT o.id AS offering_id, c.id AS course_id, c.course_code, c.course_name,
                   cl.id AS class_id, cl.class_code, cl.class_name
            FROM course_offerings o
            JOIN courses c ON c.id = o.course_id
            JOIN offering_classes oc ON oc.offering_id = o.id
            JOIN classes cl ON cl.id = oc.class_id
            WHERE o.id = ? AND cl.id = ?
            """,
            (offering_id, class_id),
        ).fetchone()
    )
    student_ids = [
        row[0]
        for row in db.execute(
            """
            SELECT e.student_id
            FROM enrollments e JOIN students s ON s.id = e.student_id
            WHERE e.offering_id = ? AND s.class_id = ?
            """,
            (offering_id, class_id),
        )
    ]
    marks = ",".join("?" for _ in student_ids)
    final_scores = [
        row[0]
        for row in db.execute(
            f"SELECT final_score FROM enrollments WHERE offering_id=? AND student_id IN ({marks})",
            [offering_id, *student_ids],
        )
        if row[0] is not None
    ]
    knowledge = mastery_rows(db, context["course_id"], student_ids)
    average_mastery = round(sum(item["value"] for item in knowledge) / max(1, len(knowledge)))
    attendance = scalar(
        db,
        f"SELECT AVG(CASE WHEN status='出勤' THEN 1.0 ELSE 0.0 END) FROM attendance_records WHERE offering_id=? AND student_id IN ({marks})",
        [offering_id, *student_ids],
    )
    unresolved = scalar(
        db,
        f"SELECT COUNT(*) FROM qa_sessions WHERE course_id=? AND student_id IN ({marks}) AND resolved=0",
        [context["course_id"], *student_ids],
    )
    risks = rows(
        db,
        f"""
        SELECT r.risk_level, COUNT(*) AS count
        FROM risk_alerts r
        WHERE r.offering_id=? AND r.student_id IN ({marks}) AND r.status <> '已关闭'
        GROUP BY r.risk_level
        """,
        [offering_id, *student_ids],
    )
    risk_counts = {row["risk_level"]: row["count"] for row in risks}
    tiers = {
        "拓展组": sum(score >= 85 for score in final_scores),
        "提升组": sum(60 <= score < 85 for score in final_scores),
        "巩固组": sum(score < 60 for score in final_scores),
    }
    hot_topics = rows(
        db,
        """
        SELECT knowledge_point AS name, question_count AS count
        FROM v_hot_qa_topics
        WHERE course_id=?
        ORDER BY question_count DESC
        LIMIT 5
        """,
        (context["course_id"],),
    )
    quality = rows(
        db,
        """
        SELECT issue_type, COUNT(*) AS count
        FROM data_quality_issues
        GROUP BY issue_type
        ORDER BY count DESC
        """,
    )
    average_score = round(sum(final_scores) / max(1, len(final_scores)), 1)
    return {
        **context,
        "contextKey": f"teacher:{offering_id}:{class_id}",
        "studentCount": len(student_ids),
        "averageScore": average_score,
        "passRate": round(sum(score >= 60 for score in final_scores) / max(1, len(final_scores)) * 100),
        "attendanceRate": pct(attendance),
        "averageMastery": average_mastery,
        "weakCount": sum(item["value"] < 60 for item in knowledge),
        "pendingCount": unresolved,
        "riskCount": sum(risk_counts.values()),
        "highRiskCount": risk_counts.get("高", 0),
        "knowledge": knowledge,
        "tiers": tiers,
        "hotTopics": hot_topics,
        "qualityIssues": quality,
        "updatedAt": "2026-06-22T10:00:00",
    }


def build_student_context(db: sqlite3.Connection, student_no: str):
    student = dict(
        db.execute(
            """
            SELECT s.id, s.student_no, s.display_name, cl.class_name, m.name AS major_name
            FROM students s
            JOIN classes cl ON cl.id = s.class_id
            JOIN majors m ON m.id = cl.major_id
            WHERE s.student_no=?
            """,
            (student_no,),
        ).fetchone()
    )
    course_rows = rows(
        db,
        """
        SELECT o.id AS offering_id, c.id AS course_id, c.course_code, c.course_name,
               e.final_score, e.grade_point
        FROM enrollments e
        JOIN course_offerings o ON o.id=e.offering_id
        JOIN courses c ON c.id=o.course_id
        WHERE e.student_id=?
        ORDER BY c.course_name
        """,
        (student["id"],),
    )
    courses = []
    for item in course_rows:
        knowledge = rows(
            db,
            """
            SELECT kp.id, kp.name, m.mastery, m.trend
            FROM v_latest_mastery m
            JOIN knowledge_points kp ON kp.id=m.knowledge_point_id
            WHERE m.student_id=? AND kp.course_id=?
            ORDER BY m.mastery ASC
            """,
            (student["id"], item["course_id"]),
        )
        knowledge = [
            {"id": row["id"], "name": row["name"], "value": pct(row["mastery"]), "trend": row["trend"], "color": COLORS[index % len(COLORS)]}
            for index, row in enumerate(knowledge)
        ]
        mastery = round(sum(row["value"] for row in knowledge) / max(1, len(knowledge)))
        attendance = scalar(
            db,
            "SELECT AVG(CASE WHEN status='出勤' THEN 1.0 ELSE 0.0 END) FROM attendance_records WHERE student_id=? AND offering_id=?",
            (student["id"], item["offering_id"]),
        )
        tasks = rows(
            db,
            """
            SELECT t.id, t.title, t.target_level AS tier, t.task_type, ta.status,
                   ta.progress, ta.assigned_reason
            FROM task_assignments ta
            JOIN learning_tasks t ON t.id=ta.task_id
            WHERE ta.student_id=? AND t.offering_id=?
            ORDER BY t.id
            """,
            (student["id"], item["offering_id"]),
        )
        wrong_count = scalar(
            db,
            """
            SELECT COUNT(*) FROM wrong_book_entries w
            JOIN knowledge_points kp ON kp.id=w.knowledge_point_id
            WHERE w.student_id=? AND kp.course_id=? AND w.review_status <> '已掌握'
            """,
            (student["id"], item["course_id"]),
        )
        qa = rows(
            db,
            """
            SELECT q.id, q.started_at, q.satisfaction, q.resolved,
                   MAX(CASE WHEN m.role='student' THEN m.content END) AS question,
                   MAX(CASE WHEN m.role='assistant' THEN m.content END) AS answer
            FROM qa_sessions q JOIN qa_messages m ON m.session_id=q.id
            WHERE q.student_id=? AND q.course_id=?
            GROUP BY q.id, q.started_at, q.satisfaction, q.resolved
            ORDER BY q.started_at DESC LIMIT 8
            """,
            (student["id"], item["course_id"]),
        )
        tier = "拓展组" if item["final_score"] >= 85 else "提升组" if item["final_score"] >= 60 else "巩固组"
        courses.append(
            {
                **item,
                "id": f"db-{item['offering_id']}",
                "score": item["final_score"],
                "mastery": mastery,
                "attendanceRate": pct(attendance),
                "tier": tier,
                "wrongCount": wrong_count,
                "knowledge": knowledge,
                "tasks": tasks,
                "qa": qa,
            }
        )
    return {
        "contextKey": f"student:{student_no}",
        "student": student,
        "courses": courses,
        "updatedAt": "2026-06-22T10:00:00",
    }


def main() -> None:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    contexts = rows(
        db,
        """
        SELECT o.id AS offering_id, c.course_code, c.course_name,
               cl.id AS class_id, cl.class_code, cl.class_name,
               COUNT(e.id) AS student_count
        FROM offering_classes oc
        JOIN course_offerings o ON o.id=oc.offering_id
        JOIN courses c ON c.id=o.course_id
        JOIN classes cl ON cl.id=oc.class_id
        JOIN students s ON s.class_id=cl.id
        JOIN enrollments e ON e.offering_id=o.id AND e.student_id=s.id
        GROUP BY o.id, c.course_code, c.course_name, cl.id, cl.class_code, cl.class_name
        ORDER BY c.course_name, cl.class_name
        """,
    )
    teacher = {
        f"teacher:{item['offering_id']}:{item['class_id']}": build_teacher_context(db, item["offering_id"], item["class_id"])
        for item in contexts
    }
    student = build_student_context(db, "S240101")
    table_counts = {
        row["name"]: scalar(db, f'SELECT COUNT(*) FROM "{row["name"]}"')
        for row in rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    }
    payload = {
        "meta": {
            "sourceVersion": SOURCE_VERSION,
            "generatedAt": "2026-08-25T20:00:00+08:00",
            "isSynthetic": True,
            "studentCount": table_counts["students"],
            "tableCount": len(table_counts),
            "recordCount": sum(table_counts.values()),
            "tableCounts": table_counts,
        },
        "catalog": contexts,
        "teacher": teacher,
        "student": {student["contextKey"]: student},
    }
    db.close()
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    for output in OUTPUTS:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text, encoding="utf-8")
        print(f"SNAPSHOT_OK: {output}")


if __name__ == "__main__":
    main()
