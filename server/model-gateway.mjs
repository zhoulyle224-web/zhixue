const DEFAULT_API_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const DEFAULT_MODEL = "qwen-plus";

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
    "dashscope.aliyuncs.com",
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

function classify(error) {
  if (error instanceof ModelGatewayError) return error;
  if (error?.name === "AbortError") return new ModelGatewayError("AI_PROVIDER_TIMEOUT", "模型服务超时。", { retryable: true, status: 504 });
  return new ModelGatewayError("AI_PROVIDER_UNAVAILABLE", "模型服务当前不可用。", { retryable: true });
}

export function createModelGateway({
  apiUrl = process.env.ZHIXUE_MODEL_API_URL || DEFAULT_API_URL,
  model = process.env.ZHIXUE_MODEL_NAME || DEFAULT_MODEL,
  providerId = process.env.ZHIXUE_MODEL_PROVIDER_ID || "dashscope-openai-compatible",
  timeoutMs = Number(process.env.ZHIXUE_MODEL_TIMEOUT_MS || 30000),
  fetchImpl = fetch,
} = {}) {
  const endpoint = validateEndpoint(apiUrl);
  const safeTimeout = Math.max(1000, Math.min(60000, Number(timeoutMs) || 30000));

  async function request(apiKey, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), safeTimeout);
    const started = Date.now();
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, ...body }),
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
        providerId,
        model,
        modelRevision: payload.model || model,
        outputText: content.trim().slice(0, 12000),
        finishReason: payload?.choices?.[0]?.finish_reason || null,
        tokenUsage: payload.usage || {},
        providerRequestId: response.headers.get("x-request-id") || payload.id || null,
        latencyMs: Date.now() - started,
        safetyFlags: [],
      };
    } catch (error) { throw classify(error); }
    finally { clearTimeout(timer); }
  }

  async function healthCheck({ apiKey }) {
    return request(apiKey, {
      messages: [
        { role: "system", content: "Return only the JSON object requested." },
        { role: "user", content: "Return {\"ok\":true}." },
      ],
      temperature: 0,
      max_tokens: 16,
      response_format: { type: "json_object" },
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

  return { providerId, model, healthCheck, chat };
}
