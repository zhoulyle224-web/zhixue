import { createHash, randomUUID } from "node:crypto";
import { ModelGatewayError } from "./model-gateway.mjs";

export class AiServiceError extends Error {
  constructor(code, message, status = 400, details = {}) { super(message); this.code = code; this.status = status; this.details = details; }
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createAiService({ runtimeStore, modelGateway, secretStore }) {
  async function status() {
    const config = runtimeStore.getAiConfig();
    const secretAvailable = Boolean(config?.secretRef && await secretStore.get(config.secretRef));
    return {
      configured: Boolean(config && config.verificationStatus === "verified" && secretAvailable),
      status: config?.verificationStatus === "verified" && secretAvailable ? "available" : "unconfigured",
      keyMask: config?.keyLastFour ? `••••${config.keyLastFour}` : null,
      verifiedAt: config?.verifiedAt || null,
    };
  }

  async function configureKey(apiKey, accountId) {
    const key = String(apiKey || "").trim();
    if (key.length < 8 || key.length > 4096) throw new AiServiceError("AI_KEY_INVALID", "请输入有效的 API Key。");
    let health;
    try { health = await modelGateway.healthCheck({ apiKey: key }); }
    catch (error) {
      const mapped = error instanceof ModelGatewayError ? error : new ModelGatewayError("AI_PROVIDER_UNAVAILABLE", "模型服务当前不可用。", { retryable: true });
      throw new AiServiceError(mapped.code, mapped.message, mapped.status, { saved: false, retryable: mapped.retryable });
    }
    const secretRef = "local://ai/provider/default";
    await secretStore.set(secretRef, key);
    runtimeStore.saveAiConfig({ secretRef, keyLastFour: key.slice(-4), accountId });
    return { configured: true, status: "available", keyMask: `••••${key.slice(-4)}`, verifiedAt: new Date().toISOString(), providerVerified: Boolean(health.providerId) };
  }

  async function generate({ requestId = `req_${randomUUID()}`, purpose, skillId, skillVersion, actorId, tenantId = "local", courseId = null, sessionId = null, messages, evidence = [] }) {
    const config = runtimeStore.getAiConfig();
    const apiKey = config?.secretRef ? await secretStore.get(config.secretRef) : null;
    const aiRunId = `airun_${randomUUID()}`;
    runtimeStore.createAiRun({ aiRunId, requestId, purpose, skillId, skillVersion, actorId, tenantId, courseId, sessionId, inputDigest: digest({ messages, evidence }), evidence });
    if (!config || config.verificationStatus !== "verified" || !apiKey) {
      runtimeStore.updateAiRun(aiRunId, { status: "degraded_offline", errorCode: "AI_NOT_CONFIGURED" });
      throw new AiServiceError("AI_NOT_CONFIGURED", "大模型尚未配置，本次仅可展示课程检索结果。", 503, { saved: false, retryable: false, aiRunId });
    }
    runtimeStore.updateAiRun(aiRunId, { status: "generating" });
    try {
      const result = await modelGateway.chat({ apiKey, messages });
      runtimeStore.updateAiRun(aiRunId, {
        status: "validating", providerId: result.providerId, model: result.model,
        modelRevision: result.modelRevision, tokenUsage: result.tokenUsage,
        safetyFlags: result.safetyFlags, providerRequestId: result.providerRequestId,
        latencyMs: result.latencyMs,
      });
      return { aiRunId, requestId, ...result };
    } catch (error) {
      const retryable = Boolean(error.retryable);
      runtimeStore.updateAiRun(aiRunId, { status: retryable ? "failed_retryable" : "failed_terminal", errorCode: error.code || "AI_PROVIDER_UNAVAILABLE" });
      throw new AiServiceError(error.code || "AI_PROVIDER_UNAVAILABLE", error.message || "模型服务当前不可用。", error.status || 502, { saved: false, retryable, aiRunId });
    }
  }

  function markPersisted(aiRunId) { runtimeStore.updateAiRun(aiRunId, { status: "completed_persisted", persisted: true }); }
  function markRejected(aiRunId, code = "AI_OUTPUT_REJECTED") { runtimeStore.updateAiRun(aiRunId, { status: "failed_terminal", errorCode: code }); }
  function getRun(aiRunId) { return runtimeStore.getAiRun(aiRunId); }

  return { status, configureKey, generate, markPersisted, markRejected, getRun };
}
