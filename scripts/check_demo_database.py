"""Run integrity and scenario checks against the generated demo database."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "zhixue_demo.sqlite"


def scalar(db: sqlite3.Connection, sql: str):
    return db.execute(sql).fetchone()[0]


def main() -> None:
    if not DB_PATH.exists():
        raise SystemExit("数据库不存在，请先运行 scripts/build_demo_database.py")

    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    checks = {
        "integrity": scalar(db, "PRAGMA integrity_check") == "ok",
        "foreign_keys": len(db.execute("PRAGMA foreign_key_check").fetchall()) == 0,
        "student_count": scalar(db, "SELECT COUNT(*) FROM students") == 180,
        "all_score_ranges": scalar(db, "SELECT COUNT(*) FROM submissions WHERE score < 0 OR score > 100") == 0,
        "anomaly_examples": scalar(db, "SELECT COUNT(DISTINCT issue_type) FROM data_quality_issues") >= 5,
        "teacher_reports": scalar(db, "SELECT COUNT(*) FROM teaching_reports") >= 12,
        "qa_feedback_loop": scalar(db, "SELECT COUNT(*) FROM qa_knowledge_points") > 0,
        "personalized_tasks": scalar(db, "SELECT COUNT(*) FROM task_assignments") > 1000,
    }
    failed = [name for name, passed in checks.items() if not passed]
    if failed:
        raise SystemExit("DATABASE_CHECK_FAILED: " + ", ".join(failed))

    dashboard = [dict(row) for row in db.execute(
        """
        SELECT course_name, student_count, average_score, pass_rate, attendance_rate
        FROM v_class_course_dashboard
        ORDER BY class_id, offering_id
        LIMIT 5
        """
    )]
    hot_topics = [dict(row) for row in db.execute(
        """
        SELECT course_name, knowledge_point, question_count
        FROM v_hot_qa_topics
        ORDER BY question_count DESC
        LIMIT 5
        """
    )]
    print("DATABASE_CHECK_OK")
    print(json.dumps({"checks": checks, "dashboard_sample": dashboard, "hot_topics": hot_topics}, ensure_ascii=False, indent=2))
    db.close()


if __name__ == "__main__":
    main()
