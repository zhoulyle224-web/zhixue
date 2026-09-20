import { resolve } from "node:path";

export const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");

export const PUBLIC_PAGES = Object.freeze([
  "index.html",
  "login.html",
  "teacher.html",
  "student.html",
  "404.html",
]);

// Only reproducible build/cache directories belong here. Persistent runtime
// data (especially data/runtime) must never be added to this list.
export const GENERATED_DIRECTORIES = Object.freeze([
  "dist",
  "release",
  ".tmp",
]);

export const PRESERVED_RUNTIME_DIRECTORIES = Object.freeze([
  "data/runtime",
  "backups",
  "outputs",
]);
