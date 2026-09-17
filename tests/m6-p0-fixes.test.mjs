import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createZhixueServer } from "../server/local-api.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const BASELINE = join(ROOT, "data", "zhixue_demo.sqlite");
const FIXTURES = join(ROOT, "tests", "fixtures", "m2");
const CONTEXT = "teacher:7:1";

test("M6-FIX-01～M6-FIX-05 两个 P0 页面缺陷回归", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "zhixue-m6-fix-"));
  const runtimeDbPath = join(dir, "runtime.sqlite");
  let server;
  let base;

  async function start() {
    server = createZhixueServer({ runtimeDbPath });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (server) await new Promise((done) => server.close(done));
    server = null;
  }
  async function login(role, rememberLogin = true) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account: role === "teacher" ? "teacher2026" : "student2026",
        password: "demo123",
        requestedRole: role,
        rememberLogin,
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    return {
      role,
      cookie: (response.headers.get("set-cookie") || "").split(";")[0],
      csrf: payload.data.csrfToken,
    };
  }
  async function call(auth, path, { method = "GET", body, csrf = auth?.csrf } = {}) {
    const headers = new Headers({ accept: "application/json" });
    if (auth?.cookie) headers.set("cookie", auth.cookie);
    if (body !== undefined) headers.set("content-type", "application/json");
    if (csrf && !["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("x-csrf-token", csrf);
    const response = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let payload = null;
    try { payload = JSON.parse(bytes.toString("utf8")); } catch {}
    return { response, status: response.status, body: payload, text: bytes.toString("utf8") };
  }
  const post = (auth, path, body, options = {}) => call(auth, path, { method: "POST", body, ...options });
  async function rotateCsrf(auth) {
    const restored = await call(auth, "/api/auth/me");
    assert.equal(restored.status, 200);
    return { ...auth, csrf: restored.body.data.csrfToken };
  }
  async function importAnalyze(auth) {
    const content = await readFile(join(FIXTURES, "dataset-a.csv"), "utf8");
    const imported = await post(auth, "/api/import/validate", { context: CONTEXT, fileName: "dataset-a.csv", content });
    assert.equal(imported.status, 200);
    const batchId = imported.body.data.batch.batchId;
    assert.equal((await post(auth, `/api/import/${batchId}/confirm`, { context: CONTEXT })).status, 200);
    const analyzed = await post(auth, "/api/analyze", { context: CONTEXT, batchId });
    assert.equal(analyzed.status, 200);
    return { batchId, analysisRunId: analyzed.body.analysisRunId, result: analyzed.body.data };
  }

  try {
    await start();
    let student = await login("student");

    await t.test("M6-FIX-01 当前课程本人导出", async () => {
      const oldCsrf = student.csrf;
      student = await rotateCsrf(student);
      assert.notEqual(student.csrf, oldCsrf);
      const stale = await post(student, "/api/export", {
        kind: "learning-record", format: "json", scope: { offeringId: 7 },
      }, { csrf: oldCsrf });
      assert.equal(stale.status, 403);
      assert.equal(stale.body.code, "AUTH_CSRF_INVALID");

      const exported = await post(student, "/api/export", {
        kind: "learning-record", format: "json", scope: { offeringId: 7 },
      });
      assert.equal(exported.status, 200);
      assert.equal(exported.body.student.studentRef, "S24***01");
      assert.equal(exported.body.courses.length, 1);
      assert.equal(exported.body.courses[0].courseCode, "AI201");
      const db = new DatabaseSync(runtimeDbPath);
      const audit = db.prepare("SELECT actor_role,actor_ref_code,result,source_refs_json FROM runtime_export_audits WHERE export_id=?")
        .get(exported.body.exportMeta.exportId);
      db.close();
      assert.equal(audit.actor_role, "student");
      assert.equal(audit.actor_ref_code, "S240101");
      assert.equal(audit.result, "generated");
      assert.deepEqual(JSON.parse(audit.source_refs_json).offeringIds, [7]);

      const client = await readFile(join(ROOT, "assets", "api-client.js"), "utf8");
      assert.match(client, /AUTH_CSRF_INVALID/);
      assert.match(client, /await me\(\);\s*return apiFetch\(path,/);
      assert.match(client, /__csrfRetry: true/);
    });

    await t.test("M6-FIX-02 全部授权课程导出", async () => {
      const exported = await post(student, "/api/export", {
        kind: "learning-record", format: "json", scope: {},
      });
      assert.equal(exported.status, 200);
      assert.equal(exported.body.student.studentRef, "S24***01");
      assert.doesNotMatch(exported.text, /S240102|S240103|teachingSuggestions|individualGuidance/);
      const baseDb = new DatabaseSync(BASELINE, { readOnly: true });
      const expected = baseDb.prepare("SELECT offering_id FROM enrollments WHERE student_id=1 AND status<>'退选' ORDER BY offering_id")
        .all().map((row) => row.offering_id);
      baseDb.close();
      const db = new DatabaseSync(runtimeDbPath);
      const audit = db.prepare("SELECT result,source_refs_json FROM runtime_export_audits WHERE export_id=?")
        .get(exported.body.exportMeta.exportId);
      db.close();
      assert.equal(audit.result, "generated");
      assert.deepEqual(JSON.parse(audit.source_refs_json).offeringIds.toSorted((a, b) => a - b), expected);
      assert.equal(exported.body.courses.length, expected.length);
    });

    await t.test("M6-FIX-03 越权保持拒绝", async () => {
      for (const scope of [
        { studentId: 2 },
        { studentContext: "student:S240102" },
        { context: "student:S240102" },
      ]) {
        const injected = await post(student, "/api/export", { kind: "learning-record", format: "json", scope });
        assert.equal(injected.status, 403);
        assert.equal(injected.body.code, "EXPORT_STUDENT_SCOPE_FORBIDDEN");
      }
      const baseDb = new DatabaseSync(BASELINE, { readOnly: true });
      const notEnrolled = baseDb.prepare(`SELECT id FROM course_offerings WHERE id NOT IN
        (SELECT offering_id FROM enrollments WHERE student_id=1 AND status<>'退选') ORDER BY id LIMIT 1`).get().id;
      baseDb.close();
      assert.equal((await post(student, "/api/export", {
        kind: "learning-record", format: "json", scope: { offeringId: notEnrolled },
      })).status, 403);
      for (const kind of ["report", "questions", "review"]) {
        const forbidden = await post(student, "/api/export", { kind, format: "json", scope: { context: CONTEXT } });
        assert.equal(forbidden.status, 403);
        assert.equal(forbidden.body.code, "EXPORT_KIND_FORBIDDEN");
      }
    });

    await t.test("M6-FIX-04 重启后恢复 analysis", async () => {
      const teacher = await login("teacher");
      const formal = await importAnalyze(teacher);
      const evidence = structuredClone(formal.result._evidence);
      const metrics = structuredClone(formal.result.overall_summary);
      const newer = await readFile(join(FIXTURES, "dataset-b.csv"), "utf8");
      const draft = await post(teacher, "/api/import/validate", {
        context: CONTEXT, fileName: "newer-unconfirmed.csv", content: newer,
      });
      assert.equal(draft.status, 200);
      assert.equal(draft.body.data.batch.status, "validated");
      const dbBefore = new DatabaseSync(runtimeDbPath);
      const countBefore = dbBefore.prepare("SELECT COUNT(*) count FROM runtime_analysis_runs").get().count;
      dbBefore.close();

      await stop();
      await start();
      const latest = await call(teacher, `/api/import/latest?context=${encodeURIComponent(CONTEXT)}`);
      assert.equal(latest.status, 200);
      assert.equal(latest.body.data.batch.batchId, draft.body.data.batch.batchId);
      assert.equal(latest.body.data.batch.status, "validated");
      assert.equal(latest.body.data.latestCompleted.batch.batchId, formal.batchId);
      assert.equal(latest.body.data.latestCompleted.batch.status, "confirmed");
      assert.equal(latest.body.data.latestCompleted.analysis.analysisRunId, formal.analysisRunId);
      assert.deepEqual(latest.body.data.latestCompleted.analysis.result.overall_summary, metrics);
      assert.deepEqual(latest.body.data.latestCompleted.analysis.result._evidence, evidence);
      const direct = await call(teacher, `/api/analysis/${formal.analysisRunId}?context=${encodeURIComponent(CONTEXT)}`);
      assert.equal(direct.status, 200);
      assert.equal(direct.body.data.status, "completed");
      const dbAfter = new DatabaseSync(runtimeDbPath);
      assert.equal(dbAfter.prepare("SELECT COUNT(*) count FROM runtime_analysis_runs").get().count, countBefore);
      dbAfter.close();
    });

    await t.test("M6-FIX-05 前端恢复契约", async () => {
      const app = await readFile(join(ROOT, "assets", "app.js"), "utf8");
      const restore = app.slice(app.indexOf("async function restoreM2"), app.indexOf("function beginM2Read"));
      assert.match(restore, /\/api\/import\/latest\?context=/);
      assert.match(restore, /data\?\.latestCompleted/);
      assert.match(restore, /analysisBatch/);
      assert.match(restore, /analysisRunId/);
      assert.doesNotMatch(restore, /localStorage|demo-data|\/api\/analyze/);
      const load = app.slice(app.indexOf("async function loadTeacherDashboard"), app.indexOf("function applyStudentCourse"));
      assert.ok(load.indexOf("analysis:null") < load.indexOf("await restoreM2(key,token)"));
      assert.match(app, /#courseSelect[^\n]+await loadTeacherDashboard\(\)/);
      assert.match(app, /#classSelect[^\n]+await loadTeacherDashboard\(\)/);
      assert.match(app, /const snapshot=data\?\.analysis\?\{batch:data\.batch,analysis:data\.analysis\}:data\?\.latestCompleted/);
    });
  } finally {
    await stop();
    const safe = resolve(dir);
    if (!safe.startsWith(`${resolve(tmpdir())}${sep}`) || !safe.includes("zhixue-m6-fix-")) {
      throw new Error("拒绝清理非测试目录");
    }
    await rm(safe, { recursive: true, force: true });
  }
});
