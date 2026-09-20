(function () {
  'use strict';
  const menu = document.querySelector('#aiInterfaceMenu');
  const badge = document.querySelector('#aiConfigBadge');
  const message = document.querySelector('#aiConfigMessage');
  const input = document.querySelector('#aiApiKey');
  const button = document.querySelector('#saveAiKey');
  if (!menu || !badge || !message || !input || !button) return;

  function render(data) {
    const available = data?.configured === true && data?.status === 'available';
    badge.textContent = available ? 'AI 可用' : '尚未配置';
    badge.classList.toggle('ok', available);
    message.textContent = available
      ? `AI 可用 · 密钥 ${data.keyMask || '已保护'} · 验证于 ${new Date(data.verifiedAt).toLocaleString('zh-CN')}`
      : '尚未配置。输入 API Key 后点击“保存并验证”。';
  }

  async function load() {
    try {
      const auth = await window.ZhixueApi.me();
      if (!auth.capabilities?.manageAi) return;
      menu.hidden = false;
      const response = await window.ZhixueApi.apiFetch('/api/v1/admin/ai/status');
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '配置状态读取失败');
      render(payload.data);
    } catch (error) {
      badge.textContent = '状态不可用';
      message.textContent = error.message;
    }
  }

  button.addEventListener('click', async () => {
    const apiKey = input.value.trim();
    if (!apiKey) { message.textContent = '请输入新的 API Key；留空不会修改原密钥。'; return; }
    button.disabled = true;
    message.textContent = '正在由服务端执行最小化验证…';
    try {
      const response = await window.ZhixueApi.apiFetch('/api/v1/admin/ai/key', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '验证失败');
      input.value = '';
      render(payload.data);
    } catch (error) {
      input.value = '';
      badge.textContent = '验证失败';
      message.textContent = `${error.message} 请重新输入后重试。`;
    } finally { button.disabled = false; }
  });

  void load();
})();
