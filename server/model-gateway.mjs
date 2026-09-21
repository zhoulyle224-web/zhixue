export const PROVIDER_PRESETS = Object.freeze([
  Object.freeze({ id: "qwen", label: "通义千问", shortLabel: "Qwen", accent: "violet", description: "阿里云百炼 OpenAI 兼容接口", apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", defaultModel: "qwen-plus", models: ["qwen-plus", "qwen-max", "qwen-turbo"] }),
  Object.freeze({ id: "deepseek", label: "DeepSeek", shortLabel: "DeepSeek", accent: "blue", description: "DeepSeek 官方开放平台", apiUrl: "https://api.deepseek.com/chat/completions", defaultModel: "deepseek-chat", models: ["deepseek-chat", "deepseek-reasoner"] }),
  Object.freeze({ id: "siliconflow", label: "硅基流动", shortLabel: "SiliconFlow", accent: "cyan", description: "多模型统一推理平台", apiUrl: "https://api.siliconflow.cn/v1/chat/completions", defaultModel: "deepseek-ai/DeepSeek-V3.2", models: ["deepseek-ai/DeepSeek-V3.2", "Qwen/Qwen3-32B"] }),
  Object.freeze({ id: "openai", label: "OpenAI", shortLabel: "OpenAI", accent: "green", description: "OpenAI 官方 API", apiUrl: "https://api.openai.com/v1/chat/completions", defaultModel: "gpt-5-mini", models: ["gpt-5-mini", "gpt-5.2"] }),
]);

const DEFAULT_PRESET = PROVIDER_PRESETS[0];

export class ModelGatewayError extends Error {
  constructor(code, message, { retryable = false, status = 502 } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function allowedHosts() {
  return new Set([
    "dashscope.aliyuncs.com", "api.deepseek.com", "api.siliconflow.cn", "api.openai.com",
    ...String(process.env.ZHIXUE_MODEL_ALLOWED_HOSTS || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean),
  ]);
}

function validateEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new ModelGatewayError("AI_ENDPOINT_INVALID", "服务端预设的模型地址无效。", { status: 500 }); }
  if (url.protocol !== "https:" || !allowedHosts().has(url.hostname.toLowerCase())) {
    throw new ModelGatewayError("AI_ENDPOINT_FORBIDDEN", "服务端预设的模型地址未通过安全允许列表。", { status: 500 });
  }
  return url.toString();
}

export function validateModelName(value, fallback = DEFAULT_PRESET.defaultModel) {
  const model = String(value || fallback).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(model)) {
    throw new ModelGatewayError("AI_MODEL_INVALID", "模型名称格式不正确。", { status: 400 });
  }
  return model;
}

function classify(error) {
  if (error instanceof ModelGatewayError) return error;
  if (error?.name === "AbortError") return new ModelGatewayError("AI_PROVIDER_TIMEOUT", "模型服务超时。", { retryable: true, status: 504 });
  return new ModelGatewayError("AI_PROVIDER_UNAVAILABLE", "模型服务当前不可用。", { retryable: true });
}

export function createModelGateway({
  apiUrl = process.env.ZHIXUE_MODEL_API_URL || DEFAULT_PRESET.apiUrl,
  model = process.env.ZHIXUE_MODEL_NAME || DEFAULT_PRESET.defaultModel,
  providerId = process.env.ZHIXUE_MODEL_PROVIDER_ID || DEFAULT_PRESET.id,
  timeoutMs = Number(process.env.ZHIXUE_MODEL_TIMEOUT_MS || 30000),
  fetchImpl = fetch,
} = {}) {
  const endpoint = validateEndpoint(apiUrl);
  const safeModel = validateModelName(model);
  const safeTimeout = Math.max(1000, Math.min(60000, Number(timeoutMs) || 30000));

  async function request(apiKey, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), safeTimeout);
    const started = Date.now();
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: safeModel, ...body }),
      });
      let payload = null;
      try { payload = await response.json(); } catch {}
      if (!response.ok) {
        const authFailure = response.status === 401 || response.status === 403;
        throw new ModelGatewayError(authFailure ? "AI_KEY_REJECTED" : `AI_PROVIDER_HTTP_${response.status}`,
          authFailure ? "API Key 验证失败。" : "模型服务返回错误。",
          { retryable: response.status === 429 || response.status >= 500, status: authFailure ? 400 : 502 });
      }
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new ModelGatewayError("AI_RESPONSE_INVALID", "模型响应格式不正确。");
      return {
        providerId, model: safeModel, modelRevision: payload.model || safeModel,
        outputText: content.trim().slice(0, 12000), finishReason: payload?.choices?.[0]?.finish_reason || null,
        tokenUsage: payload.usage || {}, providerRequestId: response.headers.get("x-request-id") || payload.id || null,
        latencyMs: Date.now() - started, safetyFlags: [],
      };
    } catch (error) { throw classify(error); }
    finally { clearTimeout(timer); }
  }

  async function healthCheck({ apiKey }) {
    return request(apiKey, {
      messages: [{ role: "system", content: "Reply with OK only." }, { role: "user", content: "Connectivity check." }],
      temperature: 0, max_tokens: 8,
    });
  }

  async function chat({ apiKey, messages, temperature = 0.2, maxTokens = 1200, responseFormat }) {
    return request(apiKey, {
      messages,
      temperature: Math.max(0, Math.min(1, Number(temperature) || 0)),
      max_tokens: Math.max(32, Math.min(4096, Number(maxTokens) || 1200)),
      ...(responseFormat ? { response_format: responseFormat } : {}),
    });
  }

  return { providerId, model: safeModel, healthCheck, chat };
}

export function createModelGatewayRegistry({ fetchImpl = fetch, timeoutMs } = {}) {
  const customPreset = process.env.ZHIXUE_MODEL_API_URL ? {
    id: process.env.ZHIXUE_MODEL_PROVIDER_ID || "custom",
    label: "学校私有模型", shortLabel: "Custom", accent: "blue",
    description: "部署环境配置的受控模型网关", apiUrl: process.env.ZHIXUE_MODEL_API_URL,
    defaultModel: process.env.ZHIXUE_MODEL_NAME || "custom-model",
    models: [process.env.ZHIXUE_MODEL_NAME || "custom-model"],
  } : null;
  const sourcePresets = customPreset ? [...PROVIDER_PRESETS, customPreset] : [...PROVIDER_PRESETS];
  const presets = new Map(sourcePresets.map((preset) => [preset.id, preset]));
  function listProviders() {
    return sourcePresets.map(({ apiUrl, ...publicPreset }) => ({ ...publicPreset }));
  }
  function gatewayFor(providerId, model) {
    const preset = presets.get(String(providerId || DEFAULT_PRESET.id));
    if (!preset) throw new ModelGatewayError("AI_PROVIDER_UNSUPPORTED", "暂不支持该模型服务商。", { status: 400 });
    return createModelGateway({ providerId: preset.id, apiUrl: preset.apiUrl, model: validateModelName(model, preset.defaultModel), timeoutMs, fetchImpl });
  }
  return { listProviders, gatewayFor, defaultProviderId: DEFAULT_PRESET.id };
}
