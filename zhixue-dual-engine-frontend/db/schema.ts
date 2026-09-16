import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The complete offline model lives in db/schema.sql. The hosted site uses a
// privacy-preserving read model generated from that database so dashboards can
// load quickly without publishing row-level assessment answers.
export const dashboardSnapshots = sqliteTable("dashboard_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  audience: text("audience", { enum: ["catalog", "teacher", "student"] }).notNull(),
  contextKey: text("context_key").notNull().unique(),
  payloadJson: text("payload_json").notNull(),
  sourceVersion: text("source_version").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const datasetCounters = sqliteTable("dataset_counters", {
  tableName: text("table_name").primaryKey(),
  rowCount: integer("row_count").notNull(),
  semanticType: text("semantic_type").notNull(),
});

export const dataLineage = sqliteTable("data_lineage", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceName: text("source_name").notNull(),
  sourceType: text("source_type").notNull(),
  description: text("description").notNull(),
  isSynthetic: integer("is_synthetic", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull(),
});
