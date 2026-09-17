import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { createZhixueServer } from "../server/local-api.mjs";

const CONTEXT = "teacher:7:1";
const WRONG_CONTEXT = "teacher:1:1";
const STUDENT_CONTEXT = "student:S240101";
const FIXTURE_ROOT = resolve(import.meta.dirname, "fixtures");
const ROOT = resolve(import.meta.dirname, "..");

test("M6-E2E-01～M6-E2E-10 跨模块主链路与异常闭环", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "zhixue-m6-e2e-"));
  const runtimeDbPath = join(dir, "runtime.sqlite");
  let server;
  let base;
  async function start(options = {}) {
    server = createZhixueServer({ runtimeDbPath, ...options });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (server) await new Promise((done) => server.close(done));
    server = null;
  }
  async function login(role) {
    const response = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account: role === "teacher" ? "teacher2026" : "student2026",
        password: "demo123",
        requestedRole: role,
        rememberLogin: true,
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    return {
      role,
      cookie: (response.headers.get("set-cookie") || "").split(";")[0],
      csrf: body.data.csrfToken,
    };
  }
  async function call(auth, path, { method = "GET", body, csrf = true } = {}) {
    const headers = new Headers();
    if (auth?.cookie) headers.set("cookie", auth.cookie);
    if (body !== undefined) headers.set("content-type", "application/json");
    if (csrf && auth?.csrf && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      headers.set("x-csrf-token", auth.csrf);
    }
    const response = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let payload = null;
    try { payload = JSON.parse(bytes.toString("utf8")); } catch {}
    return { response, status: response.status, body: payload, bytes, text: bytes.toString("utf8") };
  }
  const post = (auth, path, body, options = {}) => call(auth, path, { method: "POST", body, ...options });
  const put = (auth, path, body, options = {}) => call(auth, path, { method: "PUT", body, ...options });
  async function importAnalyze(auth, filePath, fileName) {
    const content = await readFile(filePath, "utf8");
    const imported = await post(auth, "/api/import/validate", { context: CONTEXT, fileName, content });
    assert.equal(imported.status, 200);
    const batchId = imported.body.data.batch.batchId;
    assert.equal((await post(auth, `/api/import/${batchId}/confirm`, { context: CONTEXT })).status, 200);
    const analyzed = await post(auth, "/api/analyze", { context: CONTEXT, batchId });
    assert.equal(analyzed.status, 200);
    return { batchId, analysisRunId: analyzed.body.analysisRunId, result: analyzed.body.data };
  }

  let teacher;
  let student;
  let questionId;
  let analysisRunId;
  let versionId;
  let assignmentId;
  let completedAt;
  let feedback;
  try {
    await start();
    teacher = await login("teacher");
    student = await login("student");

    await t.test("M6-E2E-01 两批真实导入产生不同固定研判", async () => {
      const a = await importAnalyze(teacher, join(FIXTURE_ROOT, "m2", "dataset-a.csv"), "dataset-a.csv");
      const b = await importAnalyze(teacher, join(FIXTURE_ROOT, "m2", "dataset-b.csv"), "dataset-b.csv");
      assert.equal(a.result.overall_summary.average_score, 68);
      assert.equal(b.result.overall_summary.average_score, 92.5);
      assert.notDeepEqual(a.result.student_stratification, b.result.student_stratification);
      assert.notEqual(a.analysisRunId, b.analysisRunId);
    });

    await t.test("M6-E2E-02 跨课程问题进入对应教师待办", async () => {
      const asked = await post(student, "/api/qa", {
        studentContext: STUDENT_CONTEXT,
        offeringId: 7,
        question: "栈和队列的区别是什么？",
        clientRequestId: randomUUID(),
      });
      assert.equal(asked.status, 200);
      assert.equal(asked.body.data.status, "pending_teacher");
      questionId = asked.body.data.questionId;
      const inbox = await call(teacher, `/api/qa/teacher-inbox?context=${encodeURIComponent(CONTEXT)}`);
      assert.equal(inbox.status, 200);
      assert.equal(inbox.body.data.some((item) => item.questionId === questionId), true);
    });

    await t.test("M6-E2E-03 教师回复回到同一学生历史", async () => {
      const replied = await post(teacher, `/api/qa/${questionId}/reply`, {
        context: CONTEXT,
        reply: "请切换到数据结构课程，结合教材中的栈与队列章节学习。",
      });
      assert.equal(replied.status, 200);
      const history = await call(student, `/api/qa/history?studentContext=${encodeURIComponent(STUDENT_CONTEXT)}&offeringId=7`);
      const record = history.body.data.find((item) => item.questionId === questionId);
      assert.equal(record.status, "teacher_replied");
      assert.match(record.teacherReply, /数据结构课程/);
    });

    await t.test("M6-E2E-04 研判发布任务、学生完成、教师反馈闭环", async () => {
      const run = await importAnalyze(teacher, join(FIXTURE_ROOT, "m3", "publishable-ai201.csv"), "publishable-ai201.csv");
      analysisRunId = run.analysisRunId;
      assert.deepEqual({
        extension: run.result.student_stratification.excellent_students.length,
        improvement: run.result.student_stratification.potential_students.length,
        consolidation: run.result.student_stratification.struggling_students.length,
      }, { extension: 3, improvement: 5, consolidation: 2 });
      const created = await post(teacher, "/api/tasks/drafts", { context: CONTEXT, analysisRunId });
      assert.equal(created.status, 200);
      versionId = created.body.data.versionId;
      const tasks = structuredClone(created.body.data.tasks);
      tasks.consolidation.detail = "完成智能体与搜索基础练习 3 题并提交疑问。";
      assert.equal((await put(teacher, `/api/tasks/drafts/${versionId}`, {
        context: CONTEXT,
        dueAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        tasks,
      })).status, 200);
      const published = await post(teacher, `/api/tasks/drafts/${versionId}/publish`, {
        context: CONTEXT,
        clientRequestId: randomUUID(),
      });
      assert.equal(published.status, 200);
      assert.equal(published.body.data.assignedCount, 10);
      const active = await call(student, `/api/tasks/student?studentContext=${encodeURIComponent(STUDENT_CONTEXT)}&offeringId=7`);
      const task = active.body.data.activeAssignments[0];
      assignmentId = task.assignmentId;
      assert.equal(task.tierCode, "consolidation");
      const completed = await post(student, `/api/tasks/assignments/${assignmentId}/complete`, {
        studentContext: STUDENT_CONTEXT,
        feedback: "已经完成练习，但仍需巩固启发式搜索。",
        clientRequestId: randomUUID(),
      });
      assert.equal(completed.status, 200);
      const summary = await call(teacher, `/api/tasks/versions/${versionId}/feedback?context=${encodeURIComponent(CONTEXT)}`);
      assert.equal(summary.body.data.completedCount, 1);
      assert.deepEqual(summary.body.data.byTier.consolidation, { assigned: 2, completed: 1 });
      const beforeRevoke = await call(student, `/api/tasks/student/history?studentContext=${encodeURIComponent(STUDENT_CONTEXT)}&offeringId=7`);
      const row = beforeRevoke.body.data.history.find((item) => item.assignmentId === assignmentId);
      completedAt = row.completedAt;
      feedback = row.feedback;
    });

    await t.test("M6-E2E-05 撤回仅移出 active，历史完成信息保持", async () => {
      const revoked = await post(teacher, `/api/tasks/versions/${versionId}/revoke`, {
        context: CONTEXT,
        reason: "跨模块验收撤回",
      });
      assert.equal(revoked.status, 200);
      const active = await call(student, `/api/tasks/student?studentContext=${encodeURIComponent(STUDENT_CONTEXT)}&offeringId=7`);
      assert.equal(active.body.data.activeAssignments.some((item) => item.assignmentId === assignmentId), false);
      const history = await call(student, `/api/tasks/student/history?studentContext=${encodeURIComponent(STUDENT_CONTEXT)}&offeringId=7`);
      const row = history.body.data.history.find((item) => item.assignmentId === assignmentId);
      assert.equal(row.versionStatus, "revoked");
      assert.equal(row.completedAt, completedAt);
      assert.equal(row.feedback, feedback);
    });

    await t.test("M6-E2E-06 学生访问教师端 M1/M2/M3/M5 写能力全部 403", async () => {
      const attempts = [
        call(student, `/api/dashboard?audience=teacher&context=${encodeURIComponent(CONTEXT)}`),
        post(student, "/api/import/validate", { context: CONTEXT, fileName: "x.csv", content: "匿名编号,知识点,得分\nS240101,K,80" }),
        post(student, "/api/tasks/drafts", { context: CONTEXT, analysisRunId }),
        post(student, "/api/tasks/drafts/fake/publish", { context: CONTEXT, clientRequestId: randomUUID() }),
        post(student, "/api/export", { kind: "report", format: "json", scope: { context: CONTEXT } }),
      ];
      for (const result of await Promise.all(attempts)) assert.equal(result.status, 403);
    });

    await t.test("M6-E2E-07 教师跨班 context 在 M1/M2/M3/M5 均被拒绝", async () => {
      const attempts = [
        call(teacher, `/api/dashboard?audience=teacher&context=${encodeURIComponent(WRONG_CONTEXT)}`),
        post(teacher, "/api/import/validate", { context: WRONG_CONTEXT, fileName: "x.csv", content: "匿名编号,知识点,得分\nS240101,K,80" }),
        call(teacher, `/api/tasks/teacher?context=${encodeURIComponent(WRONG_CONTEXT)}`),
        post(teacher, "/api/export", { kind: "report", format: "json", scope: { context: WRONG_CONTEXT } }),
      ];
      for (const result of await Promise.all(attempts)) assert.equal(result.status, 403);
    });

    await t.test("M6-E2E-08 strict audit 故障不返回文件且无静态回退", async () => {
      await stop();
      await start({ exportOptions: { auditWriter: () => { throw new Error("audit unavailable"); } } });
      const isolatedTeacher = await login("teacher");
      const exported = await post(isolatedTeacher, "/api/export", {
        kind: "questions",
        format: "json",
        scope: { context: CONTEXT },
      });
      assert.equal(exported.status, 503);
      assert.equal(exported.body.code, "EXPORT_AUDIT_UNAVAILABLE");
      assert.equal(exported.response.headers.has("content-disposition"), false);
      const exportClient = await readFile(join(ROOT, "assets", "export-client.js"), "utf8");
      assert.match(exportClient, /本次未生成文件|正式数据未下载/);
      assert.doesNotMatch(exportClient, /public-export-demo[^\n]+\.click/);
      const files = await readdir(dir, { recursive: true });
      assert.equal(files.some((name) => /^zhixue-(?:report|questions|review|learning-record)-/i.test(name)), false);
      await stop();
      await start();
    });

    await t.test("M6-E2E-09 runtime/基线/审计均不公开且静态页无 Session", async () => {
      for (const path of [
        "/data/zhixue_demo.sqlite",
        "/data/runtime/zhixue_runtime.sqlite",
        "/data/runtime/audit.jsonl",
      ]) assert.equal((await call(null, path)).status, 404);
      for (const path of ["/index.html", "/login.html", "/assets/demo-data.json"]) {
        const result = await call(null, path);
        assert.equal(result.status, 200);
        assert.equal(result.response.headers.has("set-cookie"), false);
        assert.doesNotMatch(result.text, /zhixue_session\s*=|csrf_token_hash/i);
      }
    });

    await t.test("M6-E2E-10 同一 runtime DB 重启后 QA、研判、任务完成均可读", async () => {
      await stop();
      await start();
      const qa = await call(student, `/api/qa/history?studentContext=${encodeURIComponent(STUDENT_CONTEXT)}&offeringId=7`);
      assert.equal(qa.status, 200);
      assert.equal(qa.body.data.find((item) => item.questionId === questionId).status, "teacher_replied");
      const analysis = await call(teacher, `/api/analysis/${analysisRunId}?context=${encodeURIComponent(CONTEXT)}`);
      assert.equal(analysis.status, 200);
      assert.equal(analysis.body.data.analysisRunId, analysisRunId);
      const history = await call(student, `/api/tasks/student/history?studentContext=${encodeURIComponent(STUDENT_CONTEXT)}&offeringId=7`);
      const row = history.body.data.history.find((item) => item.assignmentId === assignmentId);
      assert.equal(row.versionStatus, "revoked");
      assert.equal(row.completionStatus, "completed");
      assert.equal(row.completedAt, completedAt);
      assert.equal(row.feedback, feedback);
    });
  } finally {
    await stop();
    const safe = resolve(dir);
    if (!safe.startsWith(`${resolve(tmpdir())}${sep}`) || !safe.includes("zhixue-m6-e2e-")) {
      throw new Error("拒绝清理非 M6 测试临时目录");
    }
    await rm(safe, { recursive: true, force: true });
  }
});
