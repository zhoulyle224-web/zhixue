// 本地静态部署服务器：把 dist/client（或指定目录）作为静态站点跑起来。
// 用法: node scripts/serve-static.mjs [目录] [端口]
// 默认: dist/client, 端口 8080（被占用时自动尝试 8081..8090）
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  process.argv[2] || "dist/client"
);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function sendFile(res, filePath) {
  const body = await readFile(filePath);
  const type = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": "no-cache",
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname === "/") pathname = "/index.html";
    let filePath = normalize(join(rootDir, pathname));
    if (!filePath.startsWith(rootDir + sep) && filePath !== rootDir) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const info = await stat(filePath);
      if (info.isDirectory()) filePath = join(filePath, "index.html");
      await sendFile(res, filePath);
    } catch {
      // 无扩展名的路径回退到 index.html（与 worker 行为一致），否则 404
      if (!extname(pathname)) {
        await sendFile(res, join(rootDir, "index.html"));
      } else {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("404 not found");
      }
    }
  } catch {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end("500 internal error");
  }
});

const startPort = Number(process.argv[3] || 8080);
const maxPort = startPort + 10;

function listen(port) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && port < maxPort) {
      console.log(`port ${port} in use, trying ${port + 1}...`);
      listen(port + 1);
    } else {
      console.error("server error:", err.message);
      process.exit(1);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`STATIC_SERVER_READY http://127.0.0.1:${port}  (root: ${rootDir})`);
  });
}

listen(startPort);
