import { cp, copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const client = resolve(root, "dist", "client");
const server = resolve(root, "dist", "server");
const metadata = resolve(root, "dist", ".openai");

await rm(client, { recursive: true, force: true });
await mkdir(client, { recursive: true });
await mkdir(server, { recursive: true });
await mkdir(metadata, { recursive: true });
await cp(resolve(root, "github-pages"), client, { recursive: true });
await copyFile(resolve(root, "github-pages", "assets", "og.png"), resolve(client, "og.png"));
await copyFile(resolve(root, "worker", "index.js"), resolve(server, "index.js"));
await copyFile(resolve(root, ".openai", "hosting.json"), resolve(metadata, "hosting.json"));

console.log("STATIC_SITE_BUILD_OK");
