import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const client = resolve(dist, "client");
const server = resolve(dist, "server");
const metadata = resolve(dist, ".openai");
const publicPages = ["index.html", "login.html", "teacher.html", "student.html", "404.html"];

await rm(dist, { recursive: true, force: true });
await Promise.all([mkdir(client, { recursive: true }), mkdir(server, { recursive: true }), mkdir(metadata, { recursive: true })]);
await Promise.all(publicPages.map((fileName) => cp(resolve(root, fileName), resolve(client, fileName))));
await Promise.all([
  cp(resolve(root, "assets"), resolve(client, "assets"), { recursive: true }),
  cp(resolve(root, "worker", "index.js"), resolve(server, "index.js")),
  cp(resolve(root, ".openai", "hosting.json"), resolve(metadata, "hosting.json")),
  cp(resolve(root, "drizzle"), resolve(metadata, "drizzle"), { recursive: true }),
]);

console.log("HOSTED_SITE_BUILD_OK");
