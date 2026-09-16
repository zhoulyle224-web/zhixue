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
  if (request.method !== "GET") return json({ success: false, error: "method_not_allowed" }, 405);
  try {
    if (url.pathname === "/api/health") {
      const snapshotCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM dashboard_snapshots").first();
      const counters = await env.DB.prepare("SELECT SUM(row_count) AS count, COUNT(*) AS tables FROM dataset_counters").first();
      return json({ success: true, database: "D1", mode: "synthetic_read_model", snapshots: snapshotCount?.count ?? 0, sourceRecords: counters?.count ?? 0, sourceTables: counters?.tables ?? 0 });
    }
    if (url.pathname === "/api/catalog") {
      const row = await env.DB.prepare("SELECT payload_json, source_version, updated_at FROM dashboard_snapshots WHERE context_key = ? LIMIT 1").bind("catalog").first();
      if (!row) return json({ success: false, error: "catalog_not_found" }, 404);
      return json({ success: true, source: "database", sourceVersion: row.source_version, updatedAt: row.updated_at, data: JSON.parse(row.payload_json) });
    }
    if (url.pathname === "/api/dashboard") {
      const audience = url.searchParams.get("audience"), context = url.searchParams.get("context");
      if (!audience || !context || !["teacher", "student"].includes(audience)) return json({ success: false, error: "invalid_query" }, 400);
      if (!context.startsWith(`${audience}:`) || context.length > 80) return json({ success: false, error: "invalid_context" }, 400);
      const row = await env.DB.prepare("SELECT payload_json, source_version, updated_at FROM dashboard_snapshots WHERE audience = ? AND context_key = ? LIMIT 1").bind(audience, context).first();
      if (!row) return json({ success: false, error: "dashboard_not_found" }, 404);
      return json({ success: true, source: "database", sourceVersion: row.source_version, updatedAt: row.updated_at, data: JSON.parse(row.payload_json) });
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
