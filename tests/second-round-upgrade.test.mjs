import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createZhixueServer } from "../server/local-api.mjs";
import { createAuthenticatedFetch } from "./auth-test-helper.mjs";

async function withServer(run) {
  const server=createZhixueServer({runtimeDbPath:":memory:"});
  await new Promise(done=>server.listen(0,"127.0.0.1",done));
  const base=`http://127.0.0.1:${server.address().port}`,fetch=createAuthenticatedFetch(base);
  const call=async(path,method="GET",body)=>{const response=await fetch(base+path,{method,headers:body?{"content-type":"application/json"}:undefined,body:body?JSON.stringify(body):undefined});let payload;try{payload=await response.json()}catch{payload=null}return{response,payload}};
  try{await run({base,fetch,call})}finally{await new Promise(done=>server.close(done))}
}

test("第二轮：教师直读、只读观察、共享设置和个人计划闭环",async()=>withServer(async({call})=>{
  const list=await call("/api/teacher/classes/1/students?offeringId=7");
  assert.equal(list.response.status,200);assert.ok(list.payload.data.length>10);assert.ok(list.payload.data.every(x=>x.studentNo&&Array.isArray(x.weakPoints)));
  const observed=await call("/api/teacher/students/S240101/observation?context=teacher%3A7%3A1");
  assert.equal(observed.response.status,200);assert.equal(observed.payload.data.mode,"teacher_observation_readonly");assert.equal(observed.payload.data.permissions.canWriteStudentData,false);assert.equal(observed.payload.data.shared.optional.qaContent,null);
  const denied=await call("/api/teacher/students/S240061/observation?context=teacher%3A7%3A1");
  assert.equal(denied.response.status,403);
  const sharing=await call("/api/student/sharing-preferences","PUT",{offeringId:7,behaviorDetails:true,answerText:false,qaContent:true,goalsPreferences:true});
  assert.equal(sharing.response.status,200);assert.equal(sharing.payload.data.qaContent,true);
  const observedAfter=await call("/api/teacher/students/S240101/observation?context=teacher%3A7%3A1");
  assert.notEqual(observedAfter.payload.data.shared.optional.qaContent,null);
  const draft=await call("/api/teacher/students/S240101/plans/drafts","POST",{context:"teacher:7:1"});
  assert.equal(draft.response.status,200);assert.equal(draft.payload.data.status,"draft");assert.ok(draft.payload.data.tasks.length>=3);
  const published=await call(`/api/plans/${draft.payload.data.planId}/publish`,"POST",{context:"teacher:7:1"});
  assert.equal(published.response.status,200);assert.equal(published.payload.data.status,"published");
  const active=await call("/api/student/plans/active?offeringId=7");
  assert.equal(active.response.status,200);assert.equal(active.payload.data[0].planId,draft.payload.data.planId);
}));

test("第二轮：会话问答支持 K0/K1、追问和显式转教师",async()=>withServer(async({call})=>{
  const session=await call("/api/qa/sessions","POST",{studentContext:"student:S240101",offeringId:7,title:"公共基础测试"});
  assert.equal(session.response.status,201);const sessionId=session.payload.data.sessionId;
  const ask=question=>call(`/api/qa/sessions/${sessionId}/messages`,"POST",{studentContext:"student:S240101",offeringId:7,question,clientRequestId:randomUUID()});
  const arithmetic=await ask("1+1等于几？为什么？");assert.equal(arithmetic.payload.data.answer_status,"已解答");assert.match(arithmetic.payload.data.answer_content,/= 2/);assert.match(arithmetic.payload.data.answer_content,/加法表示/);assert.equal(arithmetic.payload.data.answer_source_type,"通用基础知识");
  const cs=await ask("栈和队列有什么区别？");assert.equal(cs.payload.data.answer_status,"已解答");assert.equal(cs.payload.data.answer_source_type,"计算机公共基础");
  const follow=await ask("为什么？");assert.equal(follow.payload.data.answer_status,"已解答");assert.equal(follow.payload.data.session_id,sessionId);
  const unknown=await ask("请说明课程里完全不存在的量子菜谱定理");assert.equal(unknown.payload.data.answer_status,"建议转教师");assert.equal(unknown.payload.data.handoff.created,false);
  const before=await call("/api/qa/teacher-inbox?context=teacher%3A7%3A1");assert.equal(before.payload.data.filter(x=>x.questionId===unknown.payload.data.questionId&&x.status==='pending_teacher').length,0);
  const transfer=await call(`/api/qa/${unknown.payload.data.questionId}/handoff`,"POST",{studentContext:"student:S240101"});assert.equal(transfer.response.status,200);assert.equal(transfer.payload.data.answer_status,"已转教师");
  const after=await call("/api/qa/teacher-inbox?context=teacher%3A7%3A1");assert.equal(after.payload.data.filter(x=>x.questionId===unknown.payload.data.questionId&&x.status==='pending_teacher').length,1);
}));
