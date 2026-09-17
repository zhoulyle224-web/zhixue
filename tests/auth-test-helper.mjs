const nativeFetch = globalThis.fetch;

function roleFor(url, options = {}) {
  const path = new URL(String(url)).pathname;
  const query = new URL(String(url)).searchParams;
  if (path === '/api/health' || !path.startsWith('/api/')) return null;
  if (path.startsWith('/api/auth/')) return null;
  if (path === '/api/dashboard') return query.get('audience');
  if (path === '/api/export') return options.headers?.['x-test-role'] || 'teacher';
  if (path === '/api/catalog') return 'teacher';
  if (path.startsWith('/api/qa/teacher-inbox') || /\/api\/qa\/qa_[^/]+\/reply$/.test(path)) return 'teacher';
  if (path === '/api/qa' || path.startsWith('/api/qa/resources') || path.startsWith('/api/qa/history')) return 'student';
  if (path.startsWith('/api/import/') || path.startsWith('/api/analysis/') || path === '/api/analyze') return 'teacher';
  if (path.startsWith('/api/tasks/student') || /\/api\/tasks\/assignments\/[^/]+\/complete$/.test(path)) return 'student';
  if (path.startsWith('/api/tasks/')) return 'teacher';
  return options.headers?.['x-test-role'] || 'teacher';
}

export function createAuthenticatedFetch(baseUrl) {
  const sessions = new Map();
  async function session(role) {
    if (sessions.has(role)) return sessions.get(role);
    const account = role === 'student' ? 'student2026' : 'teacher2026';
    const login = await nativeFetch(baseUrl + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account, password: 'demo123', requestedRole: role }),
    });
    if (!login.ok) throw new Error(`test login failed: ${login.status}`);
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const data = (await login.json()).data;
    const value = { cookie, csrf: data.csrfToken };
    sessions.set(role, value);
    return value;
  }
  return async function authenticatedFetch(url, options = {}) {
    const role = roleFor(url, options);
    if (!role) return nativeFetch(url, options);
    const auth = await session(role);
    const headers = new Headers(options.headers || {});
    headers.delete('x-test-role');
    headers.set('cookie', auth.cookie);
    const method = String(options.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('x-csrf-token', auth.csrf);
    return nativeFetch(url, { ...options, headers });
  };
}
