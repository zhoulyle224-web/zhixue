import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("教师端与学生端均加载本地 Skill", async () => {
  const teacher = await readFile(new URL("teacher.html", root), "utf8");
  const student = await readFile(new URL("student.html", root), "utf8");
  for (const page of [teacher, student]) {
    assert.match(page, /assets\/skills\/skill-registry\.js/);
    assert.match(page, /assets\/app\.js/);
  }
  assert.match(teacher, /academic-performance-analyzer\.js/);
  assert.match(student, /course-ai-tutor\.js/);
});

test("页面保留本地演示和导出入口", async () => {
  const html = (
    await Promise.all(
      ["index.html", "login.html", "teacher.html", "student.html"].map((name) =>
        readFile(new URL(name, root), "utf8"),
      ),
    )
  ).join("\n");
  assert.doesNotMatch(html, /比赛/);
  assert.match(html, /本次可用资料|课程资料依据/);
  assert.match(html, /导出/);
});

test("教师主路径显示班级概览并下钻独立学生详情，外部导入降级为高级说明", async () => {
  const teacher = await readFile(new URL("teacher.html", root), "utf8");
  const app = await readFile(new URL("assets/app.js", root), "utf8");
  for (const id of ["teacherStudentList", "studentDetail", "studentObservation", "personalPlanEditor", "refreshStudents", "analysisEvidence", "skillStatus"]) {
    assert.match(teacher, new RegExp(`id="${id}"`));
  }
  assert.match(app, /api\/teacher\/classes\/\$\{currentClass\(\)\.classId\}\/students/);
  assert.match(app, /api\/teacher\/students\/\$\{encodeURIComponent\(studentNo\)\}\/observation/);
  assert.doesNotMatch(teacher, /id="dataFile"|id="loadSample"|id="qualityTable"/);
  assert.match(teacher, /高级数据管理（管理员补录）/);
});

test("教师 M2 证据区显示固定研判 ID，新导入时清除旧 ID", async () => {
  const app = await readFile(new URL("assets/app.js", root), "utf8");
  assert.match(app, /研判 \$\{m2State\.analysisRunId/);
  assert.match(app, /function beginM2Read\(\).*m2State\.analysisRunId=null/);
  assert.match(app, /m2State\.analysisRunId=m2State\.analysis\?run\.analysisRunId:null/);
  assert.doesNotMatch(app, /m2State\.batch\.status='analyzed'/);
});

test("AI 接口支持多服务商、模型名称和独立密钥且学生端无配置入口", async () => {
  const [teacher, student, client, css] = await Promise.all([
    readFile(new URL("teacher.html", root), "utf8"),
    readFile(new URL("student.html", root), "utf8"),
    readFile(new URL("assets/ai-config.js", root), "utf8"),
    readFile(new URL("assets/ai-config.css", root), "utf8"),
  ]);
  for (const id of ["aiProviderGrid", "aiModelName", "aiApiKey", "toggleAiKey", "saveAiKey"]) {
    assert.match(teacher, new RegExp(`id="${id}"`));
  }
  assert.match(teacher, /assets\/ai-config\.css/);
  assert.match(client, /providerId: provider\.id, model, apiKey/);
  assert.match(client, /state\.persistence === 'sandbox'/);
  assert.doesNotMatch(client, /localStorage|sessionStorage|indexedDB/i);
  assert.match(css, /\.ai-provider-grid/);
  assert.doesNotMatch(student, /id="aiInterfaceMenu"|id="aiProviderGrid"/);
});
