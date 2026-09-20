import { resolve } from "node:path";
import { copyClient } from "./lib/build-client.mjs";
import { resetDirectory } from "./lib/fs-safety.mjs";
import { PROJECT_ROOT } from "./lib/project-layout.mjs";
import { withProjectLock } from "./lib/project-lock.mjs";

const root = PROJECT_ROOT;
const client = resolve(root, "dist", "client");

await withProjectLock("build", async () => {
  await resetDirectory(root, client);
  await copyClient({ root, destination: client });
});

console.log("STATIC_SITE_BUILD_OK");
