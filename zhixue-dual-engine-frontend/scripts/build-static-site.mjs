import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const client = resolve(root, "dist", "client");
const publicPages = ["index.html", "login.html", "teacher.html", "student.html", "404.html"];

await rm(client, { recursive: true, force: true });
await mkdir(client, { recursive: true });
await Promise.all(
  publicPages.map((fileName) =>
    cp(resolve(root, fileName), resolve(client, fileName), { recursive: true }),
  ),
);
await cp(resolve(root, "assets"), resolve(client, "assets"), { recursive: true });

console.log("STATIC_SITE_BUILD_OK");
