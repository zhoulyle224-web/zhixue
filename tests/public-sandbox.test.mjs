import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createZhixueServer } from "../server/local-api.mjs";

const SANDBOX_A = `sbx_${"a".repeat(32)}`;
const SANDBOX_B = `sbx_${"b".repeat(32)}`;

async function listen(root) {
  const server = createZhixueServer({ sandboxRoot: root, trustProxy: true, secureCookie: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function login(base, role, sandboxId) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      account: role === "teacher" ? "teacher2026" : "student2026",
      password: "demo123",
      requestedRole: role,
      rememberLogin: true,
      sandboxId,
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.sandbox.id, sandboxId);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, new RegExp(`^zhixue_session=${sandboxId}\\.`));
  return { cookie, csrf: payload.data.csrfToken };
}

async function api(base, auth, path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("cookie", auth.cookie);
  if (options.method && options.method !== "GET") {
    headers.set("x-csrf-token", auth.csrf);
    headers.set("origin", `https://${new URL(base).host}`);
    headers.set("x-forwarded-proto", "https");
  }
  const response = await fetch(`${base}${path}`, { ...options, headers });
  return { response, payload: await response.json() };
}

test("公网演示沙箱按访客隔离，并在服务重启后保留", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhixue-sandboxes-"));
  let running;
  try {
    running = await listen(root);
    const studentA = await login(running.base, "student", SANDBOX_A);
    const teacherA = await login(running.base, "teacher", SANDBOX_A);
    const teacherB = await login(running.base, "teacher", SANDBOX_B);

    const asked = await api(running.base, studentA, "/api/qa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        studentContext: "student:S240101",
        offeringId: 7,
        question: "栈和队列的区别是什么？",
        clientRequestId: "00000000-0000-4000-8000-000000000001",
      }),
    });
    assert.equal(asked.response.status, 200, JSON.stringify(asked.payload));

    const inboxA = await api(running.base, teacherA, "/api/qa/teacher-inbox?context=teacher%3A7%3A1&status=all");
    const inboxB = await api(running.base, teacherB, "/api/qa/teacher-inbox?context=teacher%3A7%3A1&status=all");
    assert.equal(inboxA.payload.data.length, 1);
    assert.equal(inboxB.payload.data.length, 0);

    await close(running.server);
    running = await listen(root);
    const history = await api(running.base, studentA, "/api/qa/history?studentContext=student%3AS240101&offeringId=7");
    assert.equal(history.response.status, 200);
    assert.equal(history.payload.data.length, 1);
    assert.equal(history.payload.data[0].question, "栈和队列的区别是什么？");
  } finally {
    if (running?.server?.listening) await close(running.server);
    await rm(root, { recursive: true, force: true });
  }
});
