import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createZhixueServer } from '../server/local-api.mjs';
import worker from '../worker/index.js';

const ROOT=resolve(import.meta.dirname,'..'),BASELINE=join(ROOT,'data','zhixue_demo.sqlite');
const hashFile=async path=>createHash('sha256').update(await readFile(path)).digest('hex');

function seed(runtime){
  const db=new DatabaseSync(runtime),now=new Date().toISOString();
  const result={
    overall_summary:{total_students:3,average_score:76,pass_rate:'66.7%',excellent_rate:'33.3%'},
    knowledge_analysis:[{knowledge_point:'智能体与搜索',mastery_rate:'58%',main_error_type:'方法误用',cause_analysis:'需要复习'}],
    student_stratification:{excellent_students:['S240101'],potential_students:['S240102'],struggling_students:['S240103']},
    teaching_suggestions:{class_universal:['复习智能体与搜索'],individual_guidance:['S240101 完成拓展练习'],next_teaching_focus:'两周后复测'},
  };
  db.prepare(`INSERT INTO runtime_import_batches
    (id,context_key,file_name,file_format,file_size_bytes,file_sha256,total_rows,valid_rows,invalid_rows,duplicate_rows,warning_rows,blocking_issue_count,warning_issue_count,status,schema_version,created_at,confirmed_at,confirmed_by_context)
    VALUES ('m5_batch','teacher:7:1','m5.csv','csv',100,'abc123',3,3,0,0,0,0,0,'confirmed',1,?,?,?)`).run(now,now,'teacher:7:1');
  db.prepare(`INSERT INTO runtime_analysis_runs
    (id,batch_id,context_key,status,skill_id,skill_version,input_digest,result_json,generated_at)
    VALUES ('m5_analysis','m5_batch','teacher:7:1','completed','academic-performance-analyzer','1.0','digest',?,?)`).run(JSON.stringify(result),now);
  db.prepare(`INSERT INTO runtime_qa_records
    (id,client_request_id,student_context,student_no,class_id,offering_id,course_id,course_code,course_name,question_text_redacted,answer_status,assistant_answer,evidence_json,related_knowledge_json,guide_questions_json,knowledge_version,skill_id,skill_version,handoff_status,teacher_context,teacher_reply,created_at,answered_at,replied_at,updated_at)
    VALUES ('m5_qa','m5_req','student:S240101','S240101',1,7,7,'AI201','人工智能导论',?,'teacher_replied',?,?,'[]','[]','demo-2026.09','course-ai-tutor','1.0','replied','teacher:7:1',?,?,?, ?,?)`).run(
      '=HYPERLINK("https://evil.example") 手机 13812345678 邮箱 m5@example.com 证件 11010519491231002X 学号 S240101 <script>globalThis.pwned=1</script>',
      '请依据合成课程资料复习。',JSON.stringify([{title:'智能体与搜索',locator:'§1.3 A* 搜索',version:'demo-2026.09',sourceLabel:'合成演示课程资料'}]),
      '教师回复 m5-teacher@example.com',now,now,now,now);
  db.prepare(`INSERT INTO runtime_task_plans(id,context_key,offering_id,class_id,created_by_context,created_at,updated_at)
    VALUES ('m5_plan','teacher:7:1',7,1,'teacher:7:1',?,?)`).run(now,now);
  db.prepare(`INSERT INTO runtime_task_versions
    (id,plan_id,version_no,status,source_analysis_run_id,source_batch_id,source_evidence_json,stratification_snapshot_json,task_content_json,weakest_knowledge_point,due_at,content_digest,draft_source,created_by_context,created_at,updated_at,published_at,published_by_context,publish_client_request_id)
    VALUES ('m5_version','m5_plan',1,'published','m5_analysis','m5_batch','{}','{}',?,'智能体与搜索',?,'digest','analysis_template','teacher:7:1',?,?,?,'teacher:7:1','m5-publish')`).run(
      JSON.stringify({extension:{title:'拓展任务',detail:'完成案例',durationMinutes:30}}),new Date(Date.now()+86400000).toISOString(),now,now,now);
  db.prepare(`INSERT INTO runtime_task_assignments
    (id,task_version_id,student_id,student_no,tier_code,assigned_reason,completion_status,completed_at,feedback_text,feedback_redacted,completion_client_request_id,created_at,updated_at)
    VALUES ('m5_assignment','m5_version',1,'S240101','extension','本轮分层','completed',?,'反馈手机号 13912345678',1,'m5-complete',?,?)`).run(now,now,now);
  db.close();
}

test('M5-T01～T50 受控导出与异常降级',async t=>{
  const baselineBefore=await hashFile(BASELINE),dir=await mkdtemp(join(tmpdir(),'zhixue-m5-')),runtime=join(dir,'runtime.sqlite');
  let server,base;
  async function start(path=runtime,exportOptions){server=createZhixueServer({runtimeDbPath:path,exportOptions});await new Promise(done=>server.listen(0,'127.0.0.1',done));base=`http://127.0.0.1:${server.address().port}`}
  async function stop(){if(server)await new Promise(done=>server.close(done));server=null}
  async function login(role='teacher'){
    const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({account:role==='teacher'?'teacher2026':'student2026',password:'demo123',requestedRole:role})});
    const body=await response.json();return{cookie:(response.headers.get('set-cookie')||'').split(';')[0],csrf:body.data.csrfToken,role};
  }
  async function call(auth,{kind='questions',format='json',scope={context:'teacher:7:1'}}={},options={}){
    const headers=new Headers({'content-type':'application/json',...(options.headers||{})});if(auth?.cookie)headers.set('cookie',auth.cookie);if(auth?.csrf&&!options.noCsrf)headers.set('x-csrf-token',auth.csrf);
    const response=await fetch(base+'/api/export',{method:'POST',headers,body:JSON.stringify({kind,format,scope,...(options.extra||{})})});const bytes=Buffer.from(await response.arrayBuffer());let json=null;try{json=JSON.parse(bytes.toString('utf8'))}catch{}return{response,status:response.status,bytes,text:bytes.toString('utf8'),json};
  }
  async function isolated(exportOptions,fn){await stop();const path=join(dir,`isolated-${randomUUID()}.sqlite`);await start(path,exportOptions);const auth=await login('teacher');try{return await fn(auth,path)}finally{await stop();await start(runtime)}}
  try{
    await start();seed(runtime);const teacher=await login('teacher'),student=await login('student');let report,questions,studentFile;
    await t.test('M5-T01 未登录正式导出',async()=>{const r=await call(null);assert.equal(r.status,401);assert.equal(r.json.code,'AUTH_REQUIRED')});
    await t.test('M5-T02 旧 GET 被拒绝',async()=>{const r=await fetch(base+'/api/export?kind=report');assert.equal(r.status,405);assert.equal(r.headers.get('allow'),'POST')});
    await t.test('M5-T03 缺 CSRF',async()=>{const r=await call(teacher,{}, {noCsrf:true});assert.equal(r.status,403);assert.equal(r.json.code,'AUTH_CSRF_INVALID')});
    await t.test('M5-T04 教师合法 report JSON',async()=>{report=await call(teacher,{kind:'report'});assert.equal(report.status,200);assert.match(report.response.headers.get('content-disposition'),/attachment/);assert.ok(report.response.headers.get('x-zhixue-export-id'));assert.ok(report.response.headers.get('x-zhixue-watermark'))});
    await t.test('M5-T05 教师越权 context',async()=>{const r=await call(teacher,{scope:{context:'teacher:1:1'}});assert.equal(r.status,403)});
    await t.test('M5-T06 学生不能导 teacher report',async()=>{const r=await call(student,{kind:'report',scope:{}});assert.equal(r.status,403);assert.equal(r.json.code,'EXPORT_KIND_FORBIDDEN')});
    await t.test('M5-T07 student learning-record 成功',async()=>{studentFile=await call(student,{kind:'learning-record',scope:{}});assert.equal(studentFile.status,200);assert.equal(studentFile.json.student.studentRef,'S24***01')});
    await t.test('M5-T08 student offering 越权',async()=>{const r=await call(student,{kind:'learning-record',scope:{offeringId:9999}});assert.equal(r.status,403)});
    await t.test('M5-T09 Teacher report 不含学生列表',()=>{assert.doesNotMatch(report.text,/S24010[123]/)});
    await t.test('M5-T10 Teacher report 不含 display_name',()=>{assert.doesNotMatch(report.text,/display_name|学生001/)});
    await t.test('M5-T11 Teacher questions studentRef 已遮罩',async()=>{questions=await call(teacher);assert.equal(questions.json.questions[0].studentRef,'S24***01');assert.doesNotMatch(questions.text,/S240101/)});
    await t.test('M5-T12 自由文本手机号脱敏',()=>{assert.doesNotMatch(questions.text,/13812345678/);assert.match(questions.text,/手机号已脱敏/)});
    await t.test('M5-T13 邮箱脱敏',()=>{assert.doesNotMatch(questions.text,/m5@example\.com|m5-teacher@example\.com/);assert.match(questions.text,/邮箱已脱敏/)});
    await t.test('M5-T14 证件号脱敏',()=>{assert.doesNotMatch(questions.text,/11010519491231002X/);assert.match(questions.text,/证件号已脱敏/)});
    await t.test('M5-T15 历史 raw studentNo 二次脱敏',()=>{assert.doesNotMatch(questions.text,/S240101/);assert.match(questions.text,/匿名学生/)});
    await t.test('M5-T16 敏感 key 注入 fail closed',async()=>{await isolated({transformDto:dto=>({...dto,student_id:1})},async auth=>{const r=await call(auth);assert.equal(r.status,500);assert.equal(r.json.code,'EXPORT_REDACTION_FAILED')})});
    await t.test('M5-T17 watermark 内容/header/audit 一致',()=>{const id=report.response.headers.get('x-zhixue-watermark');assert.equal(report.json.exportMeta.watermarkId,id);const db=new DatabaseSync(runtime);assert.equal(db.prepare('SELECT watermark_id FROM runtime_export_audits WHERE export_id=?').get(report.json.exportMeta.exportId).watermark_id,id);db.close()});
    await t.test('M5-T18 exportId 内容/header/audit 一致',()=>{const id=report.response.headers.get('x-zhixue-export-id');assert.equal(report.json.exportMeta.exportId,id);const db=new DatabaseSync(runtime);assert.equal(db.prepare('SELECT export_id FROM runtime_export_audits WHERE export_id=?').get(id).export_id,id);db.close()});
    await t.test('M5-T19 content digest 正确',()=>{const id=report.json.exportMeta.exportId,digest='sha256:'+createHash('sha256').update(report.bytes).digest('hex');const db=new DatabaseSync(runtime);assert.equal(db.prepare('SELECT content_digest FROM runtime_export_audits WHERE export_id=?').get(id).content_digest,digest);db.close()});
    await t.test('M5-T20 audit 不保存正文',()=>{const db=new DatabaseSync(runtime);const row=db.prepare('SELECT * FROM runtime_export_audits WHERE export_id=?').get(questions.json.exportMeta.exportId);db.close();const text=JSON.stringify(row);assert.doesNotMatch(text,/HYPERLINK|教师回复|13912345678|feedback/)});
    await t.test('M5-T21 strict audit failure',async()=>{await isolated({auditWriter:()=>{throw new Error('audit down')}},async auth=>{const r=await call(auth);assert.equal(r.status,503);assert.equal(r.json.code,'EXPORT_AUDIT_UNAVAILABLE')})});
    await t.test('M5-T22 formatter failure',async()=>{await isolated({serializer:()=>{throw new Error('format fail')}},async auth=>{const r=await call(auth);assert.equal(r.status,500);assert.equal(r.json.code,'EXPORT_SERIALIZATION_FAILED')})});
    await t.test('M5-T23 CSV 公式注入',async()=>{const r=await call(teacher,{format:'csv'});assert.equal(r.status,200);assert.match(r.text,/'=HYPERLINK/);assert.doesNotMatch(r.text,/\r\n[^\r\n,]*,=HYPERLINK/)});
    await t.test('M5-T24 Excel 公式注入',async()=>{const r=await call(teacher,{format:'excel'});assert.equal(r.status,200);assert.match(r.text,/&apos;=HYPERLINK/)});
    await t.test('M5-T25 Print XSS',async()=>{const r=await call(teacher,{format:'print'});assert.equal(r.status,200);assert.doesNotMatch(r.text,/<script>globalThis\.pwned/);assert.match(r.text,/&lt;script&gt;globalThis\.pwned/)});
    await t.test('M5-T26 Print 有可视水印',async()=>{const r=await call(teacher,{format:'print'});assert.match(r.text,new RegExp(r.response.headers.get('x-zhixue-watermark')));assert.match(r.text,/合成演示/)});
    await t.test('M5-T27 CSV 有元数据',async()=>{const r=await call(teacher,{format:'csv'});assert.match(r.text,/导出编号/);assert.match(r.text,/水印编号/);assert.match(r.text,/数据性质/)});
    await t.test('M5-T28 Excel 有元数据',async()=>{const r=await call(teacher,{format:'excel'});assert.match(r.text,/导出编号/);assert.match(r.text,/水印编号/);assert.match(r.text,/合成演示/)});
    await t.test('M5-T29 输出超过 5 MiB',async()=>{await isolated({transformDto:dto=>({...dto,safeNotes:'A'.repeat(5*1024*1024)})},async(auth,path)=>{const r=await call(auth);assert.equal(r.status,413);assert.equal(r.json.code,'EXPORT_TOO_LARGE');const db=new DatabaseSync(path);assert.equal(db.prepare("SELECT result FROM runtime_export_audits WHERE failure_code='EXPORT_TOO_LARGE'").get().result,'failed');db.close()})});
    await t.test('M5-T30 正式导出不落文件',async()=>{const files=await readdir(ROOT,{recursive:true});assert.ok(!files.some(name=>/^zhixue-(report|questions|review|learning-record)-\d{8}-[A-F0-9]{8}\.(json|csv|xls|html)$/.test(name)))});
    await t.test('M5-T31 教师前端 403 不 fallback',async()=>{const src=await readFile(join(ROOT,'assets','export-client.js'),'utf8');assert.match(src,/本次未生成文件/);assert.doesNotMatch(src,/JSON\.stringify\(state|state\.questions/)});
    await t.test('M5-T32 教师前端 503 不 fallback',async()=>{const src=await readFile(join(ROOT,'assets','export-client.js'),'utf8');assert.match(src,/本地导出服务不可用，正式数据未下载/);assert.doesNotMatch(src,/public-export-demo[^\n]+\.click/)});
    await t.test('M5-T33 学生导出不再直接下载 state',async()=>{const app=await readFile(join(ROOT,'assets','app.js'),'utf8'),client=await readFile(join(ROOT,'assets','export-client.js'),'utf8');assert.doesNotMatch(app,/exportStudentData[^\n]+JSON\.stringify/);assert.match(client,/open\('learning-record'\)/);assert.match(client,/kind:activeKind/)});
    await t.test('M5-T34 公开 sample 与 runtime 无关',async()=>{const path=join(ROOT,'assets','samples','public-export-demo.json'),before=await readFile(path,'utf8');const db=new DatabaseSync(runtime);db.prepare("UPDATE runtime_qa_records SET question_text_redacted='changed' WHERE id='m5_qa'").run();db.close();assert.equal(await readFile(path,'utf8'),before)});
    await t.test('M5-T35 公开 sample 无 actor 标识',async()=>{for(const name of ['public-export-demo.json','public-export-demo.csv']){const text=await readFile(join(ROOT,'assets','samples',name),'utf8');assert.doesNotMatch(text,/teacher:|student:S|S\d{6,}|T\d{4,}|1[3-9]\d{9}|@[A-Z0-9.-]+\.[A-Z]{2,}/i);assert.match(text,/公开合成样例/)}});
    await t.test('M5-T36 公开版正式 export fail closed',async()=>{const r=await worker.fetch(new Request('https://demo.invalid/api/export',{method:'POST'}),{});assert.equal(r.status,501);assert.equal((await r.json()).code,'EXPORT_NOT_AVAILABLE_IN_PUBLIC_DEMO')});
    await t.test('M5-T37 runtime DB 不静态暴露',async()=>{assert.equal((await fetch(base+'/data/runtime/zhixue_runtime.sqlite')).status,404)});
    await t.test('M5-T38 audit JSONL 不暴露',async()=>{assert.equal((await fetch(base+'/data/runtime/audit.jsonl')).status,404)});
    await t.test('M5-T39 baseline DB 不变',async()=>{assert.equal(await hashFile(BASELINE),baselineBefore)});
    await t.test('M5-T40 M1/M2/M3/M4 回归门禁已纳入',async()=>{const pkg=JSON.parse(await readFile(join(ROOT,'package.json'),'utf8'));assert.match(pkg.scripts.test,/m1-course-qa|m2-import-analysis|m3-task-loop|m4-auth-permissions/)});
    await t.test('M5-T41 protected response no-store',()=>{assert.match(report.response.headers.get('cache-control')||'',/private/);assert.match(report.response.headers.get('cache-control')||'',/no-store/)});
    await t.test('M5-T42 Content-Disposition 安全',()=>{const value=report.response.headers.get('content-disposition');assert.match(value,/^attachment; filename="zhixue-report-\d{8}-[A-F0-9]{8}\.json"$/);assert.doesNotMatch(value,/人工智能|班级|S240101|[\r\n]/)});
    await t.test('M5-T43 invalid format',async()=>{const r=await call(teacher,{format:'pdf'});assert.equal(r.status,400);assert.equal(r.json.code,'EXPORT_FORMAT_INVALID')});
    await t.test('M5-T44 invalid kind',async()=>{const r=await call(teacher,{kind:'all-data'});assert.equal(r.status,400);assert.equal(r.json.code,'EXPORT_KIND_INVALID')});
    await t.test('M5-T45 audited scope 正确',async()=>{const db=new DatabaseSync(runtime);const teacherAudit=db.prepare('SELECT scope_ref FROM runtime_export_audits WHERE export_id=?').get(report.json.exportMeta.exportId);const studentAudit=db.prepare('SELECT scope_ref FROM runtime_export_audits WHERE export_id=?').get(studentFile.json.exportMeta.exportId);db.close();assert.equal(teacherAudit.scope_ref,'teacher:7:1');assert.equal(studentAudit.scope_ref,'self')});
    await t.test('M5-T46 audit 先于响应完成',()=>{const db=new DatabaseSync(runtime);assert.ok(db.prepare('SELECT created_at FROM runtime_export_audits WHERE export_id=?').get(report.json.exportMeta.exportId));db.close()});
    await t.test('M5-T47 无 analysis 不使用静态 fallback',async()=>{const r=await call(teacher,{kind:'report',scope:{context:'teacher:7:5'}});assert.equal(r.status,404);assert.equal(r.json.code,'EXPORT_DATA_NOT_FOUND')});
    await t.test('M5-T48 questions 空记录是合法空文件',async()=>{const r=await call(teacher,{kind:'questions',scope:{context:'teacher:7:5'}});assert.equal(r.status,200);assert.deepEqual(r.json.questions,[]);assert.equal(r.json.exportMeta.recordCount,0)});
    await t.test('M5-T49 review 不含 raw feedback',async()=>{const r=await call(teacher,{kind:'review'});assert.equal(r.status,200);assert.doesNotMatch(r.text,/13912345678|feedback_text|反馈手机号/);assert.ok(r.json.taskReview)});
    await t.test('M5-T50 student file 不含 teacher private data',()=>{assert.doesNotMatch(studentFile.text,/teachingSuggestions|individualGuidance|student_stratification|S24010[23]/)});
  }finally{await stop();const safe=resolve(dir);if(!safe.startsWith(`${resolve(tmpdir())}${sep}`)||!safe.includes('zhixue-m5-'))throw new Error('拒绝清理非测试目录');await rm(safe,{recursive:true,force:true})}
});
