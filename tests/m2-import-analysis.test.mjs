import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createZhixueServer } from "../server/local-api.mjs";
import { createAuthenticatedFetch } from "./auth-test-helper.mjs";

let activeFetch = globalThis.fetch;
const fetch = (...args) => activeFetch(...args);

const FIXTURES = fileURLToPath(new URL("./fixtures/m2/", import.meta.url));
const A = "teacher:7:1";
const B = "teacher:7:5";

async function withServer(path, run) {
  const server = createZhixueServer({ runtimeDbPath: path });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const previousFetch=activeFetch; activeFetch=createAuthenticatedFetch(base);
  try { return await run(base); }
  finally { activeFetch=previousFetch; await new Promise((ok) => server.close(ok)); }
}

async function post(base, url, body) {
  const response = await fetch(`${base}${url}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

async function fixture(name) { return readFile(join(FIXTURES, name), "utf8"); }
async function validate(base, context, name, content) {
  return post(base, "/api/import/validate", { context, fileName: name, content });
}

test("M2-T01/M2-T04/M2-T05/M2-T06/M2-T11 数据集 A / B 真实计算并随输入变化，且保留原直接分数接口", async () => {
  await withServer(":memory:", async (base) => {
    const a = await validate(base, A, "dataset-a.csv", await fixture("dataset-a.csv"));
    assert.equal(a.status, 200);
    assert.equal(a.payload.data.quality.validRows, 20);
    assert.equal(a.payload.data.quality.invalidRows, 0);
    const aId = a.payload.data.batch.batchId;
    const before = await post(base, "/api/analyze", { context: A, batchId: aId });
    assert.equal(before.status, 409);
    assert.equal(before.payload.code, "IMPORT_BATCH_NOT_CONFIRMED");
    assert.equal((await post(base, `/api/import/${aId}/confirm`, { context: A })).status, 200);
    const analyzedA = await post(base, "/api/analyze", { context: A, batchId: aId });
    assert.equal(analyzedA.status, 200);
    const x = analyzedA.payload.data;
    assert.equal(x.overall_summary.total_students, 10);
    assert.equal(x.overall_summary.average_score, 68);
    assert.equal(x.overall_summary.pass_rate, "70%");
    assert.equal(x.overall_summary.excellent_rate, "20%");
    assert.equal(x.student_stratification.excellent_students.length, 2);
    assert.equal(x.student_stratification.potential_students.length, 5);
    assert.equal(x.student_stratification.struggling_students.length, 3);
    assert.deepEqual(x.knowledge_analysis.map((item) => item.mastery_rate), ["73%", "63%"]);
    assert.equal(x._evidence.batchId, aId);
    assert.equal(x._evidence.validRows, 20);
    assert.match(x._evidence.sha256, /^[a-f0-9]{64}$/);

    const bJson = JSON.stringify((await fixture("dataset-b.csv")).trim().split(/\r?\n/).slice(1).map((line) => {
      const [anonymous_id, knowledge_point, score, completed_at] = line.split(",");
      return { anonymous_id, knowledge_point, score: Number(score), completed_at };
    }));
    const b = await validate(base, A, "dataset-b.json", bJson);
    assert.equal(b.payload.data.batch.file.format, "json");
    assert.equal(b.payload.data.quality.validRows, 20);
    const bId = b.payload.data.batch.batchId;
    await post(base, `/api/import/${bId}/confirm`, { context: A });
    const analyzedB = await post(base, "/api/analyze", { context: A, batchId: bId });
    assert.equal(analyzedB.payload.data.overall_summary.average_score, 92.5);
    assert.equal(analyzedB.payload.data.overall_summary.pass_rate, "100%");
    assert.equal(analyzedB.payload.data.student_stratification.excellent_students.length, 10);
    assert.notDeepEqual(analyzedB.payload.data.teaching_suggestions, x.teaching_suggestions);

    const direct = await post(base, "/api/analyze", { scores: [{ name: "S1", score: 88 }], knowledgePoints: [{ name: "K", mastery_rate: 88 }] });
    assert.equal(direct.status, 200);
    assert.equal(direct.payload.source, "local_skill");
    assert.equal(direct.payload.data.overall_summary.average_score, 88);
  });
});

test("M2-T03/M2-T09 混合异常行被排除、时间警告可保留，PII 与原始文件不落盘", async () => {
  await withServer(":memory:", async (base) => {
    const result = await validate(base, A, "invalid-mixed.csv", await fixture("invalid-mixed.csv"));
    assert.equal(result.status, 200);
    const { batch, quality, issues, preview } = result.payload.data;
    assert.equal(quality.totalRows, 8);
    assert.equal(quality.validRows, 2);
    assert.equal(quality.invalidRows, 6);
    assert.equal(quality.duplicateRows, 1);
    assert.equal(quality.warningRows, 1);
    assert.equal(issues.some((i) => i.code === "PII_VALUE_DETECTED"), true);
    assert.equal(issues.some((i) => i.code === "EMPTY_REQUIRED_VALUE"), true);
    assert.equal(issues.some((i) => i.code === "INVALID_SCORE_TYPE"), true);
    assert.doesNotMatch(JSON.stringify(result.payload), /13812345678/);
    assert.equal(preview.length, 8);
    await post(base, `/api/import/${batch.batchId}/confirm`, { context: A });
    const analyzed = await post(base, "/api/analyze", { context: A, batchId: batch.batchId });
    assert.equal(analyzed.status, 200);
    assert.equal(analyzed.payload.data._evidence.validRows, 2);
    assert.equal(analyzed.payload.data._evidence.excludedRows, 6);
  });
});

test("M2-T07/M2-T12 批次按班级隔离，错误文件明确且 runtime DB 不暴露", async () => {
  await withServer(":memory:", async (base) => {
    const a = await validate(base, A, "dataset-a.csv", await fixture("dataset-a.csv"));
    const id = a.payload.data.batch.batchId;
    assert.equal((await post(base, `/api/import/${id}/confirm`, { context: B })).payload.code, "IMPORT_CONTEXT_MISMATCH");
    assert.equal((await post(base, "/api/analyze", { context: B, batchId: id })).status, 403);
    assert.equal((await post(base, "/api/analyze", { context: A, batchId: "b_00000000-0000-0000-0000-000000000000" })).payload.code, "IMPORT_BATCH_NOT_FOUND");
    assert.equal((await validate(base, A, "x.txt", "x")).payload.code, "IMPORT_UNSUPPORTED_FILE");
    assert.equal((await validate(base, A, "x.csv", " ")).payload.code, "IMPORT_EMPTY_FILE");
    const schemaError = await validate(base, A, "x.csv", "abc,def\na,b");
    assert.equal(schemaError.payload.code, "IMPORT_SCHEMA_MISMATCH");
    assert.equal(schemaError.payload.issues[0].rowNumber, 0);
    assert.equal((await validate(base, A, "x.csv", "匿名编号,知识点,得分,完成时间\n\"S001,知识点A,70,2026-09-01")).payload.code, "IMPORT_INVALID_CSV");
    assert.equal((await validate(base, A, "x.json", "{" )).payload.code, "IMPORT_INVALID_JSON");
    assert.equal((await validate(base, A, "x.csv", "匿名编号,知识点,得分,完成时间\nS1,A,120,2026-09-01")).payload.code, "IMPORT_NO_VALID_ROWS");
    assert.equal((await validate(base, A, "x.csv", "x".repeat(10 * 1024 * 1024 + 1))).status, 413);
    const latestB = await fetch(`${base}/api/import/latest?context=${encodeURIComponent(B)}`).then((r) => r.json());
    assert.equal(latestB.data, null);
    assert.equal((await fetch(`${base}/data/runtime/zhixue_runtime.sqlite`)).status, 404);
  });
});

test("M2-T02/M2-T08 JSON 与 CSV 可解析；最近批次重启后保留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zhixue-m2-"));
  const dbPath = join(dir, "runtime.sqlite");
  try {
    let savedId;
    await withServer(dbPath, async (base) => {
      const csv = "\ufeff匿名编号,知识点,得分\r\nS001,\"知识点, \"\"A\"\"\",80\r\n";
      const csvResult = await validate(base, A, "bom.csv", csv);
      assert.equal(csvResult.payload.data.quality.validRows, 1);
      assert.equal(csvResult.payload.data.preview[0].rowNumber, 2);
      assert.equal(csvResult.payload.data.preview[0].knowledgePoint, '知识点, "A"');
      const data = [{ anonymous_id: "S001", knowledge_point: "知识点A", score: 90, extra: "ignored-marker-9f2e" }];
      const imported = await validate(base, A, "json.json", JSON.stringify(data));
      savedId = imported.payload.data.batch.batchId;
      await post(base, `/api/import/${savedId}/confirm`, { context: A });
      assert.equal((await post(base, "/api/analyze", { context: A, batchId: savedId })).status, 200);
    });
    await withServer(dbPath, async (base) => {
      const latest = await fetch(`${base}/api/import/latest?context=${encodeURIComponent(A)}`).then((r) => r.json());
      assert.equal(latest.data.batch.batchId, savedId);
      assert.equal(latest.data.batch.status, "confirmed");
      assert.equal(latest.data.analysis.result.overall_summary.average_score, 90);
    });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runtime_import_records WHERE completed_at IS NULL").get().count >= 1, true);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runtime_import_records WHERE anonymous_id LIKE '%ignored-marker-%'").get().count, 0);
      assert.equal(db.prepare("SELECT result_json FROM runtime_analysis_runs LIMIT 1").get().result_json.includes("ignored-marker-9f2e"), false);
    } finally { db.close(); }
    const diskText = (await readFile(dbPath)).toString("utf8");
    assert.equal(diskText.includes('"extra":"ignored-marker-9f2e"'), false);
  } finally {
    const safe = resolve(dir);
    if (!safe.startsWith(`${resolve(tmpdir())}${sep}`) || !safe.includes("zhixue-m2-")) throw new Error("拒绝清理非测试临时目录");
    await rm(safe, { recursive: true, force: true });
  }
});

test("M2-T10 5000 行可导入，基线 SQLite 测试前后哈希一致", async () => {
  const baseline = fileURLToPath(new URL("../data/zhixue_demo.sqlite", import.meta.url));
  const before = createHash("sha256").update(await readFile(baseline)).digest("hex");
  const rows = Array.from({ length: 5000 }, (_, index) => `S${String(index + 1).padStart(6, "0")},知识点A,75`);
  await withServer(":memory:", async (base) => {
    const result = await validate(base, A, "large.csv", `匿名编号,知识点,得分\n${rows.join("\n")}`);
    assert.equal(result.status, 200);
    assert.equal(result.payload.data.quality.validRows, 5000);
    assert.equal(result.payload.data.preview.length, 20);
  });
  const after = createHash("sha256").update(await readFile(baseline)).digest("hex");
  assert.equal(after, before);
});
