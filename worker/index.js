const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": status === 200 ? "public, max-age=60, s-maxage=300" : "no-store",
    "x-content-type-options": "nosniff",
  },
});

async function handleApi(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/login") {
    return json({ success: false, code: "AUTH_NOT_AVAILABLE_IN_PUBLIC_DEMO", message: "公开展示版未启用身份与写入服务，请使用本地 Node 版体验完整闭环。" }, 501);
  }
  if (url.pathname === "/api/export") {
    return json({ success: false, code: "EXPORT_NOT_AVAILABLE_IN_PUBLIC_DEMO", message: "公开展示版未启用受保护数据导出，请使用本地 Node 版。" }, 501);
  }
  if (["/api/auth/me", "/api/auth/logout", "/api/catalog", "/api/dashboard"].includes(url.pathname)) {
    return json({ success: false, code: "AUTH_NOT_AVAILABLE_IN_PUBLIC_DEMO", message: "公开展示版未开放受保护业务数据。" }, 501);
  }
  if (request.method !== "GET") return json({ success: false, error: "method_not_allowed" }, 405);
  try {
    if (url.pathname === "/api/health") {
      const snapshotCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM dashboard_snapshots").first();
      const counters = await env.DB.prepare("SELECT SUM(row_count) AS count, COUNT(*) AS tables FROM dataset_counters").first();
      return json({ success: true, database: "D1", mode: "synthetic_read_model", snapshots: snapshotCount?.count ?? 0, sourceRecords: counters?.count ?? 0, sourceTables: counters?.tables ?? 0 });
    }
  } catch (error) {
    return json({ success: false, error: "database_unavailable", message: error instanceof Error ? error.message : "unknown" }, 503);
  }
  return json({ success: false, error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    if (url.pathname !== "/" && !url.pathname.includes(".")) {
      url.pathname = "/index.html";
      request = new Request(url, request);
    }
    return env.ASSETS.fetch(request);
  },
};
