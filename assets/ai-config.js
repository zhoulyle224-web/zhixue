(function () {
  'use strict';
  const menu = document.querySelector('#aiInterfaceMenu');
  const badge = document.querySelector('#aiConfigBadge');
  const message = document.querySelector('#aiConfigMessage');
  const input = document.querySelector('#aiApiKey');
  const modelInput = document.querySelector('#aiModelName');
  const suggestions = document.querySelector('#aiModelSuggestions');
  const providerGrid = document.querySelector('#aiProviderGrid');
  const providerCount = document.querySelector('#aiProviderCount');
  const editorTitle = document.querySelector('#aiEditorTitle');
  const editorDescription = document.querySelector('#aiEditorDescription');
  const keyHint = document.querySelector('#aiKeyHint');
  const toggleKey = document.querySelector('#toggleAiKey');
  const form = document.querySelector('#aiConfigForm');
  const button = document.querySelector('#saveAiKey');
  if (!menu || !badge || !message || !input || !modelInput || !providerGrid || !form || !button) return;

  let state = { providers: [], persistence: 'server' };
  let selectedId = null;

  function selectedProvider() {
    return state.providers.find((provider) => provider.id === selectedId) || state.providers[0] || null;
  }

  function setMessage(text, tone = 'neutral') {
    message.className = `ai-form-message ${tone}`;
    message.innerHTML = `<span>${tone === 'success' ? '✓' : tone === 'error' ? '!' : 'i'}</span><p></p>`;
    message.querySelector('p').textContent = text;
  }

  function selectProvider(providerId, preserveModel = false) {
    selectedId = providerId;
    const provider = selectedProvider();
    if (!provider) return;
    editorTitle.textContent = `配置 ${provider.label}`;
    editorDescription.textContent = provider.configured ? `已连接 · ${provider.keyMask}` : provider.description;
    if (!preserveModel) modelInput.value = provider.model || provider.defaultModel || '';
    suggestions.replaceChildren(...(provider.models || []).map((model) => {
      const option = document.createElement('option'); option.value = model; return option;
    }));
    keyHint.textContent = provider.configured
      ? `已保存密钥 ${provider.keyMask}；留空不会覆盖，录入新 Key 后可重新验证`
      : state.persistence === 'sandbox'
        ? '演示沙箱内临时保存，沙箱过期后自动清理'
        : '加密隔离保存，不写入普通业务数据表';
    for (const card of providerGrid.querySelectorAll('.ai-provider-card')) {
      const selected = card.dataset.provider === provider.id;
      card.classList.toggle('selected', selected);
      card.setAttribute('aria-pressed', String(selected));
    }
  }

  function render(data) {
    state = data || { providers: [] };
    const available = state.configured === true && state.status === 'available';
    badge.textContent = available ? 'AI 已连接' : '等待配置';
    badge.className = `ai-status-badge ${available ? 'ok' : ''}`;
    providerCount.textContent = `${state.providers.length} 个服务`;
    providerGrid.replaceChildren(...state.providers.map((provider) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `ai-provider-card${provider.configured ? ' configured' : ''}${provider.id === selectedId ? ' selected' : ''}`;
      card.dataset.provider = provider.id;
      card.dataset.accent = provider.accent || 'blue';
      card.setAttribute('aria-pressed', 'false');
      const initials = provider.id === 'siliconflow' ? 'SF' : provider.id === 'deepseek' ? 'DS' : provider.id === 'openai' ? 'OA' : 'QW';
      card.innerHTML = `<span class="provider-state"></span><span class="provider-logo">${initials}</span><b></b><small></small>${provider.active ? '<span class="active-label">当前使用</span>' : ''}`;
      card.querySelector('b').textContent = provider.label;
      card.querySelector('small').textContent = provider.configured ? `${provider.model} · ${provider.keyMask}` : provider.description;
      card.addEventListener('click', () => selectProvider(provider.id));
      return card;
    }));
    const preferred = state.providers.find((provider) => provider.id === selectedId)
      || state.providers.find((provider) => provider.active)
      || state.providers[0];
    if (preferred) selectProvider(preferred.id);
    setMessage(available
      ? `当前使用 ${preferred?.label || '已配置模型'} · ${preferred?.model || ''}。选择其他服务商可继续录入独立 Key。`
      : '选择模型服务商，填写模型名称与 API Key 后保存并验证。', available ? 'success' : 'neutral');
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
      badge.textContent = '状态不可用'; badge.className = 'ai-status-badge error';
      setMessage(error.message, 'error');
    }
  }

  toggleKey.addEventListener('click', () => {
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    toggleKey.textContent = reveal ? '隐藏' : '显示';
    toggleKey.setAttribute('aria-label', reveal ? '隐藏 API Key' : '显示 API Key');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const provider = selectedProvider();
    const apiKey = input.value.trim();
    const model = modelInput.value.trim();
    if (!provider) { setMessage('请先选择模型服务商。', 'error'); return; }
    if (!model) { modelInput.focus(); setMessage('请输入模型名称。', 'error'); return; }
    if (!apiKey) { input.focus(); setMessage('请输入新的 API Key；留空不会修改已有密钥。', 'error'); return; }
    button.disabled = true;
    setMessage(`正在连接 ${provider.label} 并执行最小化验证…`);
    try {
      const response = await window.ZhixueApi.apiFetch('/api/v1/admin/ai/key', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: provider.id, model, apiKey }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '验证失败');
      input.value = ''; input.type = 'password'; toggleKey.textContent = '显示';
      selectedId = provider.id;
      render(payload.data);
      setMessage(`${provider.label} / ${model} 已验证并设为当前模型。`, 'success');
    } catch (error) {
      input.value = '';
      badge.textContent = '验证未通过'; badge.className = 'ai-status-badge error';
      setMessage(`${error.message} 请检查 Key、模型名称或服务商账户权限后重试。`, 'error');
    } finally { button.disabled = false; }
  });

  void load();
})();
