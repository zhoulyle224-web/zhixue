import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createZhixueServer } from "../server/local-api.mjs";
import { createAuthenticatedFetch } from "./auth-test-helper.mjs";

let activeFetch = globalThis.fetch;
const fetch = (...args) => activeFetch(...args);

const A = "teacher:7:1";
const B = "teacher:7:5";
const fixtures = new URL("./fixtures/m2/", import.meta.url);

async function withServer(dbPath, work) {
  const server = createZhixueServer({ runtimeDbPath: dbPath });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base=`http://127.0.0.1:${server.address().port}`, previousFetch=activeFetch;
  activeFetch=createAuthenticatedFetch(base);
  try { return await work(base); }
  finally { activeFetch=previousFetch; await new Promise((done) => server.close(done)); }
}
async function post(base, path, body) {
  const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function get(base, path) {
  const response = await fetch(base + path);
  return { status: response.status, body: await response.json() };
}
async function importBatch(base, context = A, file = "dataset-a.csv") {
  const content = await readFile(new URL(file, fixtures), "utf8");
  const response = await post(base, "/api/import/validate", { context, fileName: file, content });
  assert.equal(response.status, 200);
  return response.body.data.batch.batchId;
}
async function confirm(base, batchId, context = A) {
  return post(base, `/api/import/${batchId}/confirm`, { context });
}
async function analyze(base, batchId, context = A) {
  return post(base, "/api/analyze", { context, batchId });
}
async function byId(base, analysisRunId, context = A) {
  return get(base, `/api/analysis/${analysisRunId}?context=${encodeURIComponent(context)}`);
}
async function withTempDb(work) {
  const dir = await mkdtemp(join(tmpdir(), "zhixue-m25-"));
  try { return await work(join(dir, "runtime.sqlite")); }
  finally {
    const safe = resolve(dir);
    if (!safe.startsWith(`${resolve(tmpdir())}${sep}`) || !safe.includes("zhixue-m25-")) throw new Error("拒绝清理非测试临时目录");
    await rm(safe, { recursive: true, force: true });
  }
}

test("H01 已确认批次返回稳定研判 ID 和完整来源证据", async () => {
  await withServer(":memory:", async (base) => {
    const batchId = await importBatch(base);
    assert.equal((await confirm(base, batchId)).status, 200);
    const response = await analyze(base, batchId);
    assert.equal(response.status, 200);
    assert.equal(response.body.source, "local_skill");
    assert.match(response.body.analysisRunId, /^analysis_[0-9a-f-]{36}$/);
    assert.equal(response.body.batchId, batchId);
    assert.equal(response.body.status, "completed");
    const e = response.body.data._evidence;
    assert.equal(e.analysisRunId, response.body.analysisRunId);
    assert.equal(e.batchId, batchId);
    assert.equal(e.context, A);
    assert.match(e.fileHash, /^[a-f0-9]{64}$/);
    assert.equal(e.validRows, 20);
    assert.equal(e.studentCount, 10);
    assert.equal(e.skillId, "academic-performance-analyzer");
    assert.ok(e.skillVersion);
    assert.ok(!Number.isNaN(Date.parse(e.analyzedAt)));
    const fixed = await byId(base, response.body.analysisRunId);
    assert.equal(fixed.status, 200);
    assert.deepEqual(fixed.body.data.result, response.body.data);
    assert.deepEqual(fixed.body.data._evidence, e);
    assert.equal(fixed.body.data.status, "completed");
  });
});

test("H02 重启后按研判 ID 读取原快照", async () => {
  await withTempDb(async (dbPath) => {
    let analysisRunId, original;
    await withServer(dbPath, async (base) => {
      const batchId = await importBatch(base);
      await confirm(base, batchId);
      const response = await analyze(base, batchId);
      analysisRunId = response.body.analysisRunId;
      original = response.body.data;
    });
    await withServer(dbPath, async (base) => {
      const response = await byId(base, analysisRunId);
      assert.equal(response.status, 200);
      assert.equal(response.body.data.analysisRunId, analysisRunId);
      assert.deepEqual(response.body.data.result, original);
    });
  });
});

test("H03 同批重复研判生成不同 ID，历史均可查", async () => {
  await withServer(":memory:", async (base) => {
    const batchId = await importBatch(base);
    await confirm(base, batchId);
    const first = await analyze(base, batchId);
    const second = await analyze(base, batchId);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(first.body.analysisRunId, second.body.analysisRunId);
    assert.equal((await byId(base, first.body.analysisRunId)).body.data.analysisRunId, first.body.analysisRunId);
    assert.equal((await byId(base, second.body.analysisRunId)).body.data.analysisRunId, second.body.analysisRunId);
    const latest = await get(base, `/api/import/latest?context=${encodeURIComponent(A)}`);
    assert.equal(latest.body.usage, "page_restore_only");
    assert.equal(latest.body.data.batch.status, "confirmed");
    assert.equal(latest.body.data.analysis.analysisRunId, second.body.analysisRunId);
  });
});

test("H04 重复确认保留原确认时间且不重复写记录", async () => {
  await withTempDb(async (dbPath) => {
    await withServer(dbPath, async (base) => {
      const batchId = await importBatch(base);
      const first = await confirm(base, batchId);
      const second = await confirm(base, batchId);
      assert.equal(first.status, 200);
      assert.equal(first.body.data.alreadyConfirmed, false);
      assert.equal(second.status, 200);
      assert.equal(second.body.data.alreadyConfirmed, true);
      assert.equal(second.body.data.confirmedAt, first.body.data.confirmedAt);
      assert.equal(second.body.data.batch.batchId, batchId);
    });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runtime_import_batches").get().count, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runtime_import_records").get().count, 20);
    } finally { db.close(); }
  });
});

test("H05 未确认批次不可研判，也不会生成运行记录", async () => {
  await withTempDb(async (dbPath) => {
    await withServer(dbPath, async (base) => {
      const batchId = await importBatch(base);
      const response = await analyze(base, batchId);
      assert.equal(response.status, 409);
      assert.equal(response.body.code, "IMPORT_BATCH_NOT_CONFIRMED");
    });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runtime_analysis_runs").get().count, 0); }
    finally { db.close(); }
  });
});

test("H06 跨 context 查询研判返回 403", async () => {
  await withServer(":memory:", async (base) => {
    const batchId = await importBatch(base);
    await confirm(base, batchId);
    const run = await analyze(base, batchId);
    const response = await byId(base, run.body.analysisRunId, B);
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "ANALYSIS_CONTEXT_MISMATCH");
    assert.equal(response.body.data, undefined);
  });
});

test("H07 不存在的研判返回 404", async () => {
  await withServer(":memory:", async (base) => {
    const response = await byId(base, "analysis_00000000-0000-0000-0000-000000000000");
    assert.equal(response.status, 404);
    assert.equal(response.body.code, "ANALYSIS_NOT_FOUND");
  });
});

test("H08/H09 导入 B 后 latest 指向 B，但 A 的固定 ID 与结果不漂移", async () => {
  await withServer(":memory:", async (base) => {
    const batchA = await importBatch(base, A, "dataset-a.csv");
    await confirm(base, batchA);
    const analysisA = await analyze(base, batchA);
    const batchB = await importBatch(base, A, "dataset-b.csv");
    await confirm(base, batchB);
    const analysisB = await analyze(base, batchB);
    assert.notEqual(analysisA.body.analysisRunId, analysisB.body.analysisRunId);
    const latest = await get(base, `/api/import/latest?context=${encodeURIComponent(A)}`);
    assert.equal(latest.body.data.batch.batchId, batchB);
    assert.equal(latest.body.data.analysis.analysisRunId, analysisB.body.analysisRunId);
    const fixedA = await byId(base, analysisA.body.analysisRunId);
    const fixedB = await byId(base, analysisB.body.analysisRunId);
    assert.equal(fixedA.status, 200);
    assert.equal(fixedB.status, 200);
    assert.equal(fixedA.body.data.result.overall_summary.average_score, 68);
    assert.equal(fixedB.body.data.result.overall_summary.average_score, 92.5);
    assert.equal(fixedA.body.data.batchId, batchA);
    assert.equal(fixedB.body.data.batchId, batchB);
  });
});

test("H10 旧直接分数接口保持兼容", async () => {
  await withServer(":memory:", async (base) => {
    const response = await post(base, "/api/analyze", { scores: [{ name: "S1", score: 88 }], knowledgePoints: [{ name: "K", mastery_rate: 88 }] });
    assert.equal(response.status, 200);
    assert.equal(response.body.source, "local_skill");
    assert.equal(response.body.data.overall_summary.average_score, 88);
    assert.equal(response.body.analysisRunId, undefined);
  });
});

test("状态门禁：非完成研判或非确认批次不得按 ID 供下游消费", async () => {
  await withTempDb(async (dbPath) => {
    let batchId, analysisRunId;
    await withServer(dbPath, async (base) => {
      batchId = await importBatch(base);
      await confirm(base, batchId);
      analysisRunId = (await analyze(base, batchId)).body.analysisRunId;
    });
    const db = new DatabaseSync(dbPath);
    try { db.prepare("UPDATE runtime_analysis_runs SET status = 'running' WHERE id = ?").run(analysisRunId); }
    finally { db.close(); }
    await withServer(dbPath, async (base) => {
      const response = await byId(base, analysisRunId);
      assert.equal(response.status, 409);
      assert.equal(response.body.code, "ANALYSIS_NOT_COMPLETED");
      const latest = await get(base, `/api/import/latest?context=${encodeURIComponent(A)}`);
      assert.equal(latest.body.data.analysis, null);
    });
    const db2 = new DatabaseSync(dbPath);
    try {
      db2.prepare("UPDATE runtime_analysis_runs SET status = 'completed' WHERE id = ?").run(analysisRunId);
      db2.prepare("UPDATE runtime_import_batches SET status = 'validated', confirmed_at = NULL WHERE id = ?").run(batchId);
    } finally { db2.close(); }
    await withServer(dbPath, async (base) => {
      const response = await byId(base, analysisRunId);
      assert.equal(response.status, 409);
      assert.equal(response.body.code, "ANALYSIS_NOT_COMPLETED");
      const latest = await get(base, `/api/import/latest?context=${encodeURIComponent(A)}`);
      assert.equal(latest.body.data.analysis, null);
    });
  });
});

test("旧 M2 SQLite 无损迁移：analyzed 批次与无 status 的历史研判可继续读取", async () => {
  await withTempDb(async (dbPath) => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`CREATE TABLE runtime_import_batches (
        id TEXT PRIMARY KEY, context_key TEXT NOT NULL, file_name TEXT NOT NULL,
        file_format TEXT NOT NULL, file_size_bytes INTEGER NOT NULL, file_sha256 TEXT NOT NULL,
        total_rows INTEGER NOT NULL, valid_rows INTEGER NOT NULL, invalid_rows INTEGER NOT NULL,
        duplicate_rows INTEGER NOT NULL, warning_rows INTEGER NOT NULL,
        blocking_issue_count INTEGER NOT NULL, warning_issue_count INTEGER NOT NULL,
        status TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL,
        confirmed_at TEXT, confirmed_by_context TEXT
      );
      CREATE TABLE runtime_analysis_runs (
        id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, context_key TEXT NOT NULL,
        skill_id TEXT NOT NULL, skill_version TEXT NOT NULL, input_digest TEXT NOT NULL,
        result_json TEXT NOT NULL, generated_at TEXT NOT NULL
      );`);
      db.prepare(`INSERT INTO runtime_import_batches VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "b_00000000-0000-0000-0000-000000000001", A, "legacy.csv", "csv", 50, "a".repeat(64), 1, 1, 0, 0, 0, 0, 0,
        "analyzed", 1, "2026-09-16T08:00:00.000Z", "2026-09-16T08:05:00.000Z", A,
      );
      db.prepare("INSERT INTO runtime_analysis_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        "a_legacy", "b_00000000-0000-0000-0000-000000000001", A, "academic-performance-analyzer", "old", "digest",
        JSON.stringify({ overall_summary: { total_students: 1, average_score: 77 } }),
        "2026-09-16T08:06:00.000Z",
      );
    } finally { db.close(); }
    await withServer(dbPath, async (base) => {
      const run = await byId(base, "a_legacy");
      assert.equal(run.status, 200);
      assert.equal(run.body.data.status, "completed");
      assert.equal(run.body.data._evidence.fileHash, "a".repeat(64));
      const latest = await get(base, `/api/import/latest?context=${encodeURIComponent(A)}`);
      assert.equal(latest.body.data.batch.status, "confirmed");
      assert.equal(latest.body.data.analysis.analysisRunId, "a_legacy");
      const repeated = await confirm(base, "b_00000000-0000-0000-0000-000000000001");
      assert.equal(repeated.status, 200);
      assert.equal(repeated.body.data.alreadyConfirmed, true);
    });
  });
});
