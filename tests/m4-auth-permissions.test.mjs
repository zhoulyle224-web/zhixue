import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createZhixueServer } from '../server/local-api.mjs';
import worker from '../worker/index.js';

const ROOT = resolve(import.meta.dirname, '..');
const BASELINE = join(ROOT, 'data', 'zhixue_demo.sqlite');
const hashFile = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const fixture = name => readFile(join(ROOT, 'tests', 'fixtures', name), 'utf8');

test('M4-T01～T45 服务端身份、权限与持久化安全边界', async t => {
  const baselineBefore = await hashFile(BASELINE);
  const dir = await mkdtemp(join(tmpdir(), 'zhixue-m4-'));
  const runtime = join(dir, 'runtime.sqlite');
  let server, base;

  async function start(options = {}) {
    server = createZhixueServer({ runtimeDbPath: runtime, ...options });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { if (server) await new Promise(done => server.close(done)); server = null; }
  async function login(role = 'teacher', extra = {}) {
    const account = role === 'student' ? 'student2026' : 'teacher2026';
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account, password: 'demo123', requestedRole: role, ...extra }),
    });
    const body = await response.json();
    return { response, body, cookie: (response.headers.get('set-cookie') || '').split(';')[0], csrf: body.data?.csrfToken };
  }
  async function call(auth, path, { method = 'GET', body, csrf = true, headers = {} } = {}) {
    const next = new Headers(headers);
    if (auth?.cookie) next.set('cookie', auth.cookie);
    if (body !== undefined) next.set('content-type', 'application/json');
    if (csrf && auth?.csrf && !['GET', 'HEAD'].includes(method)) next.set('x-csrf-token', auth.csrf);
    const response = await fetch(base + path, { method, headers: next, body: body === undefined ? undefined : JSON.stringify(body) });
    let payload; try { payload = await response.json(); } catch { payload = null; }
    return { response, status: response.status, body: payload };
  }
  const post = (auth, path, body, options = {}) => call(auth, path, { method: 'POST', body, ...options });

  try {
    await start();
    let teacher, student, published;

    await t.test('M4-T01 教师正确登录', async () => {
      teacher = await login('teacher');
      assert.equal(teacher.response.status, 200); assert.equal(teacher.body.data.role, 'teacher');
      const cookie = teacher.response.headers.get('set-cookie');
      assert.match(cookie, /^zhixue_session=/); assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Strict/i); assert.match(cookie, /Path=\//i);
      assert.doesNotMatch(teacher.cookie, /\./, 'Session Cookie 不得包含 CSRF token');
    });
    await t.test('M4-T02 学生正确登录', async () => {
      student = await login('student'); assert.equal(student.response.status, 200); assert.equal(student.body.data.role, 'student');
    });
    await t.test('M4-T03 错误密码不创建 Session', async () => {
      const db = new DatabaseSync(runtime); const before = db.prepare('SELECT COUNT(*) n FROM runtime_auth_sessions').get().n; db.close();
      const response = await fetch(base + '/api/auth/login', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({account:'teacher2026',password:'wrong',requestedRole:'teacher'}) });
      assert.equal(response.status,401); assert.equal((await response.json()).code,'AUTH_INVALID_CREDENTIALS');
      const check = new DatabaseSync(runtime); assert.equal(check.prepare('SELECT COUNT(*) n FROM runtime_auth_sessions').get().n,before); check.close();
    });
    await t.test('M4-T04 学生账号不能以 teacher 登录', async () => {
      const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({account:'student2026',password:'demo123',requestedRole:'teacher'})});
      assert.equal(response.status,403); assert.equal((await response.json()).code,'AUTH_ROLE_MISMATCH');
    });
    await t.test('M4-T05 无 Cookie 访问 catalog', async () => { const r=await call(null,'/api/catalog');assert.equal(r.status,401);assert.equal(r.body.code,'AUTH_REQUIRED'); });
    await t.test('M4-T06 教师 catalog 只返回所授 offering', async () => {
      const r=await call(teacher,'/api/catalog'); const ids=new Set(r.body.data.catalog.map(x=>x.offering_id)); assert.ok(ids.has(7));assert.ok(!ids.has(1));
    });
    await t.test('M4-T07 学生 catalog 只返回本人 enrollments', async () => {
      const r=await call(student,'/api/catalog'); const ids=new Set(r.body.data.catalog.map(x=>x.offering_id));
      const db=new DatabaseSync(BASELINE,{readOnly:true}); const expected=new Set(db.prepare("SELECT offering_id FROM enrollments WHERE student_id=1 AND status<>'退选'").all().map(x=>x.offering_id)); db.close();
      assert.deepEqual(ids,expected);
    });
    await t.test('M4-T08 教师合法 dashboard', async () => { assert.equal((await call(teacher,'/api/dashboard?audience=teacher&context=teacher%3A7%3A1')).status,200); });
    await t.test('M4-T09 教师越权 dashboard', async () => { const r=await call(teacher,'/api/dashboard?audience=teacher&context=teacher%3A1%3A1');assert.equal(r.status,403);assert.equal(r.body.code,'AUTH_CONTEXT_FORBIDDEN'); });
    await t.test('M4-T10 学生访问 teacher dashboard', async () => { const r=await call(student,'/api/dashboard?audience=teacher&context=teacher%3A7%3A1');assert.equal(r.status,403);assert.equal(r.body.code,'AUTH_ROLE_FORBIDDEN'); });
    await t.test('M4-T11 学生读取本人 dashboard', async () => { assert.equal((await call(student,'/api/dashboard?audience=student&context=student%3AS240101')).status,200); });
    await t.test('M4-T12 学生伪造另一个 context', async () => { const r=await call(student,'/api/dashboard?audience=student&context=student%3AS240102');assert.equal(r.status,403);assert.equal(r.body.code,'AUTH_STUDENT_SCOPE_FORBIDDEN'); });
    await t.test('M4-T13 修改 role 字段不越权', async () => { assert.equal((await post(student,'/api/export',{role:'teacher',kind:'report',format:'json',scope:{context:'teacher:7:1'}})).status,403); });
    await t.test('M4-T14 修改 context 不越权', async () => { assert.equal((await post(teacher,'/api/export',{kind:'questions',format:'json',scope:{context:'teacher:1:1'}})).status,403); });
    await t.test('M4-T15 M1 student API 受 Session 保护', async () => {
      const body={studentContext:'student:S240101',offeringId:1,question:'栈和队列有什么区别？',clientRequestId:randomUUID()};
      assert.equal((await post(null,'/api/qa',body,{csrf:false})).status,401); assert.equal((await post(student,'/api/qa',body)).status,200);
    });
    await t.test('M4-T16 M1 teacher inbox 学生禁止', async () => { assert.equal((await call(student,'/api/qa/teacher-inbox?context=teacher%3A7%3A1')).status,403); });
    await t.test('M4-T17 M2 import student 禁止', async () => { assert.equal((await post(student,'/api/import/validate',{context:'teacher:7:1',fileName:'x.csv',content:'匿名编号,知识点,得分\nS240101,K,80'})).status,403); });
    await t.test('M4-T18 M2 teacher 合法 context', async () => { assert.equal((await post(teacher,'/api/import/validate',{context:'teacher:7:1',fileName:'x.csv',content:'匿名编号,知识点,得分\nS240101,K,80'})).status,200); });
    await t.test('M4-T19 M2 teacher 非本人 context', async () => { assert.equal((await post(teacher,'/api/import/validate',{context:'teacher:1:1',fileName:'x.csv',content:'匿名编号,知识点,得分\nS240101,K,80'})).status,403); });
    await t.test('M4-T20 M3 teacher API student 禁止', async () => { assert.equal((await post(student,'/api/tasks/drafts',{context:'teacher:7:1',analysisRunId:'x'})).status,403); });
    await t.test('M4-T21 teacher 不能冒充学生完成任务', async () => { assert.equal((await post(teacher,'/api/tasks/assignments/fake/complete',{studentContext:'student:S240101'})).status,403); });

    async function publishFixture() {
      const content=await fixture(join('m3','publishable-ai201.csv'));
      const imported=await post(teacher,'/api/import/validate',{context:'teacher:7:1',fileName:'publishable-ai201.csv',content});
      const batchId=imported.body.data.batch.batchId;
      await post(teacher,`/api/import/${batchId}/confirm`,{context:'teacher:7:1'});
      const analysis=await post(teacher,'/api/analyze',{context:'teacher:7:1',batchId});
      const draft=await post(teacher,'/api/tasks/drafts',{context:'teacher:7:1',analysisRunId:analysis.body.analysisRunId});
      const version=draft.body.data, tasks=structuredClone(version.tasks);
      const saved=await call(teacher,`/api/tasks/drafts/${version.versionId}`,{method:'PUT',body:{context:'teacher:7:1',dueAt:new Date(Date.now()+86400000).toISOString(),tasks}});
      const result=await post(teacher,`/api/tasks/drafts/${version.versionId}/publish`,{context:'teacher:7:1',clientRequestId:'m4-'+randomUUID()});
      return { ...result.body.data, versionId:version.versionId, saved };
    }
    await t.test('M4-T22 assignment IDOR', async () => {
      published=await publishFixture(); const db=new DatabaseSync(runtime); const other=db.prepare('SELECT id FROM runtime_task_assignments WHERE student_id<>1 LIMIT 1').get(); db.close();
      const r=await post(student,`/api/tasks/assignments/${other.id}/complete`,{studentContext:'student:S240101',feedback:'x',clientRequestId:randomUUID()});
      assert.equal(r.status,403);assert.equal(r.body.code,'TASK_ASSIGNMENT_FORBIDDEN');
    });
    await t.test('M4-T23 缺 CSRF 的状态请求', async () => { const r=await post(teacher,'/api/analyze',{scores:[]},{csrf:false});assert.equal(r.status,403);assert.equal(r.body.code,'AUTH_CSRF_INVALID'); });
    await t.test('M4-T24 错误 CSRF', async () => { const r=await call(teacher,'/api/analyze',{method:'POST',body:{scores:[]},headers:{'x-csrf-token':'wrong'},csrf:false});assert.equal(r.status,403);assert.equal(r.body.code,'AUTH_CSRF_INVALID'); });
    await t.test('M4-T25 正确 CSRF', async () => { assert.equal((await post(teacher,'/api/analyze',{scores:[{name:'S',score:88}]})).status,200); });
    await t.test('M4-T26 logout 吊销会话', async () => { const temp=await login('teacher');assert.equal((await post(temp,'/api/auth/logout')).status,200);const me=await call(temp,'/api/auth/me');assert.equal(me.status,401); });
    await t.test('M4-T27 Session 过期', async () => {
      const temp=await login('student'); const token=temp.cookie.split('=')[1].split('.')[0];
      const db=new DatabaseSync(runtime); db.prepare("UPDATE runtime_auth_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE session_token_hash=?").run(createHash('sha256').update(token).digest('base64url')); db.close();
      const me=await call(temp,'/api/auth/me');assert.equal(me.status,401);assert.equal(me.body.code,'AUTH_SESSION_EXPIRED'); student=await login('student');
    });
    await t.test('M4-T28 服务重启保持有效 Session', async () => {
      const remembered=await login('teacher',{rememberLogin:true}); await stop(); await start(); const me=await call(remembered,'/api/auth/me');assert.equal(me.status,200);assert.equal(me.body.data.role,'teacher'); teacher=remembered;
    });
    await t.test('M4-T45 remember Session 重启后重新获取 CSRF 并继续写操作', async () => {
      const remembered=await login('teacher',{rememberLogin:true});
      const oldCsrf=remembered.csrf, cookie=remembered.cookie;
      assert.ok(oldCsrf); assert.doesNotMatch(cookie,/\./);
      await stop(); await start();

      const reopened={cookie};
      const me=await call(reopened,'/api/auth/me');
      assert.equal(me.status,200); assert.equal(me.body.data.role,'teacher');
      const newCsrf=me.body.data.csrfToken;
      assert.ok(newCsrf); assert.notEqual(newCsrf,oldCsrf);

      const restored={cookie,csrf:newCsrf};
      const write=await post(restored,'/api/analyze',{scores:[{name:'S',score:91}]});
      assert.equal(write.status,200);
      const stale=await call({cookie,csrf:oldCsrf},'/api/analyze',{method:'POST',body:{scores:[{name:'S',score:91}]}});
      assert.equal(stale.status,403); assert.equal(stale.body.code,'AUTH_CSRF_INVALID');

      const db=new DatabaseSync(runtime);
      const row=db.prepare('SELECT csrf_token_hash FROM runtime_auth_sessions WHERE session_token_hash=?').get(createHash('sha256').update(cookie.split('=')[1]).digest('base64url'));
      db.close();
      assert.equal(row.csrf_token_hash,createHash('sha256').update(newCsrf).digest('base64url'));
      assert.notEqual(row.csrf_token_hash,newCsrf);
    });
    await t.test('M4-T29 localStorage 伪造不生效', async () => { const source=await readFile(join(ROOT,'assets','app.js'),'utf8');assert.doesNotMatch(source,/zhixue_demo_auth|localStorage\.setItem\(AUTH/);assert.equal((await call(null,'/api/catalog')).status,401); });
    await t.test('M4-T30 runtime auth 密码非明文', async () => { const db=new DatabaseSync(runtime);const rows=db.prepare('SELECT * FROM runtime_auth_accounts').all();const cols=db.prepare('PRAGMA table_info(runtime_auth_accounts)').all().map(x=>x.name);db.close();assert.ok(rows.every(x=>x.password_hash!=='demo123'&&x.password_salt!=='demo123'));assert.ok(!cols.includes('password')); });
    await t.test('M4-T31 Session token 非明文落库', async () => { const raw=teacher.cookie.split('=')[1].split('.')[0];const db=new DatabaseSync(runtime);const rows=db.prepare('SELECT session_token_hash FROM runtime_auth_sessions').all();db.close();assert.ok(!rows.some(x=>x.session_token_hash===raw)); });
    await t.test('M4-T32 protected API no-store', async () => { for(const path of ['/api/auth/me','/api/dashboard?audience=teacher&context=teacher%3A7%3A1']){const r=await call(teacher,path);assert.match(r.response.headers.get('cache-control')||'',/no-store/);} });
    await t.test('M4-T33 静态 demo 无 actor 快照', async () => { const text=await readFile(join(ROOT,'assets','demo-data.json'),'utf8');const data=JSON.parse(text);assert.equal(data.teacher,undefined);assert.equal(data.student,undefined);assert.doesNotMatch(text,/teacher:\d|student:S\d/); });
    await t.test('M4-T34 runtime DB 不可静态访问', async () => { assert.equal((await fetch(base+'/data/runtime/zhixue_runtime.sqlite')).status,404); });
    await t.test('M4-T35 baseline DB 不可静态访问', async () => { assert.equal((await fetch(base+'/data/zhixue_demo.sqlite')).status,404); });
    await t.test('M4-T36 Worker dashboard fail closed', async () => { const r=await worker.fetch(new Request('https://demo.invalid/api/dashboard?audience=teacher&context=teacher:7:1'),{});assert.equal(r.status,501);assert.equal((await r.json()).code,'AUTH_NOT_AVAILABLE_IN_PUBLIC_DEMO'); });
    await t.test('M4-T37 401/403 导出无前端快照 fallback', async () => { const source=await readFile(join(ROOT,'assets','export-client.js'),'utf8');assert.match(source,/本次未生成文件/);assert.doesNotMatch(source,/JSON\.stringify\(state|页面快照导出/); });
    await t.test('M4-T38 role switch 不改 localStorage', async () => { const source=await readFile(join(ROOT,'assets','app.js'),'utf8');assert.doesNotMatch(source,/auth\.role\s*=\s*next/);assert.match(source,/切换身份需要重新登录/); });
    await t.test('M4-T39 next open redirect 被阻止', async () => { const source=await readFile(join(ROOT,'assets','app.js'),'utf8');assert.match(source,/paramsNext===`\$\{me\.role\}\.html`/);assert.doesNotMatch(source,/location\.href=params\.get\(['"]next/); });
    await t.test('M4-T40 基线 SQLite 哈希不变', async () => { assert.equal(await hashFile(BASELINE),baselineBefore); });
    await t.test('M4-T41 auth migration 不丢 M1/M2/M3 runtime 数据', async () => {
      const db=new DatabaseSync(runtime); const before={qa:db.prepare('SELECT COUNT(*) n FROM runtime_qa_records').get().n,imports:db.prepare('SELECT COUNT(*) n FROM runtime_import_batches').get().n,tasks:db.prepare('SELECT COUNT(*) n FROM runtime_task_events').get().n};db.close();
      await stop();await start();const check=new DatabaseSync(runtime);const after={qa:check.prepare('SELECT COUNT(*) n FROM runtime_qa_records').get().n,imports:check.prepare('SELECT COUNT(*) n FROM runtime_import_batches').get().n,tasks:check.prepare('SELECT COUNT(*) n FROM runtime_task_events').get().n};check.close();assert.deepEqual(after,before);assert.ok(before.qa&&before.imports&&before.tasks);teacher=await login('teacher');student=await login('student');
    });
    await t.test('M4-T42 disabled 账号现有 Session 失效', async () => { const temp=await login('teacher');const db=new DatabaseSync(runtime);db.prepare("UPDATE runtime_auth_accounts SET disabled=1 WHERE account_name='teacher2026'").run();db.close();const r=await call(temp,'/api/auth/me');assert.equal(r.status,403);assert.equal(r.body.code,'AUTH_ACCOUNT_DISABLED');const reset=new DatabaseSync(runtime);reset.prepare("UPDATE runtime_auth_accounts SET disabled=0 WHERE account_name='teacher2026'").run();reset.close(); });
    await t.test('M4-T43 inactive 教师 actor 拒绝', async () => {
      const inactive=join(dir,'inactive.sqlite');await copyFile(BASELINE,inactive);const db=new DatabaseSync(inactive);db.prepare('UPDATE teachers SET active=0 WHERE id=7').run();db.close();
      const isolated=join(dir,'inactive-runtime.sqlite');const s=createZhixueServer({runtimeDbPath:isolated,baselineDbPath:inactive});await new Promise(done=>s.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${s.address().port}`;
      const response=await fetch(url+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({account:'teacher2026',password:'demo123',requestedRole:'teacher'})});assert.equal(response.status,403);assert.equal((await response.json()).code,'AUTH_ACTOR_NOT_AVAILABLE');await new Promise(done=>s.close(done));
    });
    await t.test('M4-T44 student 未选 offering 拒绝', async () => {
      const db=new DatabaseSync(BASELINE,{readOnly:true});const row=db.prepare("SELECT id FROM course_offerings WHERE id NOT IN (SELECT offering_id FROM enrollments WHERE student_id=1 AND status<>'退选') LIMIT 1").get();db.close();
      const r=await call(student,`/api/qa/resources?studentContext=student%3AS240101&offeringId=${row.id}`);assert.equal(r.status,403);assert.equal(r.body.code,'AUTH_OFFERING_FORBIDDEN');
    });
  } finally {
    await stop();
    const safe=resolve(dir);if(!safe.startsWith(`${resolve(tmpdir())}${sep}`)||!safe.includes('zhixue-m4-'))throw new Error('拒绝清理非测试目录');
    await rm(safe,{recursive:true,force:true});
  }
});
