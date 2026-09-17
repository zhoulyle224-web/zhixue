import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const KNOWLEDGE_ROOT = resolve(fileURLToPath(new URL("../assets/knowledge/", import.meta.url)));
export class KnowledgeError extends Error {
  constructor(message) { super(message); this.code = "QA_KNOWLEDGE_INVALID"; this.status = 500; }
}

function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }

/** Manifest failure blocks formal QA; an invalid individual resource is skipped. */
export async function loadCourseKnowledge(course, db, root = KNOWLEDGE_ROOT) {
  let manifest;
  try { manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")); }
  catch { throw new KnowledgeError("课程知识目录加载失败，请稍后重试。"); }
  if (!manifest || !nonempty(manifest.version) || manifest.synthetic !== true ||
      manifest.sourceLabel !== "合成演示课程资料" || !manifest.courses || typeof manifest.courses !== "object") {
    throw new KnowledgeError("课程知识目录配置错误。");
  }
  const entry = manifest.courses[course.courseCode];
  if (!entry) return { version: manifest.version, sourceLabel: manifest.sourceLabel, resources: [], knowledgeBase: [], sampleQuestions: [] };
  if (!Array.isArray(entry.resources) || !Array.isArray(entry.sampleQuestions) || entry.courseName !== course.courseName) {
    throw new KnowledgeError("当前课程知识目录配置错误。");
  }
  const resources = [], knowledgeBase = [], seenResources = new Set(), seenChunks = new Set();
  for (const relative of entry.resources) {
    try {
      if (!nonempty(relative)) throw new Error("missing path");
      const path = resolve(root, relative);
      if (!path.startsWith(`${resolve(root)}${sep}`) || !path.endsWith(".json")) throw new Error("invalid path");
      const raw = await readFile(path);
      const resource = JSON.parse(raw.toString("utf8"));
      if (!nonempty(resource.resourceId) || seenResources.has(resource.resourceId) ||
          resource.courseCode !== course.courseCode || resource.courseName !== course.courseName ||
          !nonempty(resource.title) || !nonempty(resource.resourceType) || !nonempty(resource.version) ||
          resource.synthetic !== true || resource.sourceLabel !== "合成演示课程资料" ||
          !Number.isInteger(resource.dbResourceId) || !Array.isArray(resource.sections) || !resource.sections.length) throw new Error("invalid resource metadata");
      const dbResource = db.prepare("SELECT course_id FROM learning_resources WHERE id = ?").get(resource.dbResourceId);
      if (!dbResource || dbResource.course_id !== course.courseId) throw new Error("db resource course mismatch");
      const sections = resource.sections.map(section => {
        if (!nonempty(section.chunkId) || seenChunks.has(section.chunkId) ||
            !nonempty(section.locator) || !nonempty(section.text) || !nonempty(section.method) || !nonempty(section.summary) ||
            !Array.isArray(section.tags) || !section.tags.length || !section.tags.every(nonempty) ||
            !Array.isArray(section.guideQuestions) || !section.guideQuestions.every(nonempty)) throw new Error("invalid section");
        return { resource_id: resource.resourceId, db_resource_id: resource.dbResourceId,
          course_code: resource.courseCode, course_name: resource.courseName,
          type: resource.resourceType, title: resource.title,
          ref: `《${resource.title}》· ${section.locator}`, locator: section.locator,
          version: resource.version, synthetic: true, source_label: resource.sourceLabel,
          chunk_id: section.chunkId, tags: section.tags, text: section.text,
          method: section.method, summary: section.summary, guide_questions: section.guideQuestions };
      });
      seenResources.add(resource.resourceId);
      for (const section of resource.sections) seenChunks.add(section.chunkId);
      resources.push({ resourceId: resource.resourceId, title: resource.title,
        resourceType: resource.resourceType, chapter: resource.chapter,
        version: resource.version, synthetic: true, sourceLabel: resource.sourceLabel,
        resourceHash: createHash("sha256").update(raw).digest("hex") });
      knowledgeBase.push(...sections);
    } catch (error) { console.warn(`跳过无效课程资料 ${String(relative)}：${error.message}`); }
  }
  return { version: manifest.version, sourceLabel: manifest.sourceLabel, resources,
    knowledgeBase, sampleQuestions: entry.sampleQuestions.filter(nonempty) };
}

export function validateEvidence(evidence, refs, knowledgeBase, courseCode) {
  if (!Array.isArray(evidence) || !evidence.length || evidence.length > 3 || !Array.isArray(refs) || refs.length !== evidence.length) return false;
  const seen = new Set();
  return evidence.every((item, index) => {
    const key = `${item.resourceId}:${item.chunkId}`;
    const source = knowledgeBase.find(chunk => chunk.resource_id === item.resourceId && chunk.chunk_id === item.chunkId);
    if (!source || seen.has(key) || item.courseCode !== courseCode || source.course_code !== courseCode ||
        item.dbResourceId !== source.db_resource_id || item.locator !== source.locator ||
        item.version !== source.version || item.title !== source.title || refs[index] !== source.ref) return false;
    seen.add(key); return true;
  });
}
