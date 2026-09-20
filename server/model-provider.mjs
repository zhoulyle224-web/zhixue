/** 可替换的 OpenAI-compatible 服务端模型 Provider。未配置时返回离线模式。 */
export function providerStatus() {
  const endpoint = String(process.env.ZHIXUE_MODEL_API_URL || "").trim();
  const key = String(process.env.ZHIXUE_MODEL_API_KEY || "").trim();
  const model = String(process.env.ZHIXUE_MODEL_NAME || "").trim();
  return { configured: Boolean(endpoint && key && model), provider: endpoint ? "openai-compatible" : "offline", model: model || null };
}

export async function generateWithProvider({ question, courseName, evidence, history, studentLevel }) {
  const status = providerStatus();
  if (!status.configured) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const evidenceText = (evidence || []).map((item, index) => `[${index + 1}] ${item.title} ${item.locator}: ${item.text}`).join("\n");
  const messages = [
    { role: "system", content: `你是中国高校计算机课程助教。只可依据给定证据回答；区分课程资料和公共知识；不得编造引用。学生水平：${studentLevel || "普通"}。课程：${courseName}。` },
    ...(history || []).slice(-6).map(item => ({ role: item.role === "student" ? "user" : "assistant", content: String(item.content || "").slice(0, 1200) })),
    { role: "user", content: `证据：\n${evidenceText}\n\n问题：${question}\n请给出简洁分步回答，并用 [1] 形式标注证据。` },
  ];
  try {
    const response = await fetch(process.env.ZHIXUE_MODEL_API_URL, {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.ZHIXUE_MODEL_API_KEY}` },
      body: JSON.stringify({ model: process.env.ZHIXUE_MODEL_NAME, messages, temperature: 0.2 }),
    });
    if (!response.ok) throw new Error(`MODEL_HTTP_${response.status}`);
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") throw new Error("MODEL_RESPONSE_INVALID");
    return { content: content.slice(0, 4000), provider: status.provider, model: status.model };
  } finally { clearTimeout(timeout); }
}
