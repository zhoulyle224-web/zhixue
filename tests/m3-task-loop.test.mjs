import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createZhixueServer } from "../server/local-api.mjs";

const CONTEXT = "teacher:7:1";
const STUDENT = "student:S240101";
const FIXTURE = new URL("./fixtures/m3/publishable-ai201.csv", import.meta.url);
const M2_FIXTURE = new URL("./fixtures/m2/dataset-a.csv", import.meta.url);
const BASELINE = new URL("../data/zhixue_demo.sqlite", import.meta.url);

async function withServer(dbPath, work) {
  const server = createZhixueServer({ runtimeDbPath: dbPath });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try { return await work(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((done) => server.close(done)); }
}
async function request(base, path, method = "GET", body) {
  const response = await fetch(base + path, {
    method, headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload;
  try { payload = await response.json(); } catch { payload = null; }
  return { status: response.status, body: payload };
}
const post = (base, path, body) => request(base, path, "POST", body);
const put = (base, path, body) => request(base, path, "PUT", body);
const get = (base, path) => request(base, path);

async function analysis(base, fixture = FIXTURE, context = CONTEXT) {
  const content = await readFile(fixture, "utf8");
  const imported = await post(base, "/api/import/validate", {
    context, fileName: fixture === FIXTURE ? "publishable-ai201.csv" : "dataset-a.csv", content,
  });
  assert.equal(imported.status, 200);
  const batchId = imported.body.data.batch.batchId;
  assert.equal((await post(base, `/api/import/${batchId}/confirm`, { context })).status, 200);
  const analyzed = await post(base, "/api/analyze", { context, batchId });
  assert.equal(analyzed.status, 200);
  return { batchId, analysisRunId: analyzed.body.analysisRunId, result: analyzed.body.data };
}

async function draft(base, analysisRunId, context = CONTEXT) {
  return post(base, "/api/tasks/drafts", { context, analysisRunId });
}

function due(days = 7) { return new Date(Date.now() + days * 86400000).toISOString(); }

async function saveAndPublish(base, created, suffix = "one") {
  const data = created.body.data;
  const tasks = structuredClone(data.tasks);
  tasks.consolidation.detail = "完成 A* 搜索基础练习 3 题，并提交一句“我仍不理解的问题”。";
  const saved = await put(base, `/api/tasks/drafts/${data.versionId}`, {
    context: CONTEXT, dueAt: due(), tasks,
  });
  assert.equal(saved.status, 200);
  const published = await post(base, `/api/tasks/drafts/${data.versionId}/publish`, {
    context: CONTEXT, clientRequestId: `publish-${suffix}`,
  });
  assert.equal(published.status, 200);
  return { created, saved, published };
}

test("M3-T01 无研判不能建草案", async () => {
  await withServer(":memory:", async (base) => {
    const response = await draft(base, "");
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "TASK_ANALYSIS_REQUIRED");
  });
});

test("M3-T02/T03 动态草案为 3/5/2 且 analysis context 受限", async () => {
  await withServer(":memory:", async (base) => {
    const run = await analysis(base);
    assert.equal(run.result.overall_summary.average_score, 71.5);
    assert.equal(run.result.overall_summary.pass_rate, "80%");
    const created = await draft(base, run.analysisRunId);
    assert.equal(created.status, 200);
    assert.deepEqual(created.body.data.tiers, { extension: 3, improvement: 5, consolidation: 2 });
    assert.equal(created.body.data.source.weakestKnowledgePoint, "智能体与搜索");
    assert.match(created.body.data.tasks.extension.title, /智能体与搜索/);
    assert.equal(created.body.data.coverage.analysisStudents, 10);
    assert.equal(created.body.data.coverage.classStudents, 30);
    const mismatch = await draft(base, run.analysisRunId, "teacher:1:1");
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.body.code, "TASK_ANALYSIS_CONTEXT_MISMATCH");
  });
});

test("M3-T04 无法映射的分析标识阻断发布", async () => {
  await withServer(":memory:", async (base) => {
    const run = await analysis(base, M2_FIXTURE);
    const created = await draft(base, run.analysisRunId);
    assert.equal(created.status, 200);
    assert.equal(created.body.data.coverage.mappableStudents, 0);
    const saved = await put(base, `/api/tasks/drafts/${created.body.data.versionId}`, {
      context: CONTEXT, dueAt: due(), tasks: created.body.data.tasks,
    });
    assert.equal(saved.status, 200);
    const published = await post(base, `/api/tasks/drafts/${created.body.data.versionId}/publish`, {
      context: CONTEXT, clientRequestId: "publish-unmapped",
    });
    assert.equal(published.status, 409);
    assert.equal(published.body.code, "TASK_ASSIGNMENT_MAPPING_INCOMPLETE");
  });
});

test("M3-T05～T15 发布、归属、幂等、不可变与 v2 supersede 全链路", async () => {
  await withServer(":memory:", async (base) => {
    const run = await analysis(base);
    const firstDraft = await draft(base, run.analysisRunId);
    const { saved, published } = await saveAndPublish(base, firstDraft);
    assert.equal(published.body.data.assignedCount, 10);
    assert.equal(published.body.data.versionNo, 1);
    assert.equal(published.body.data.status, "published");

    const again = await post(base, `/api/tasks/drafts/${firstDraft.body.data.versionId}/publish`, {
      context: CONTEXT, clientRequestId: "publish-one",
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.assignedCount, 10);

    const student = await get(base, `/api/tasks/student?studentContext=${encodeURIComponent(STUDENT)}&offeringId=7`);
    assert.equal(student.status, 200);
    assert.equal(student.body.data.activeAssignments.length, 1);
    assert.equal(student.body.data.activeAssignments[0].tierCode, "consolidation");
    assert.equal(student.body.data.activeAssignments[0].detail, saved.body.data.tasks.consolidation.detail);
    assert.equal(JSON.stringify(student.body.data).includes("S240102"), false);

    const forbidden = await get(base, `/api/tasks/student?studentContext=${encodeURIComponent(STUDENT)}&offeringId=1`);
    assert.equal(forbidden.status, 200);
    assert.equal(forbidden.body.data.activeAssignments.length, 0);

    const immutable = await put(base, `/api/tasks/drafts/${firstDraft.body.data.versionId}`, {
      context: CONTEXT, dueAt: due(), tasks: saved.body.data.tasks,
    });
    assert.equal(immutable.status, 409);
    assert.equal(immutable.body.code, "TASK_VERSION_IMMUTABLE");

    const revised = await post(base, `/api/tasks/versions/${firstDraft.body.data.versionId}/revise`, { context: CONTEXT });
    assert.equal(revised.status, 200);
    assert.equal(revised.body.data.versionNo, 2);
    assert.equal(revised.body.data.status, "draft");
    revised.body.data.tasks.extension.detail = "v2 拓展练习";
    assert.notEqual(firstDraft.body.data.tasks.extension.detail, revised.body.data.tasks.extension.detail);
    const v2saved = await put(base, `/api/tasks/drafts/${revised.body.data.versionId}`, {
      context: CONTEXT, dueAt: due(8), tasks: revised.body.data.tasks,
    });
    assert.equal(v2saved.status, 200);
    const v2 = await post(base, `/api/tasks/drafts/${revised.body.data.versionId}/publish`, {
      context: CONTEXT, clientRequestId: "publish-two",
    });
    assert.equal(v2.status, 200);
    const teacher = await get(base, `/api/tasks/teacher?context=${encodeURIComponent(CONTEXT)}`);
    const versions = teacher.body.data[0].versions;
    assert.equal(versions.find((item) => item.versionNo === 1).status, "superseded");
    assert.equal(versions.find((item) => item.versionNo === 2).status, "published");
    const active = await get(base, `/api/tasks/student?studentContext=${encodeURIComponent(STUDENT)}&offeringId=7`);
    assert.equal(active.body.data.activeAssignments.length, 1);
    assert.equal(active.body.data.activeAssignments[0].versionNo, 2);
  });
});

test("M3-V01 正常版本替代：仅 published 的 v1 转为 superseded", async () => {
  await withServer(":memory:", async (base) => {
    const run = await analysis(base);
    const v1Draft = await draft(base, run.analysisRunId);
    await saveAndPublish(base, v1Draft, "v01-v1");

    const v2Draft = await post(base, "/api/tasks/versions/" + v1Draft.body.data.versionId + "/revise", {
      context: CONTEXT,
    });
    assert.equal(v2Draft.status, 200);
    const v2Saved = await put(base, "/api/tasks/drafts/" + v2Draft.body.data.versionId, {
      context: CONTEXT, dueAt: due(8), tasks: v2Draft.body.data.tasks,
    });
    assert.equal(v2Saved.status, 200);
    const v2Published = await post(base, "/api/tasks/drafts/" + v2Draft.body.data.versionId + "/publish", {
      context: CONTEXT, clientRequestId: "publish-v01-v2",
    });
    assert.equal(v2Published.status, 200);

    const teacher = await get(base, "/api/tasks/teacher?context=" + encodeURIComponent(CONTEXT));
    const versions = teacher.body.data[0].versions;
    assert.equal(versions.find((item) => item.versionNo === 1).status, "superseded");
    assert.equal(versions.find((item) => item.versionNo === 2).status, "published");
  });
});

test("M3-V02 撤回版本保持终态：发布 v2 不得把 revoked v1 改为 superseded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zhixue-m3-v02-"));
  const dbPath = join(dir, "runtime.sqlite");
  let v1VersionId;
  let v1AssignmentId;
  let v2VersionId;
  try {
    await withServer(dbPath, async (base) => {
      const run = await analysis(base);
      const v1Draft = await draft(base, run.analysisRunId);
      await saveAndPublish(base, v1Draft, "v02-v1");
      v1VersionId = v1Draft.body.data.versionId;

      const v1Active = await get(base,
        "/api/tasks/student?studentContext=" + encodeURIComponent(STUDENT) + "&offeringId=7");
      const v1Task = v1Active.body.data.activeAssignments[0];
      v1AssignmentId = v1Task.assignmentId;
      const completed = await post(base, "/api/tasks/assignments/" + v1AssignmentId + "/complete", {
        studentContext: STUDENT,
        feedback: "v1 完成反馈保留",
        clientRequestId: "complete-v02-v1",
      });
      assert.equal(completed.status, 200);

      const revoked = await post(base, "/api/tasks/versions/" + v1VersionId + "/revoke", {
        context: CONTEXT, reason: "教师主动撤回 v1",
      });
      assert.equal(revoked.status, 200);
      assert.equal(revoked.body.data.status, "revoked");

      const v2Draft = await post(base, "/api/tasks/versions/" + v1VersionId + "/revise", {
        context: CONTEXT,
      });
      assert.equal(v2Draft.status, 200);
      v2VersionId = v2Draft.body.data.versionId;
      const v2Saved = await put(base, "/api/tasks/drafts/" + v2VersionId, {
        context: CONTEXT, dueAt: due(8), tasks: v2Draft.body.data.tasks,
      });
      assert.equal(v2Saved.status, 200);
      const v2Published = await post(base, "/api/tasks/drafts/" + v2VersionId + "/publish", {
        context: CONTEXT, clientRequestId: "publish-v02-v2",
      });
      assert.equal(v2Published.status, 200);

      const teacher = await get(base, "/api/tasks/teacher?context=" + encodeURIComponent(CONTEXT));
      const versions = teacher.body.data[0].versions;
      assert.equal(versions.find((item) => item.versionNo === 1).status, "revoked");
      assert.equal(versions.find((item) => item.versionNo === 2).status, "published");

      const active = await get(base,
        "/api/tasks/student?studentContext=" + encodeURIComponent(STUDENT) + "&offeringId=7");
      assert.equal(active.body.data.activeAssignments.length, 1);
      assert.equal(active.body.data.activeAssignments[0].versionId, v2VersionId);
      assert.equal(active.body.data.activeAssignments[0].versionNo, 2);

      const history = await get(base,
        "/api/tasks/student/history?studentContext=" + encodeURIComponent(STUDENT) + "&offeringId=7");
      const v1History = history.body.data.history.find((item) => item.versionId === v1VersionId);
      assert.equal(v1History.versionStatus, "revoked");
      assert.equal(v1History.completionStatus, "completed");
      assert.equal(v1History.feedback, "v1 完成反馈保留");
    });

    const runtime = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(runtime.prepare("SELECT status FROM runtime_task_versions WHERE id=?").get(v1VersionId).status, "revoked");
      assert.equal(runtime.prepare("SELECT status FROM runtime_task_versions WHERE id=?").get(v2VersionId).status, "published");
      const assignment = runtime.prepare("SELECT completion_status,feedback_text FROM runtime_task_assignments WHERE id=?")
        .get(v1AssignmentId);
      assert.equal(assignment.completion_status, "completed");
      assert.equal(assignment.feedback_text, "v1 完成反馈保留");
      assert.equal(runtime.prepare("SELECT COUNT(*) AS n FROM runtime_task_assignments WHERE task_version_id=?")
        .get(v1VersionId).n, 10);
      assert.equal(runtime.prepare("SELECT COUNT(*) AS n FROM runtime_task_events WHERE task_version_id=? AND event_type='revoked'")
        .get(v1VersionId).n, 1);
      assert.equal(runtime.prepare("SELECT COUNT(*) AS n FROM runtime_task_events WHERE task_version_id=? AND event_type='superseded'")
        .get(v1VersionId).n, 0);
    } finally { runtime.close(); }
  } finally {
    const safe = resolve(dir);
    if (!safe.startsWith(resolve(tmpdir()) + sep) || !safe.includes("zhixue-m3-v02-")) {
      throw new Error("拒绝清理非测试临时目录");
    }
    await rm(safe, { recursive: true, force: true });
  }
});

test("M3-T09～T18 完成反馈幂等、教师摘要、撤回与历史保留", async () => {
  await withServer(":memory:", async (base) => {
    const run = await analysis(base);
    const created = await draft(base, run.analysisRunId);
    await saveAndPublish(base, created, "complete");
    const task = (await get(base, `/api/tasks/student?studentContext=${encodeURIComponent(STUDENT)}&offeringId=7`))
      .body.data.activeAssignments[0];
    const feedbackText = "联系我 13812345678，我还不懂 A*";
    const complete = await post(base, `/api/tasks/assignments/${task.assignmentId}/complete`, {
      studentContext: STUDENT, feedback: feedbackText, clientRequestId: "complete-one",
    });
    assert.equal(complete.status, 200, JSON.stringify(complete.body));
    assert.equal(complete.body.data.completionStatus, "completed");
    assert.doesNotMatch(complete.body.data.feedback, /13812345678/);
    const duplicate = await post(base, `/api/tasks/assignments/${task.assignmentId}/complete`, {
      studentContext: STUDENT, feedback: feedbackText, clientRequestId: "complete-one",
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.data.idempotent, true);
    const summary = await get(base, `/api/tasks/versions/${task.versionId}/feedback?context=${encodeURIComponent(CONTEXT)}`);
    assert.equal(summary.body.data.completedCount, 1);
    assert.deepEqual(summary.body.data.byTier.consolidation, { assigned: 2, completed: 1 });
    assert.equal(summary.body.data.recentFeedback[0].studentRef, "S24***01");
    const revoked = await post(base, `/api/tasks/versions/${task.versionId}/revoke`, {
      context: CONTEXT, reason: "任务内容需调整",
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.data.status, "revoked");
    const active = await get(base, `/api/tasks/student?studentContext=${encodeURIComponent(STUDENT)}&offeringId=7`);
    assert.equal(active.body.data.activeAssignments.length, 0);
    const history = await get(base, `/api/tasks/student/history?studentContext=${encodeURIComponent(STUDENT)}&offeringId=7`);
    assert.equal(history.body.data.history[0].versionStatus, "revoked");
    assert.equal(history.body.data.history[0].completionStatus, "completed");
    assert.equal(history.body.data.history[0].feedback, "联系我 手机号已脱敏，我还不懂 A*");
    const after = await post(base, `/api/tasks/assignments/${task.assignmentId}/complete`, {
      studentContext: STUDENT, feedback: "", clientRequestId: "complete-after-revoke",
    });
    assert.equal(after.status, 409);
    assert.equal(after.body.code, "TASK_VERSION_REVOKED");
  });
});

test("M3-T19/T20/T21 重启恢复、基线只读且 runtime DB 不可静态访问", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zhixue-m3-"));
  const dbPath = join(dir, "runtime.sqlite");
  const before = createHash("sha256").update(await readFile(BASELINE)).digest("hex");
  let versionId;
  try {
    await withServer(dbPath, async (base) => {
      const run = await analysis(base);
      const created = await draft(base, run.analysisRunId);
      await saveAndPublish(base, created, "restart");
      const task = (await get(base, `/api/tasks/student?studentContext=${encodeURIComponent(STUDENT)}&offeringId=7`))
        .body.data.activeAssignments[0];
      versionId = task.versionId;
      const completed = await post(base, `/api/tasks/assignments/${task.assignmentId}/complete`, {
        studentContext: STUDENT, feedback: "已完成", clientRequestId: "restart-complete",
      });
      assert.equal(completed.status, 200, JSON.stringify(completed.body));
    });
    await withServer(dbPath, async (base) => {
      const history = await get(base, `/api/tasks/student/history?studentContext=${encodeURIComponent(STUDENT)}&offeringId=7`);
      assert.equal(history.body.data.history[0].completionStatus, "completed");
      const summary = await get(base, `/api/tasks/versions/${versionId}/feedback?context=${encodeURIComponent(CONTEXT)}`);
      assert.equal(summary.body.data.completedCount, 1);
      assert.equal((await fetch(base + "/data/runtime/zhixue_runtime.sqlite")).status, 404);
    });
    const runtime = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(runtime.prepare("SELECT COUNT(*) AS n FROM runtime_task_assignments").get().n, 10);
      assert.equal(runtime.prepare("SELECT COUNT(*) AS n FROM runtime_task_events WHERE event_type='assignment_completed'").get().n, 1);
    } finally { runtime.close(); }
    const after = createHash("sha256").update(await readFile(BASELINE)).digest("hex");
    assert.equal(after, before);
  } finally {
    const safe = resolve(dir);
    if (!safe.startsWith(`${resolve(tmpdir())}${sep}`) || !safe.includes("zhixue-m3-")) throw new Error("拒绝清理非测试临时目录");
    await rm(safe, { recursive: true, force: true });
  }
});

test("M3-T22/T23/T24/T25 截止时间、PII、纯文本与后续研判反馈边界", async () => {
  await withServer(":memory:", async (base) => {
    const run = await analysis(base);
    const created = await draft(base, run.analysisRunId);
    const tasks = structuredClone(created.body.data.tasks);
    tasks.extension.detail = "<script>alert(1)</script> 仅作为纯文本";
    const invalid = await put(base, `/api/tasks/drafts/${created.body.data.versionId}`, {
      context: CONTEXT, dueAt: "2020-01-01", tasks,
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, "TASK_DUE_DATE_INVALID");
    const saved = await put(base, `/api/tasks/drafts/${created.body.data.versionId}`, {
      context: CONTEXT, dueAt: due(), tasks,
    });
    assert.equal(saved.body.data.tasks.extension.detail, "<script>alert(1)</script> 仅作为纯文本");
    await post(base, `/api/tasks/drafts/${created.body.data.versionId}/publish`, {
      context: CONTEXT, clientRequestId: "publish-security",
    });
    const task = (await get(base, `/api/tasks/student?studentContext=${encodeURIComponent("student:S240106")}&offeringId=7`))
      .body.data.activeAssignments[0];
    assert.equal(task.detail, "<script>alert(1)</script> 仅作为纯文本");
    await post(base, `/api/tasks/assignments/${task.assignmentId}/complete`, {
      studentContext: "student:S240106", feedback: "手机 13812345678", clientRequestId: "security-complete",
    });
    const summary = await get(base, `/api/tasks/feedback-summary?context=${encodeURIComponent(CONTEXT)}`);
    assert.equal(summary.status, 200);
    assert.equal(summary.body.data.completedCount, 1);
    assert.match(summary.body.data.note, /不参与本次分数计算/);
    const fixedAnalysis = await get(base, `/api/analysis/${run.analysisRunId}?context=${encodeURIComponent(CONTEXT)}`);
    assert.equal(fixedAnalysis.body.data.result.overall_summary.average_score, 71.5);
  });
});

test("M3-T26/T27/T28 前端 API 失败不假发布/完成且移除固定巩固组过滤", async () => {
  const [app, client, teacherPage, studentPage] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/task-client.js", import.meta.url), "utf8"),
    readFile(new URL("../teacher.html", import.meta.url), "utf8"),
    readFile(new URL("../student.html", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(app, /t\.tier==='巩固组'/);
  assert.doesNotMatch(app, /togglePersonalTask/);
  assert.doesNotMatch(app, /分层任务已发布到学生端/);
  assert.doesNotMatch(app, /结果已加入学习反馈/);
  assert.match(client, /当前页面不会使用 localStorage 假装完成或反馈成功/);
  assert.match(client, /发布失败/);
  assert.match(client, /提交失败/);
  assert.match(client, /completionStatus/);
  assert.match(teacherPage, /assets\/task-client\.js/);
  assert.match(studentPage, /assets\/task-client\.js/);
});
