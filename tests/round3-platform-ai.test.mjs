import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createZhixueServer } from "../server/local-api.mjs";
import { createRuntimeStore } from "../server/runtime-store.mjs";
import { createSecretStore } from "../server/secret-store.mjs";
import { createModelGatewayRegistry } from "../server/model-gateway.mjs";
import { createAuthenticatedFetch } from "./auth-test-helper.mjs";

const studentContext = "student:S240101";

function fakeGateway({ invalidCitation = false } = {}) {
  return {
    providerId: "test-openai-compatible",
    model: "test-model",
    async healthCheck({ apiKey }) {
      assert.equal(apiKey, "sk-round3-secret-1234");
      return { providerId: this.providerId, model: this.model, outputText: '{"ok":true}' };
    },
    async chat({ apiKey }) {
      assert.equal(apiKey, "sk-round3-secret-1234");
      return {
        providerId: this.providerId, model: this.model, modelRevision: "test-model-r1",
        outputText: invalidCitation ? "错误引用 [99]" : "A* 的 f(n) 由路径代价与启发式估价组成。[1]",
        finishReason: "stop", tokenUsage: { prompt_tokens: 12, completion_tokens: 18 },
        providerRequestId: "provider_req_test", latencyMs: 5, safetyFlags: [],
      };
    },
  };
}

async function withServer(run, gateway = fakeGateway()) {
  const runtimeStore = createRuntimeStore(":memory:", { environment: "test" });
  const secretStore = createSecretStore();
  const server = createZhixueServer({ runtimeStore, modelGateway: gateway, secretStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const authFetch = createAuthenticatedFetch(base);
  try { await run({ base, fetch: authFetch, runtimeStore }); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    runtimeStore.close();
  }
}

async function jsonRequest(fetch, url, options = {}) {
  const response = await fetch(url, options);
  return { status: response.status, body: await response.json() };
}

test("R3-AI-01 API Key 仅管理员可配置且数据库不保存明文", async () => {
  await withServer(async ({ base, fetch, runtimeStore }) => {
    const before = await jsonRequest(fetch, `${base}/api/v1/admin/ai/status`);
    assert.equal(before.status, 200);
    assert.equal(before.body.data.configured, false);

    const denied = await jsonRequest(fetch, `${base}/api/v1/admin/ai/status`, { headers: { "x-test-role": "student" } });
    assert.equal(denied.status, 403);

    const saved = await jsonRequest(fetch, `${base}/api/v1/admin/ai/key`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-round3-secret-1234" }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.keyMask, "••••1234");
    assert.doesNotMatch(JSON.stringify(saved.body), /sk-round3-secret/);

    const row = runtimeStore.taskDatabase.prepare("SELECT * FROM runtime_ai_provider_configs WHERE provider_id='test-openai-compatible'").get();
    assert.equal(row.secret_ref, "local://ai/provider/test-openai-compatible");
    assert.equal(row.key_last_four, "1234");
    assert.doesNotMatch(JSON.stringify(row), /sk-round3-secret/);
  });
});

test("R3-AI-01B 支持多服务商独立 Key 与自定义模型", async () => {
  const registry = createModelGatewayRegistry({
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      return new Response(JSON.stringify({
        id: "provider_req_multi", model: request.model,
        choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: {},
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await withServer(async ({ base, fetch, runtimeStore }) => {
    const before = await jsonRequest(fetch, `${base}/api/v1/admin/ai/status`);
    assert.deepEqual(before.body.data.providers.map((item) => item.id), ["qwen", "deepseek", "siliconflow", "openai"]);

    for (const config of [
      { providerId: "deepseek", model: "deepseek-reasoner", apiKey: "sk-deepseek-example-1234" },
      { providerId: "qwen", model: "qwen-custom-edu", apiKey: "sk-qwen-example-5678" },
    ]) {
      const saved = await jsonRequest(fetch, `${base}/api/v1/admin/ai/key`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(config),
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.data.activeProviderId, config.providerId);
    }

    const rows = runtimeStore.taskDatabase.prepare("SELECT provider_id,model,key_last_four FROM runtime_ai_provider_configs ORDER BY provider_id").all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { provider_id: "deepseek", model: "deepseek-reasoner", key_last_four: "1234" },
      { provider_id: "qwen", model: "qwen-custom-edu", key_last_four: "5678" },
    ]);
    const status = await jsonRequest(fetch, `${base}/api/v1/admin/ai/status`);
    assert.equal(status.body.data.providers.filter((item) => item.configured).length, 2);
    assert.equal(status.body.data.providers.find((item) => item.id === "qwen").active, true);
    assert.doesNotMatch(JSON.stringify(status.body), /sk-(?:deepseek|qwen)-example/);
  }, registry);
});

test("R3-AI-02 v1 问答经 course-ai-tutor 与 ModelGateway 后持久化运行记录", async () => {
  await withServer(async ({ base, fetch, runtimeStore }) => {
    await jsonRequest(fetch, `${base}/api/v1/admin/ai/key`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-round3-secret-1234" }),
    });
    const session = await jsonRequest(fetch, `${base}/api/v1/ai/qa/sessions`, {
      method: "POST", headers: { "content-type": "application/json", "x-test-role": "student" },
      body: JSON.stringify({ studentContext, offeringId: 7, title: "A*" }),
    });
    assert.equal(session.status, 201);
    const answer = await jsonRequest(fetch, `${base}/api/v1/ai/qa/sessions/${session.body.data.sessionId}/messages`, {
      method: "POST", headers: { "content-type": "application/json", "x-test-role": "student" },
      body: JSON.stringify({ studentContext, question: "A* 搜索中的 f(n) 表示什么？", clientRequestId: randomUUID() }),
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.data.ai_generated, true);
    assert.equal(answer.body.data.generation_status, "completed_persisted");
    assert.match(answer.body.data.answer_content, /\[1\]/);
    assert.match(answer.body.meta.modelRunId, /^airun_/);
    assert.equal(answer.body.meta.persisted, true);

    const run = runtimeStore.getAiRun(answer.body.meta.modelRunId);
    assert.equal(run.requestId, answer.body.requestId);
    assert.equal(run.status, "completed_persisted");
    assert.equal(run.skillId, "course-ai-tutor");
    assert.equal(run.model, "test-model");
    assert.ok(run.persistedAt);
  });
});

test("R3-DATA-01 异常记录进入隔离区且确认后只激活可信记录", async () => {
  await withServer(async ({ base, fetch }) => {
    const content = await readFile(new URL("./fixtures/m2/invalid-mixed.csv", import.meta.url), "utf8");
    const validated = await jsonRequest(fetch, `${base}/api/import/validate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: "teacher:7:1", fileName: "invalid-mixed.csv", content }),
    });
    assert.equal(validated.status, 200);
    const batchId = validated.body.data.batch.batchId;
    const activated = await jsonRequest(fetch, `${base}/api/import/${batchId}/confirm`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: "teacher:7:1" }),
    });
    assert.equal(activated.status, 200);

    const status = await jsonRequest(fetch, `${base}/api/v1/admin/data/status?context=${encodeURIComponent("teacher:7:1")}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.data.environment, "test");
    assert.match(status.body.data.activeDataVersion, /^dv_/);
    assert.ok(status.body.data.counts.quarantine > 0);
    assert.equal(status.body.data.counts.curated, validated.body.data.quality.validRows);

    for (let index = 0; index < 2; index += 1) {
      const retry = await jsonRequest(fetch, `${base}/api/import/validate`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ context: "teacher:7:1", fileName: `invalid-mixed-${index}.csv`, content }),
      });
      await jsonRequest(fetch, `${base}/api/import/${retry.body.data.batch.batchId}/confirm`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ context: "teacher:7:1" }),
      });
    }
    const afterRetries = await jsonRequest(fetch, `${base}/api/v1/admin/data/status?context=${encodeURIComponent("teacher:7:1")}`);
    assert.equal(afterRetries.body.data.counts.curated, validated.body.data.quality.validRows,
      "同一批数据重复同步三次，当前可信版本仍只包含一组有效事件");
  });
});
