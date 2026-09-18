(function (global) {
  'use strict';
  let current = null;
  let volatileSandboxId = null;
  const SANDBOX_KEY = 'zhixue_demo_sandbox_v1';
  const SANDBOX_RE = /^sbx_[a-f0-9]{32}$/;

  function createSandboxId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return `sbx_${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`;
  }

  function sandboxId() {
    if (SANDBOX_RE.test(volatileSandboxId || '')) return volatileSandboxId;
    try {
      const saved = localStorage.getItem(SANDBOX_KEY);
      if (SANDBOX_RE.test(saved || '')) return (volatileSandboxId = saved);
      volatileSandboxId = createSandboxId();
      localStorage.setItem(SANDBOX_KEY, volatileSandboxId);
      return volatileSandboxId;
    } catch {
      return (volatileSandboxId ||= createSandboxId());
    }
  }

  function rememberSandbox(data) {
    const id = data?.sandbox?.id;
    if (!SANDBOX_RE.test(id || '')) return;
    volatileSandboxId = id;
    try { localStorage.setItem(SANDBOX_KEY, id); } catch {}
  }

  function loginUrl(role) {
    const safeRole = role === 'student' ? 'student' : 'teacher';
    return `login.html?role=${safeRole}&next=${safeRole}.html`;
  }

  async function parse(response) {
    let payload;
    try { payload = await response.json(); }
    catch { throw Object.assign(new Error('服务端返回格式异常。'), { code: 'INVALID_RESPONSE', status: response.status }); }
    if (!response.ok || !payload.success) {
      const error = Object.assign(new Error(payload.message || `接口错误 ${response.status}`), {
        code: payload.code || 'REQUEST_FAILED', status: response.status, details: payload,
      });
      if (response.status === 401) current = null;
      throw error;
    }
    return payload;
  }

  async function apiFetch(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const csrfRetry = options.__csrfRetry === true;
    const { __csrfRetry: _ignored, ...fetchOptions } = options;
    const headers = { accept: 'application/json', ...(options.headers || {}) };
    const protectedWrite = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (protectedWrite) {
      if (!current?.csrfToken) await me();
      headers['x-csrf-token'] = current.csrfToken;
    }
    const response = await fetch(path, { ...fetchOptions, method, headers, credentials: 'same-origin' });
    if (protectedWrite && !csrfRetry && !path.startsWith('/api/auth/') && response.status === 403) {
      let failure = null;
      try { failure = await response.clone().json(); } catch {}
      if (failure?.code === 'AUTH_CSRF_INVALID') {
        await me();
        return apiFetch(path, { ...options, __csrfRetry: true });
      }
    }
    if (response.status === 401 && !path.startsWith('/api/auth/')) {
      current = null;
      const role = document.body.dataset.page === 'student' ? 'student' : 'teacher';
      location.replace(loginUrl(role));
    }
    return response;
  }

  async function me() {
    const payload = await parse(await fetch('/api/auth/me', { credentials: 'same-origin', headers: { accept: 'application/json' } }));
    current = payload.data;
    rememberSandbox(current);
    return current;
  }

  async function login(account, password, requestedRole, rememberLogin) {
    const payload = await parse(await fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ account, password, requestedRole, rememberLogin, sandboxId: sandboxId() }),
    }));
    current = payload.data;
    rememberSandbox(current);
    return current;
  }

  async function logout() {
    if (!current) { try { await me(); } catch {} }
    if (current) await parse(await apiFetch('/api/auth/logout', { method: 'POST' }));
    current = null;
  }

  global.ZhixueApi = { apiFetch, me, login, logout, parse, sandboxId, get current() { return current; } };
})(window);
