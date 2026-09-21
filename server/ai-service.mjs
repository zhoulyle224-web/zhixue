import { createHash, randomUUID } from "node:crypto";
import { ModelGatewayError, validateModelName } from "./model-gateway.mjs";

export class AiServiceError extends Error {
  constructor(code, message, status = 400, details = {}) { super(message); this.code = code; this.status = status; this.details = details; }
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function gatewayAdapter(modelGateway) {
  if (typeof modelGateway?.gatewayFor === "function" && typeof modelGateway?.listProviders === "function") return modelGateway;
  const providerId = modelGateway?.providerId || "qwen";
  const model = modelGateway?.model || "qwen-plus";
  return {
    defaultProviderId: providerId,
    listProviders: () => [{ id: providerId, label: providerId === "qwen" ? "通义千问" : providerId, shortLabel: providerId, accent: "violet", description: "服务端模型接口", defaultModel: model, models: [model] }],
    gatewayFor: (requestedProvider, requestedModel) => {
      if (requestedProvider && requestedProvider !== providerId) throw new ModelGatewayError("AI_PROVIDER_UNSUPPORTED", "暂不支持该模型服务商。", { status: 400 });
      if (requestedModel && requestedModel !== model) throw new ModelGatewayError("AI_MODEL_UNSUPPORTED", "测试网关不支持该模型。", { status: 400 });
      return modelGateway;
    },
  };
}

export function createAiService({ runtimeStore, modelGateway, secretStore, persistence = "server" }) {
  const gateways = gatewayAdapter(modelGateway);

  async function status() {
    const active = runtimeStore.getAiConfig();
    const listedConfigs = runtimeStore.listAiConfigs?.() || [];
    const configs = new Map((listedConfigs.length ? listedConfigs : active ? [active] : []).map((item) => [item.providerId, item]));
    const providers = await Promise.all(gateways.listProviders().map(async (preset) => {
      const config = configs.get(preset.id);
      const secretAvailable = Boolean(config?.secretRef && await secretStore.get(config.secretRef));
      const configured = Boolean(config?.verificationStatus === "verified" && secretAvailable);
      return {
        ...preset,
        configured,
        active: configured && active?.providerId === preset.id,
        keyMask: configured && config?.keyLastFour ? `••••${config.keyLastFour}` : null,
        model: config?.model || preset.defaultModel,
        verifiedAt: configured ? config.verifiedAt : null,
      };
    }));
    const activeProvider = providers.find((item) => item.active);
    return {
      configured: Boolean(activeProvider),
      status: activeProvider ? "available" : "unconfigured",
      activeProviderId: activeProvider?.id || null,
      keyMask: activeProvider?.keyMask || null,
      verifiedAt: activeProvider?.verifiedAt || null,
      persistence,
      providers,
    };
  }

  async function configureKey(apiKey, accountId, options = {}) {
    const key = String(apiKey || "").trim();
    if (key.length < 8 || key.length > 4096) throw new AiServiceError("AI_KEY_INVALID", "请输入有效的 API Key。");
    const providerId = String(options.providerId || gateways.defaultProviderId || gateways.listProviders()[0]?.id || "qwen");
    const preset = gateways.listProviders().find((item) => item.id === providerId);
    if (!preset) throw new AiServiceError("AI_PROVIDER_UNSUPPORTED", "暂不支持该模型服务商。");
    let model;
    let gateway;
    try {
      model = validateModelName(options.model, preset.defaultModel);
      gateway = gateways.gatewayFor(providerId, model);
    } catch (error) {
      throw new AiServiceError(error.code || "AI_CONFIG_INVALID", error.message || "模型配置无效。", error.status || 400);
    }
    let health;
    try { health = await gateway.healthCheck({ apiKey: key }); }
    catch (error) {
      const mapped = error instanceof ModelGatewayError ? error : new ModelGatewayError("AI_PROVIDER_UNAVAILABLE", "模型服务当前不可用。", { retryable: true });
      throw new AiServiceError(mapped.code, mapped.message, mapped.status, { saved: false, retryable: mapped.retryable });
    }
    const secretRef = `local://ai/provider/${providerId}`;
    await secretStore.set(secretRef, key);
    runtimeStore.saveAiConfig({ providerId, secretRef, keyLastFour: key.slice(-4), model, accountId });
    return { ...await status(), providerVerified: Boolean(health.providerId) };
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
      const gateway = gateways.gatewayFor(config.providerId, config.model);
      const result = await gateway.chat({ apiKey, messages });
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
