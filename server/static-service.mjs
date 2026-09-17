import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { text } from "./http-utils.mjs";

const PUBLIC_PAGES = new Set([
  "index.html",
  "login.html",
  "teacher.html",
  "student.html",
  "404.html",
]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

export function createStaticHandler({ root, assetsRoot = resolve(root, "assets") }) {
  return async function serveStatic(url) {
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return text("400 bad request", 400, "text/plain; charset=utf-8");
    }
    if (pathname === "/") pathname = "/index.html";

    let filePath;
    if (pathname.startsWith("/assets/")) {
      filePath = resolve(assetsRoot, `.${pathname.slice("/assets".length)}`);
      if (filePath !== assetsRoot && !filePath.startsWith(`${assetsRoot}${sep}`)) {
        return text("403 forbidden", 403, "text/plain; charset=utf-8");
      }
    } else {
      const pageName = pathname.replace(/^\/+/, "");
      if (!PUBLIC_PAGES.has(pageName)) {
        return text("404 not found", 404, "text/plain; charset=utf-8");
      }
      filePath = resolve(root, pageName);
    }

    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error("not a file");
      const body = await readFile(filePath);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream",
          "cache-control": filePath.startsWith(assetsRoot) ? "public, max-age=300" : "no-cache",
          "content-length": String(body.length),
          "x-content-type-options": "nosniff",
          "content-security-policy":
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
          "referrer-policy": "no-referrer",
          "x-frame-options": "DENY",
        },
      });
    } catch {
      return text("404 not found", 404, "text/plain; charset=utf-8");
    }
  };
}
