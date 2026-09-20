import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { copyClient } from "./lib/build-client.mjs";
import { resetDirectory } from "./lib/fs-safety.mjs";
import { PROJECT_ROOT } from "./lib/project-layout.mjs";
import { withProjectLock } from "./lib/project-lock.mjs";

const root = PROJECT_ROOT;
const dist = resolve(root, "dist");
const client = resolve(dist, "client");
const server = resolve(dist, "server");
const metadata = resolve(dist, ".openai");

await withProjectLock("build", async () => {
  await resetDirectory(root, dist);
  await Promise.all([
    copyClient({ root, destination: client }),
    mkdir(server, { recursive: true }),
    mkdir(metadata, { recursive: true }),
  ]);
  await Promise.all([
    cp(resolve(root, "worker", "index.js"), resolve(server, "index.js")),
    cp(resolve(root, ".openai", "hosting.json"), resolve(metadata, "hosting.json")),
    cp(resolve(root, "drizzle"), resolve(metadata, "drizzle"), { recursive: true }),
  ]);
});

console.log("HOSTED_SITE_BUILD_OK");
