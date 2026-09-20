import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { resolve } from "node:path";
import { createAuthService, createSandboxId, normalizeSandboxId } from "./auth-service.mjs";
import { createExportService } from "./export-service.mjs";
import { createRuntimeStore } from "./runtime-store.mjs";
import { createTaskService } from "./task-service.mjs";
import { createLearningService } from "./learning-service.mjs";

const DEFAULT_TTL_HOURS = 24;
const DEFAULT_IDLE_MINUTES = 15;
const DEFAULT_MAX_SANDBOXES = 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function numberOption(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function databaseFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => /^sbx_[a-f0-9]{32}\.sqlite$/.test(name))
    .map((name) => ({ id: name.slice(0, -7), path: resolve(root, name) }));
}

export function createSandboxManager({
  root,
  baseDb,
  secureCookie,
  trustProxy,
  exportOptions,
  audit,
  skills,
  ttlHours = process.env.ZHIXUE_SANDBOX_TTL_HOURS,
  idleMinutes = process.env.ZHIXUE_SANDBOX_IDLE_MINUTES,
  maxSandboxes = process.env.ZHIXUE_MAX_SANDBOXES,
} = {}) {
  if (!root) throw new Error("SANDBOX_ROOT_REQUIRED");
  const sandboxRoot = resolve(root, "sandboxes");
  mkdirSync(sandboxRoot, { recursive: true });
  const ttlMs = numberOption(ttlHours, DEFAULT_TTL_HOURS, 1, 720) * 3600000;
  const idleMs = numberOption(idleMinutes, DEFAULT_IDLE_MINUTES, 1, 1440) * 60000;
  const sandboxLimit = numberOption(maxSandboxes, DEFAULT_MAX_SANDBOXES, 10, 100000);
  const active = new Map();

  function pathFor(id) {
    const normalized = normalizeSandboxId(id);
    if (!normalized) throw new Error("SANDBOX_ID_INVALID");
    return resolve(sandboxRoot, `${normalized}.sqlite`);
  }

  function touch(entry, now = Date.now()) {
    entry.lastAccess = now;
    if (now - entry.lastTouch < TOUCH_INTERVAL_MS) return;
    entry.lastTouch = now;
    try {
      const time = new Date(now);
      utimesSync(entry.path, time, time);
    } catch {}
  }

  function createServices(id) {
    const path = pathFor(id);
    const runtimeStore = createRuntimeStore(path);
    const taskService = createTaskService({ baseDb, runtimeStore, audit });
    const authService = createAuthService({ baseDb, runtimeStore, sandboxId: id, secureCookie, trustProxy });
    const exportService = createExportService({
      baseDb,
      runtimeStore,
      secondaryAudit: audit,
      options: exportOptions,
    });
    const learningService = createLearningService({ baseDb, runtimeStore, skills, audit });
    const now = Date.now();
    const entry = { id, path, runtimeStore, taskService, authService, exportService, learningService, lastAccess: now, lastTouch: 0 };
    touch(entry, now);
    active.set(id, entry);
    return entry;
  }

  function removeDatabase(path) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(`${path}${suffix}`, { force: true }); } catch {}
    }
  }

  function sweep({ removeExpired = true } = {}) {
    const now = Date.now();
    for (const [id, entry] of active) {
      if (now - entry.lastAccess < idleMs) continue;
      entry.runtimeStore.close();
      active.delete(id);
    }
    if (removeExpired) {
      for (const file of databaseFiles(sandboxRoot)) {
        if (active.has(file.id)) continue;
        try {
          if (now - statSync(file.path).mtimeMs >= ttlMs) removeDatabase(file.path);
        } catch {}
      }
    }
    return { active: active.size, stored: databaseFiles(sandboxRoot).length };
  }

  function ensureCapacity(id) {
    if (existsSync(pathFor(id))) return;
    const current = databaseFiles(sandboxRoot);
    if (current.length < sandboxLimit) return;
    sweep();
    if (databaseFiles(sandboxRoot).length >= sandboxLimit) {
      const error = new Error("演示空间暂时已满，请稍后重试。");
      error.code = "SANDBOX_CAPACITY_REACHED";
      error.status = 503;
      throw error;
    }
  }

  function get(id) {
    const normalized = normalizeSandboxId(id);
    if (!normalized) {
      const error = new Error("演示空间标识无效，请刷新登录页后重试。");
      error.code = "SANDBOX_ID_INVALID";
      error.status = 400;
      throw error;
    }
    const cached = active.get(normalized);
    if (cached) {
      touch(cached);
      return cached;
    }
    ensureCapacity(normalized);
    return createServices(normalized);
  }

  function createId() {
    let id;
    do { id = createSandboxId(); } while (existsSync(pathFor(id)));
    return id;
  }

  function close() {
    clearInterval(sweepTimer);
    for (const entry of active.values()) entry.runtimeStore.close();
    active.clear();
  }

  // Ensure the directory is writable before accepting traffic.
  const probe = resolve(sandboxRoot, ".write-probe");
  const descriptor = openSync(probe, "w");
  closeSync(descriptor);
  rmSync(probe, { force: true });
  sweep();
  const sweepTimer = setInterval(() => sweep(), Math.min(idleMs, 15 * 60 * 1000));
  sweepTimer.unref();

  return { get, createId, sweep, close, root: sandboxRoot };
}
