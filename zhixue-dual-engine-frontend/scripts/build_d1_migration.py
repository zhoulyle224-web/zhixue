"""Create the initial D1 migration from the generated dashboard snapshots."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT_PATH = ROOT / "data" / "web_snapshots.json"
MIGRATION_PATH = ROOT / "drizzle" / "0000_zhixue_snapshots.sql"


def quote(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def insert_rows(table: str, columns: list[str], rows: list[list[object]]) -> str:
    values = ",\n".join("(" + ",".join(quote(value) for value in row) + ")" for row in rows)
    return f"INSERT INTO {table} ({','.join(columns)}) VALUES\n{values};"


def main() -> None:
    payload = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    source_version = payload["meta"]["sourceVersion"]
    updated_at = payload["meta"]["generatedAt"]
    snapshot_rows: list[list[object]] = []
    snapshot_rows.append(["catalog", "catalog", json.dumps({"meta": payload["meta"], "catalog": payload["catalog"]}, ensure_ascii=False, separators=(",", ":")), source_version, updated_at])
    snapshot_rows.extend(
        ["teacher", key, json.dumps(value, ensure_ascii=False, separators=(",", ":")), source_version, updated_at]
        for key, value in payload["teacher"].items()
    )
    snapshot_rows.extend(
        ["student", key, json.dumps(value, ensure_ascii=False, separators=(",", ":")), source_version, updated_at]
        for key, value in payload["student"].items()
    )
    semantic = {
        "students": "学生基础信息",
        "courses": "课程信息",
        "submissions": "作业与考试提交",
        "item_scores": "题目级得分",
        "attendance_records": "考勤记录",
        "classroom_interactions": "课堂互动",
        "learning_events": "在线学习行为",
        "qa_sessions": "智能答疑",
        "wrong_book_entries": "错题本",
        "mastery_snapshots": "知识点掌握度",
        "risk_alerts": "学情风险预警",
        "task_assignments": "个性化任务",
    }
    counter_rows = [
        [name, count, semantic.get(name, "教学业务数据")]
        for name, count in payload["meta"]["tableCounts"].items()
    ]
    statements = [
        """CREATE TABLE `dashboard_snapshots` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `audience` text NOT NULL,
  `context_key` text NOT NULL,
  `payload_json` text NOT NULL,
  `source_version` text NOT NULL,
  `updated_at` text NOT NULL
);""",
        "CREATE UNIQUE INDEX `dashboard_snapshots_context_key_unique` ON `dashboard_snapshots` (`context_key`);",
        "CREATE INDEX `idx_dashboard_snapshots_audience` ON `dashboard_snapshots` (`audience`);",
        """CREATE TABLE `dataset_counters` (
  `table_name` text PRIMARY KEY NOT NULL,
  `row_count` integer NOT NULL,
  `semantic_type` text NOT NULL
);""",
        """CREATE TABLE `data_lineage` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `source_name` text NOT NULL,
  `source_type` text NOT NULL,
  `description` text NOT NULL,
  `is_synthetic` integer NOT NULL,
  `created_at` text NOT NULL
);""",
        insert_rows("dashboard_snapshots", ["audience", "context_key", "payload_json", "source_version", "updated_at"], snapshot_rows),
        insert_rows("dataset_counters", ["table_name", "row_count", "semantic_type"], counter_rows),
        insert_rows(
            "data_lineage",
            ["source_name", "source_type", "description", "is_synthetic", "created_at"],
            [["zhixue_demo.sqlite", "SQLite", "由完整校园学情数据库生成的匿名前端读模型；不发布题目答案和原始作答正文。", 1, updated_at]],
        ),
    ]
    MIGRATION_PATH.write_text("\n--> statement-breakpoint\n".join(statements) + "\n", encoding="utf-8")
    print(f"D1_MIGRATION_OK: {MIGRATION_PATH}")
    print(f"SNAPSHOTS: {len(snapshot_rows)}")


if __name__ == "__main__":
    main()
