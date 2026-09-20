import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function fileName(secretRef) {
  return `${createHash("sha256").update(secretRef).digest("hex")}.secret`;
}

/**
 * Minimal server-only secret store. Database rows keep only secret_ref and the
 * last four characters; the key is written to a separate, ignored directory.
 * Passing no root creates an in-memory store for tests.
 */
export function createSecretStore({ root } = {}) {
  const memory = new Map();

  async function set(secretRef, value) {
    const secret = String(value || "").trim();
    if (!/^local:\/\/ai\/[a-z0-9/_-]+$/i.test(secretRef)) throw new Error("SECRET_REF_INVALID");
    if (secret.length < 8 || secret.length > 4096) throw new Error("SECRET_VALUE_INVALID");
    if (!root) {
      memory.set(secretRef, secret);
      return;
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    const target = resolve(root, fileName(secretRef));
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, secret, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { await rename(temporary, target); }
    catch (error) {
      if (!["EEXIST", "EPERM"].includes(error.code)) throw error;
      await writeFile(target, secret, { encoding: "utf8", mode: 0o600 });
      await rm(temporary, { force: true });
    }
    try { await chmod(target, 0o600); } catch {}
  }

  async function get(secretRef) {
    if (!secretRef) return null;
    if (!root) return memory.get(secretRef) || null;
    try { return (await readFile(resolve(root, fileName(secretRef)), "utf8")).trim() || null; }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  return { set, get };
}
