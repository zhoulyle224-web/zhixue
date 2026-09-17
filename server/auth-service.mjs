import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const COOKIE_NAME = "zhixue_session";
const SESSION_HOURS = 8;
const REMEMBER_DAYS = 7;
const ACCOUNT_RE = /^[a-z0-9_-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{40,100}$/;

export class AuthError extends Error {
  constructor(code, message, status = 401) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("base64url");
}

function derivePassword(password, salt) {
  return scryptSync(password, Buffer.from(salt, "base64"), 32).toString("base64");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(header) {
  const pairs = String(header || "").split(";");
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index < 0 || pair.slice(0, index).trim() !== COOKIE_NAME) continue;
    const token = pair.slice(index + 1).trim();
    return TOKEN_RE.test(token) ? token : null;
  }
  return null;
}

function header(request, name) {
  return request.headers?.[name.toLowerCase()] || "";
}

export function createAuthService({ runtimeStore, baseDb, secureCookie = process.env.ZHIXUE_COOKIE_SECURE === "1" }) {
  const db = runtimeStore.taskDatabase;

  function seed(accountName, role, actorRefId, actorRefCode) {
    const account = accountName.toLowerCase();
    if (db.prepare("SELECT 1 FROM runtime_auth_accounts WHERE account_name=?").get(account)) return;
    const salt = randomBytes(16).toString("base64");
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO runtime_auth_accounts
      (id,account_name,role,actor_ref_id,actor_ref_code,password_algo,password_salt,password_hash,disabled,created_at,updated_at)
      VALUES (?,?,?,?,?,'scrypt-v1',?,?,0,?,?)`).run(
      "acct_" + randomUUID(), account, role, actorRefId, actorRefCode,
      salt, derivePassword("demo123", salt), now, now,
    );
  }

  seed("teacher2026", "teacher", 7, "T0007");
  seed("student2026", "student", 1, "S240101");

  function actor(account) {
    if (account.role === "teacher") {
      const row = baseDb.prepare("SELECT id,teacher_no,display_name,active FROM teachers WHERE id=? AND teacher_no=?")
        .get(account.actor_ref_id, account.actor_ref_code);
      if (!row || row.active !== 1) throw new AuthError("AUTH_ACTOR_NOT_AVAILABLE", "演示教师身份当前不可用。", 403);
      return row;
    }
    const row = baseDb.prepare("SELECT id,student_no,display_name,status FROM students WHERE id=? AND student_no=?")
      .get(account.actor_ref_id, account.actor_ref_code);
    if (!row || row.status !== "在读") throw new AuthError("AUTH_ACTOR_NOT_AVAILABLE", "演示学生身份当前不可用。", 403);
    return row;
  }

  function publicData(session, csrfToken) {
    return {
      authenticated: true,
      role: session.role,
      displayName: session.role === "teacher" ? "演示教师" : "演示学生",
      account: session.accountName,
      actor: session.role === "teacher"
        ? { teacherNo: session.actorRefCode }
        : { studentRef: session.actorRefCode.replace(/^(S\d{2})\d+(\d{2})$/, "$1***$2") },
      defaultTarget: session.role + ".html",
      csrfToken,
      session: {
        expiresAt: session.expiresAt,
        rememberLogin: session.rememberLogin,
      },
    };
  }

  function cookie(token, rememberLogin) {
    const attributes = [`${COOKIE_NAME}=${token}`, "HttpOnly", "SameSite=Strict", "Path=/"];
    if (rememberLogin) attributes.push(`Max-Age=${REMEMBER_DAYS * 86400}`);
    if (secureCookie) attributes.push("Secure");
    return attributes.join("; ");
  }

  function clearCookie() {
    const attributes = [`${COOKIE_NAME}=`, "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"];
    if (secureCookie) attributes.push("Secure");
    return attributes.join("; ");
  }

  function login({ account, password, requestedRole, rememberLogin = false, userAgent = "" }) {
    const accountName = String(account || "").trim().toLowerCase();
    const secret = String(password || "");
    if (!ACCOUNT_RE.test(accountName) || secret.length < 1 || secret.length > 128) {
      throw new AuthError("AUTH_CREDENTIAL_INVALID", "账号或密码格式不正确。", 400);
    }
    const row = db.prepare("SELECT * FROM runtime_auth_accounts WHERE account_name=?").get(accountName);
    if (!row || row.password_algo !== "scrypt-v1") {
      throw new AuthError("AUTH_INVALID_CREDENTIALS", "演示账号或密码不正确。", 401);
    }
    const actual = derivePassword(secret, row.password_salt);
    if (!safeEqual(actual, row.password_hash)) {
      throw new AuthError("AUTH_INVALID_CREDENTIALS", "演示账号或密码不正确。", 401);
    }
    if (row.disabled === 1) throw new AuthError("AUTH_ACCOUNT_DISABLED", "该演示账号已停用。", 403);
    if (requestedRole && requestedRole !== row.role) {
      throw new AuthError("AUTH_ROLE_MISMATCH", "该账号不能登录所选身份。", 403);
    }
    actor(row);
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (rememberLogin ? REMEMBER_DAYS * 86400000 : SESSION_HOURS * 3600000));
    const sessionId = "sess_" + randomUUID();
    db.prepare(`INSERT INTO runtime_auth_sessions
      (id,account_id,session_token_hash,csrf_token_hash,created_at,last_seen_at,expires_at,remember_login,user_agent_hash)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      sessionId, row.id, hash(token), hash(csrfToken), now.toISOString(), now.toISOString(),
      expiresAt.toISOString(), rememberLogin ? 1 : 0,
      userAgent ? hash(String(userAgent).slice(0, 500)) : null,
    );
    const session = {
      sessionId,
      accountId: row.id,
      accountName: row.account_name,
      role: row.role,
      actorRefId: row.actor_ref_id,
      actorRefCode: row.actor_ref_code,
      expiresAt: expiresAt.toISOString(),
      rememberLogin: Boolean(rememberLogin),
      rawToken: token,
    };
    return { session, csrfToken, cookie: cookie(token, rememberLogin), data: publicData(session, csrfToken) };
  }

  function resolve(request) {
    const token = cookieValue(header(request, "cookie"));
    if (!token) throw new AuthError("AUTH_REQUIRED", "请先登录。", 401);
    const row = db.prepare(`SELECT s.*,a.account_name,a.role,a.actor_ref_id,a.actor_ref_code,a.disabled
      FROM runtime_auth_sessions s JOIN runtime_auth_accounts a ON a.id=s.account_id
      WHERE s.session_token_hash=?`).get(hash(token));
    if (!row || row.revoked_at) throw new AuthError("AUTH_SESSION_INVALID", "会话无效，请重新登录。", 401);
    if (Date.parse(row.expires_at) <= Date.now()) {
      throw new AuthError("AUTH_SESSION_EXPIRED", "会话已过期，请重新登录。", 401);
    }
    if (row.disabled === 1) throw new AuthError("AUTH_ACCOUNT_DISABLED", "该演示账号已停用。", 403);
    actor(row);
    if (Date.now() - Date.parse(row.last_seen_at) > 300000) {
      db.prepare("UPDATE runtime_auth_sessions SET last_seen_at=? WHERE id=?")
        .run(new Date().toISOString(), row.id);
    }
    return {
      sessionId: row.id,
      accountId: row.account_id,
      accountName: row.account_name,
      role: row.role,
      actorRefId: row.actor_ref_id,
      actorRefCode: row.actor_ref_code,
      expiresAt: row.expires_at,
      rememberLogin: row.remember_login === 1,
      rawToken: token,
      csrfTokenHash: row.csrf_token_hash,
    };
  }

  function me(session) {
    const csrfToken = randomBytes(32).toString("base64url");
    const csrfTokenHash = hash(csrfToken);
    const result = db.prepare(`UPDATE runtime_auth_sessions SET csrf_token_hash=?
      WHERE id=? AND revoked_at IS NULL AND expires_at>?`)
      .run(csrfTokenHash, session.sessionId, new Date().toISOString());
    if (result.changes !== 1) throw new AuthError("AUTH_SESSION_INVALID", "会话无效，请重新登录。", 401);
    session.csrfTokenHash = csrfTokenHash;
    return publicData(session, csrfToken);
  }

  function requireCsrf(request, session) {
    const origin = header(request, "origin");
    const protocol = request.socket?.encrypted ? "https" : "http";
    const expectedOrigin = `${protocol}://${header(request, "host")}`;
    if (origin && origin !== expectedOrigin) {
      throw new AuthError("AUTH_ORIGIN_FORBIDDEN", "跨站状态请求已拒绝。", 403);
    }
    const supplied = String(header(request, "x-csrf-token"));
    if (!supplied || !safeEqual(hash(supplied), session.csrfTokenHash)) {
      throw new AuthError("AUTH_CSRF_INVALID", "安全校验失败，请刷新页面后重试。", 403);
    }
  }

  function logout(session) {
    db.prepare("UPDATE runtime_auth_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL")
      .run(new Date().toISOString(), session.sessionId);
    return clearCookie();
  }

  return { login, resolve, me, requireCsrf, logout, clearCookie, cookieName: COOKIE_NAME };
}
