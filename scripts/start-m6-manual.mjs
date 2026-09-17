import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createZhixueServer } from "../server/local-api.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number(option("port", "4316"));
const host = option("host", "127.0.0.1");
const runtimeDbPath = resolve(option("runtime-db", "tests/.tmp/m6-manual.sqlite"));
const failAudit = process.argv.includes("--fail-audit");
await mkdir(dirname(runtimeDbPath), { recursive: true });
const exportOptions = failAudit
  ? {
      auditWriter() {
        throw new Error("M6 manual audit failure");
      },
    }
  : undefined;
const server = createZhixueServer({ runtimeDbPath, exportOptions });
server.listen(port, host, () => {
  console.log(`M6 manual server: http://${host}:${port}${failAudit ? " (audit failure mode)" : ""}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
