import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(ROOT, "evidence", "m6");
const runId = process.argv[2] || (await readFile(resolve(evidenceRoot, "LATEST.txt"), "utf8")).trim();
const environment = JSON.parse(await readFile(resolve(evidenceRoot, runId, "environment.json"), "utf8"));
const results = JSON.parse(await readFile(resolve(evidenceRoot, runId, "acceptance-results.json"), "utf8"));

const failures = [];
if (!results.automatedPass) failures.push("自动化门禁未通过");
if (!results.baselineUnchanged || !environment.baselineDb.unchanged) failures.push("baseline SQLite 哈希变化");
if (environment.testMetrics.skipped || environment.testMetrics.todo) failures.push("存在 skip/todo");
if (environment.skillMetrics.failed) failures.push("Skill 测试失败");
const blocking = results.items.filter((item) => item.severity === "blocking");
for (const item of blocking) {
  if (item.lastRunResult !== "pass") failures.push(`${item.id}=${item.lastRunResult}`);
}
if (failures.length) {
  console.error("[M6] NOT_COMPLETE");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`[M6] COMPLETE ${runId}: ${blocking.length} 个 blocking 项全部通过`);
}
