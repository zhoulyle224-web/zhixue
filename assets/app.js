const PAGE = document.body.dataset.page || 'home';
const authAccounts = {
  teacher:{account:'teacher2026',password:'demo123',name:'演示教师',target:'teacher.html'},
  student:{account:'student2026',password:'demo123',name:'演示学生',target:'student.html'}
};

let currentAuth=null;
async function protectWorkspace(){
  if(!['teacher','student'].includes(PAGE))return;
  try{currentAuth=await window.ZhixueApi.me()}catch{location.replace(`login.html?role=${PAGE}&next=${PAGE}.html`);return}
  if(currentAuth.role!==PAGE){location.replace(`login.html?role=${PAGE}&next=${PAGE}.html`);return}
  document.body.classList.remove('auth-pending');
  const identity=document.querySelector('#userIdentity');if(identity)identity.textContent=currentAuth.displayName;
  const switchBtn=document.querySelector('#roleSwitchBtn');
  if(switchBtn)switchBtn.hidden=false;
}
const workspaceReady=protectWorkspace();

const KEY = 'zhixue_learning_loop_v2';
const seed = {
  courses: [
    {id:'ai',name:'人工智能导论',code:'AI2026',color:'#7658ef',classes:[{id:'ai-1',name:'一班',students:36,imported:true},{id:'ai-2',name:'二班',students:32,imported:false}]},
    {id:'ds',name:'数据结构',code:'DS2026',color:'#29a9ce',classes:[{id:'ds-1',name:'实验班',students:28,imported:true}]}
  ],
  joined:['ai'], activeCourse:'ai', activeClass:'ai-1', imported:true, published:true,
  questions:[
    {id:'q-demo',courseId:'ai',text:'精确率和召回率应该怎么选择？',status:'done',answer:'先判断错误代价：漏判代价高时优先召回率，误判代价高时优先精确率。',created:'2026-08-24T10:20:00',source:'第 4 章讲义 22–24 页'}
  ],
  tasks:[
    {id:'t1',courseId:'ai',tier:'巩固组',title:'评价指标概念微课',detail:'观看 8 分钟微课，完成 5 个概念配对。',duration:'15 分钟',done:true},
    {id:'t2',courseId:'ai',tier:'巩固组',title:'混淆矩阵基础练习',detail:'完成 3 道基础计算题，并标注 TP、FP、FN、TN。',duration:'20 分钟',done:false},
    {id:'t3',courseId:'ai',tier:'巩固组',title:'提交仍不理解的一点',detail:'用自己的话描述一个困惑，课程助手会给出资料依据。',duration:'10 分钟',done:false}
  ]
};

let state = loadState();
let activeFilter = 'all';
let knowledge = [];
let studentKnowledge = [];

function clone(x){return JSON.parse(JSON.stringify(x))}
function loadState(){const base=clone(seed);try{const saved=JSON.parse(localStorage.getItem(KEY));if(typeof saved?.activeCourse==='string')base.activeCourse=saved.activeCourse;if(typeof saved?.activeClass==='string')base.activeClass=saved.activeClass}catch{}return base}
function saveState(){localStorage.setItem(KEY,JSON.stringify({activeCourse:state.activeCourse,activeClass:state.activeClass}));renderAll()}
function esc(s=''){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function toast(text){const box=document.querySelector('.toast');if(!box)return;box.textContent=text;box.classList.add('show');clearTimeout(window.__toast);window.__toast=setTimeout(()=>box.classList.remove('show'),2400)}
function course(){return state.courses.find(x=>x.id===state.activeCourse)||state.courses[0]}
function currentClass(){const c=course();return c?.classes.find(x=>x.id===state.activeClass)||c?.classes[0]}
function empty(title,desc){return `<div class="empty"><b>${title}</b>${desc}</div>`}
function download(name,content,type='application/json'){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}

let databasePayload=null;
let activeStudentDashboard=null;
let activeStudentCourse=null;
let studentTaskState={tasks:[],history:[],done:0,total:0,rate:0};
let teacherDashboardData=null;
let teacherTaskState={version:null,versions:[]};
let teacherStudents=[],selectedObservation=null,personalPlanDraft=null,sharingPreferences=null;
let m2State={context:'',batch:null,analysisBatch:null,analysis:null,analysisRunId:null,issues:[],preview:[],qualityOverride:null,error:'',busy:false,offline:false};
let m2Token=0;
let m2RequestToken=0;
function setText(selector,value){const el=document.querySelector(selector);if(el&&value!==undefined&&value!==null)el.textContent=value}
function setDatabaseStatus(mode,meta={}){const el=document.querySelector('#databaseStatus');if(!el)return;el.classList.remove('loading','fallback');if(mode==='local'){el.textContent=`● 本地 SQLite · ${Number(meta.recordCount||0).toLocaleString()} 条`;el.title=`本地只读数据库，共 ${meta.tableCount||0} 类业务表，断网可用`}else if(mode==='database'){el.textContent=`● 云端数据库 · ${Number(meta.recordCount||0).toLocaleString()} 条`;el.title=`D1 数据源，${meta.tableCount||0} 类业务表`}else if(mode==='fallback'){el.classList.add('fallback');el.textContent='● 数据服务未连接';el.title='旧数字已清空；请启动完整 Node 服务并刷新页面'}else{el.classList.add('loading');el.innerHTML='<i></i>数据库连接中'}}
function databaseCourses(catalog){const map=new Map();catalog.forEach(row=>{const id=`db-${row.offering_id}`;if(!map.has(id))map.set(id,{id,name:row.course_name,code:row.course_code,color:['#7658ef','#29a9ce','#617fff','#2ccf91'][row.offering_id%4],offeringId:row.offering_id,classes:[]});map.get(id).classes.push({id:`db-${row.class_id}`,classId:row.class_id,name:row.class_name,students:row.student_count,imported:true,contextKey:`teacher:${row.offering_id}:${row.class_id}`})});return [...map.values()]}
async function fetchDatabase(path){const response=await window.ZhixueApi.apiFetch(path);if(!response.ok)throw new Error(`HTTP ${response.status}`);const payload=await response.json();if(!payload.success)throw new Error(payload.message||payload.error||'database_error');return payload}
function currentContextKey(){return currentClass()?.contextKey||''}
window.ZhixueExportScope={current(){if(PAGE==='teacher')return{context:currentContextKey(),courseName:course()?.name||'当前课程',rangeLabel:'当前授权班级'};if(PAGE==='student')return{offeringId:course()?.offeringId,courseName:course()?.name||'当前课程',rangeLabel:'本人授权范围'};return{}}};
async function loadTeacherDashboard(){if(PAGE!=='teacher')return;const key=currentContextKey(),token=++m2Token;++m2RequestToken;window.ZhixueQaClient?.setTeacherContext(key);m2State={context:key,batch:null,analysisBatch:null,analysis:null,analysisRunId:null,issues:[],preview:[],qualityOverride:null,error:'',busy:false,offline:false};teacherDashboardData=null;teacherTaskState={version:null,versions:[]};knowledge=[];for(const [selector,value] of [['#studentCount','--'],['#masteryAvg','--'],['#weakCount','--'],['#tierTotal','--'],['#tierA','--'],['#tierB','--'],['#tierC','--']])setText(selector,value);resetM2Visuals();renderAll();if(!key){setText('#qualitySummary','请先选择数据库中的课程和班级');return}let data;try{data=(await fetchDatabase(`/api/dashboard?audience=teacher&context=${encodeURIComponent(key)}`)).data}catch(error){if(token===m2Token)toast(`${error.message||'班级数据加载失败'}；页面已清空旧数字，请重试。`);return}if(token!==m2Token)return;if(data){teacherDashboardData=data;knowledge=data.knowledge||[];renderAll();setText('#studentCount',data.studentCount);setText('#masteryAvg',`${data.averageMastery}%`);setText('#weakCount',data.weakCount);setText('#classAverage',data.averageScore);setText('#classPassRate',`${data.passRate}%`);setText('#classAttendance',`${data.attendanceRate}%`);setText('#classRiskCount',data.riskCount);setText('#tierTotal',data.studentCount);setText('#tierA',data.tiers?.['拓展组']??0);setText('#tierB',data.tiers?.['提升组']??0);setText('#tierC',data.tiers?.['巩固组']??0);const topics=document.querySelector('#databaseHotTopics');if(topics)topics.innerHTML=(data.hotTopics||[]).map(x=>`<span>${esc(x.name)} <b>${x.count}</b></span>`).join('')||'<span>暂无答疑记录</span>'}await restoreM2(key,token);renderTeacherLiveState();window.ZhixueTaskClient?.setTeacherContext(key,m2State.analysisRunId)}
function valueText(value,suffix='',digits=null){if(value===null||value===undefined||value==='')return'--';const number=Number(value);if(!Number.isFinite(number))return'--';return`${digits===null?number:number.toFixed(digits)}${suffix}`}
function applyStudentCourse(courseId){if(!activeStudentDashboard)return;const selected=activeStudentDashboard.courses.find(x=>x.id===courseId)||activeStudentDashboard.courses[0];if(!selected)return;activeStudentCourse=selected;studentTaskState={tasks:[],history:[],done:0,total:0,rate:0};studentKnowledge=selected.knowledge||[];setText('#studentTier',selected.tier||'--');setText('#studentMastery',valueText(selected.mastery,'%'));setText('#studentScore',valueText(selected.score,'',1));setText('#studentPendingTasks','--');setText('#studentProgress','--');renderStudentLiveState();window.ZhixueQaClient?.setStudentCourse({offeringId:selected.offering_id,name:selected.course_name});window.ZhixueTaskClient?.setStudentCourse(selected.offering_id);void loadActivePersonalPlan();if(currentView()==='sharing')void loadSharingPreferences();renderAll()}
async function loadFrontendDatabase(){if(!['teacher','student'].includes(PAGE))return;setDatabaseStatus('loading');let catalogData;try{catalogData=(await fetchDatabase('/api/catalog')).data}catch(error){state.courses=[];knowledge=[];studentKnowledge=[];renderAll();setDatabaseStatus('fallback');toast(`${error.message||'受保护数据加载失败'}；当前未显示缓存数字，请启动服务后重试。`);return}databasePayload={meta:catalogData.meta,catalog:catalogData.catalog};const meta=catalogData.meta||{};setDatabaseStatus('local',meta);const route=readWorkspaceRoute();if(PAGE==='teacher'){state.courses=databaseCourses(catalogData.catalog||[]);const preferred=state.courses.find(x=>x.name==='人工智能导论')||state.courses[0],routeCourse=route.params?.get('course');if(routeCourse&&state.courses.some(x=>x.id===routeCourse))state.activeCourse=routeCourse;else if(!state.courses.some(x=>x.id===state.activeCourse))state.activeCourse=preferred?.id||'';const c=course(),routeClass=route.params?.get('class');if(routeClass&&c?.classes.some(x=>x.id===routeClass))state.activeClass=routeClass;else if(!c?.classes.some(x=>x.id===state.activeClass))state.activeClass=c?.classes[0]?.id||'';renderAll();await loadTeacherDashboard()}else{const ownContext=`student:${currentAuth?.actorRefCode||'S240101'}`;let data;try{data=(await fetchDatabase(`/api/dashboard?audience=student&context=${encodeURIComponent(ownContext)}`)).data}catch(error){state.courses=[];studentKnowledge=[];renderAll();toast(`${error.message||'个人学习数据加载失败'}；当前未显示缓存数字，请重试。`);return}if(!data)return;activeStudentDashboard=data;state.courses=(data.courses||[]).map(x=>({id:x.id,name:x.course_name,code:x.course_code,offeringId:x.offering_id,color:['#7658ef','#29a9ce','#617fff','#2ccf91'][x.offering_id%4],classes:[{id:`student-${x.offering_id}`,name:data.student.class_name,students:1,imported:true}]}));state.joined=state.courses.map(x=>x.id);const preferred=data.courses.find(x=>x.course_name==='人工智能导论')||data.courses[0],routeCourse=route.params?.get('course');if(routeCourse&&state.courses.some(x=>x.id===routeCourse))state.activeCourse=routeCourse;else if(!state.courses.some(x=>x.id===state.activeCourse))state.activeCourse=preferred?.id||'';state.activeClass=course()?.classes[0]?.id||'';setText('#userIdentity',`${data.student.display_name} · 演示账号`);applyStudentCourse(state.activeCourse)}}

function renderTeacherLiveState(){
  const actions=document.querySelector('#teacherNextActions'),timeline=document.querySelector('#teacherTimeline');
  if(!actions&&!timeline)return;
  const items=[];
  const batch=m2State.batch,analysis=m2State.analysis,quality=batch?.quality||{validRows:0,invalidRows:0,warningRows:0};
  if(!batch)items.push({view:'students',title:'查看班级与学生数据',detail:'直接读取 SQLite 中的当前教学班，不需要上传文件。'});
  else if(batch.status==='validated')items.push({view:'students',title:'查看当前班级学生',detail:'历史补录批次仍保留；日常分析以标准业务表为准。'});
  else if(!analysis)items.push({view:'analysis',title:'运行当前批次研判',detail:`批次 ${batch.batchId} 已确认，等待生成固定研判。`});
  if(analysis){
    const weakest=analysis.weakest_knowledge_point||analysis.knowledge_analysis?.slice().sort((a,b)=>(Number(a.mastery_rate)||0)-(Number(b.mastery_rate)||0))[0]?.knowledge_point;
    items.push({view:'analysis',title:`复核薄弱点${weakest?`“${weakest}”`:''}`,detail:`研判 ${m2State.analysisRunId||'已生成'}，所有建议仍需教师确认。`});
    items.push({view:'tasks',title:teacherTaskState.version?.status==='published'?'查看已发布任务反馈':'确认并发布分层任务',detail:teacherTaskState.version?`当前版本 v${teacherTaskState.version.versionNo} · ${teacherTaskState.version.status}`:'正在读取服务端任务版本。'});
  }
  if(!items.length&&teacherDashboardData)items.push({view:'analysis',title:'查看当前班级快照',detail:`${teacherDashboardData.studentCount} 名学生，${teacherDashboardData.weakCount} 个薄弱知识点。`});
  if(actions)actions.innerHTML=items.length?items.slice(0,3).map((item,index)=>`<button onclick="openView('${item.view}')"><b>${index+1}</b><span><strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small></span><i>→</i></button>`).join(''):'<p class="data-empty">当前无待处理事项</p>';
  if(timeline){
    const events=[];
    if(batch)events.push({time:batch.createdAt,label:'导入并质检数据',detail:`有效 ${quality.validRows} 行，排除 ${quality.invalidRows} 行。`});
    if(batch?.confirmedAt)events.push({time:batch.confirmedAt,label:'教师确认批次',detail:`批次 ${batch.batchId} 已确认。`});
    if(analysis)events.push({time:analysis._evidence?.generatedAt||analysis._evidence?.analyzedAt,label:'完成学情研判',detail:`研判 ${m2State.analysisRunId||'已生成'}。`});
    for(const version of teacherTaskState.versions||[]){if(version.publishedAt)events.push({time:version.publishedAt,label:`发布任务 v${version.versionNo}`,detail:`状态：${version.status}`})}
    events.sort((a,b)=>new Date(a.time||0)-new Date(b.time||0));
    timeline.innerHTML=events.length?events.map(event=>`<div><i></i><b>${esc(event.time?new Date(event.time).toLocaleString('zh-CN'):'时间未记录')} · ${esc(event.label)}</b><p>${esc(event.detail)}</p></div>`).join(''):'<p class="data-empty">暂无当前批次数据</p>';
  }
}

function renderStudentLiveState(){
  const selected=activeStudentCourse;if(!selected)return;
  const points=[...(selected.knowledge||[])].sort((a,b)=>(Number(a.value)||0)-(Number(b.value)||0));
  const weakest=points[0],strongest=points[points.length-1];
  setText('#studentPriority',weakest?`优先巩固“${weakest.name}”`:'暂无当前课程画像');
  setText('#studentPriorityEvidence',weakest?`当前课程快照掌握度 ${weakest.value}%；请结合教师发布任务继续学习。`:'当前课程没有可用知识点数据。');
  const diagnosis=document.querySelector('#studentDiagnosis');
  if(diagnosis)diagnosis.innerHTML=points.length?[points[0],points[Math.min(1,points.length-1)],strongest].map((point,index)=>`<div class="diagnosis-item ${index===0?'danger':index===2?'success':''}"><b>${index===0?'优先补强':index===2?'优势知识点':'继续巩固'}</b><strong>${esc(point.name)} · ${Number(point.value)||0}%</strong><p>来源：当前课程合成演示快照；趋势 ${esc(point.trend||'暂无')}。</p></div>`).join(''):'<p class="data-empty">暂无当前课程画像</p>';
  const evidence=document.querySelector('#studentEvidence');
  if(evidence)evidence.innerHTML=`<div><span>课程成绩</span><b>${valueText(selected.score,'',1)}</b><small>当前课程快照</small></div><div><span>综合掌握度</span><b>${valueText(selected.mastery,'%')}</b><small>当前课程快照</small></div><div><span>课堂出勤率</span><b>${valueText(selected.attendanceRate,'%')}</b><small>当前课程快照</small></div><div><span>当前任务</span><b>${studentTaskState.done} / ${studentTaskState.total}</b><small>服务端运行记录</small></div>`;
  const path=document.querySelector('#studentLearningPath'),tasks=studentTaskState.tasks||[];
  if(path)path.innerHTML=tasks.length?tasks.map((task,index)=>`<button onclick="openView('studentTasks')"><i class="${task.completionStatus==='completed'?'done':'active'}">${task.completionStatus==='completed'?'✓':index+1}</i><span><b>${esc(task.title)}</b><small>${task.completionStatus==='completed'?'已完成':'待完成'} · 截止 ${esc(new Date(task.dueAt).toLocaleDateString('zh-CN'))}</small></span></button>`).join(''):'<p class="data-empty">当前课程暂无教师发布任务</p>';
  const status=document.querySelector('#studentCurrentStatus');
  if(status)status.innerHTML=`<div><span>综合掌握度</span><b>${valueText(selected.mastery,'%')}</b></div><div><span>当前任务完成</span><b>${studentTaskState.done} / ${studentTaskState.total}</b></div><div><span>课程答疑记录</span><b>${selected.qa?.length??0} 条</b></div><div><span>错题记录</span><b>${valueText(selected.wrongCount,' 条')}</b></div>`;
}

addEventListener('zhixue:student-task-state',event=>{studentTaskState=event.detail||studentTaskState;renderStudentLiveState()});
addEventListener('zhixue:teacher-task-state',event=>{teacherTaskState=event.detail||teacherTaskState;renderTeacherLiveState()});

function setupLogin(){
  if(PAGE!=='login')return;
  const params=new URLSearchParams(location.search);
  let role=params.get('role')==='student'?'student':'teacher';
  const account=document.querySelector('#loginAccount'),password=document.querySelector('#loginPassword'),error=document.querySelector('#loginError'),submit=document.querySelector('.login-submit span'),credential=document.querySelector('#demoCredential');
  function setRole(next){role=next;document.querySelectorAll('[data-login-role]').forEach(x=>x.classList.toggle('on',x.dataset.loginRole===role));submit.textContent=`登录并进入${role==='teacher'?'教师端':'学生端'}`;credential.textContent=`${role==='teacher'?'教师':'学生'}账号：${authAccounts[role].account}　密码：${authAccounts[role].password}`;error.textContent='';account.value='';password.value='';account.focus()}
  document.querySelectorAll('[data-login-role]').forEach(x=>x.addEventListener('click',()=>setRole(x.dataset.loginRole)));
  document.querySelector('#fillDemo')?.addEventListener('click',()=>{account.value=authAccounts[role].account;password.value=authAccounts[role].password;error.textContent='';toast('已填入演示账号')});
  document.querySelectorAll('[data-demo-account]').forEach(x=>x.addEventListener('click',()=>{const type=x.dataset.demoAccount;account.value=authAccounts[type].account;password.value=authAccounts[type].password;error.textContent='';toast(`已填入${type==='teacher'?'教师':'学生'}演示账号`)}));
  document.querySelector('#togglePassword')?.addEventListener('click',e=>{const show=password.type==='password';password.type=show?'text':'password';e.currentTarget.textContent=show?'隐藏':'显示'});
  document.querySelector('#loginForm')?.addEventListener('submit',async e=>{
    e.preventDefault();
    if(!account.value.trim()||!password.value){error.textContent='请填写演示账号和密码';return}
    const button=document.querySelector('.login-submit');button.disabled=true;button.classList.add('loading');submit.textContent='服务端正在验证身份';error.textContent='';
    try{
      const me=await window.ZhixueApi.login(account.value.trim(),password.value,role,document.querySelector('#rememberLogin').checked);
      submit.textContent='登录成功，正在进入';toast('服务端身份验证成功');
      const paramsNext=params.get('next');const target=paramsNext===`${me.role}.html`?paramsNext:me.defaultTarget;
      setTimeout(()=>location.href=target,260);
    }catch(loginError){
      button.disabled=false;button.classList.remove('loading');submit.textContent=`登录并进入${role==='teacher'?'教师端':'学生端'}`;
      error.textContent=loginError.message||'登录失败，请检查账号密码';password.focus();
    }
  });
  window.ZhixueApi.me().then(existing=>{const quick=document.createElement('button');quick.className='continue-session';quick.textContent=`继续以“${existing.displayName}”进入`;quick.onclick=()=>location.href=existing.defaultTarget;document.querySelector('.demo-accounts').before(quick)}).catch(()=>{});
  setRole(role);
}
setupLogin();

document.querySelector('#logoutBtn')?.addEventListener('click',async()=>{try{await window.ZhixueApi.logout()}catch{}toast('已退出服务端会话');setTimeout(()=>location.href='index.html',180)});
document.querySelector('#roleSwitchBtn')?.addEventListener('click',async e=>{const next=e.currentTarget.dataset.switchRole;if(PAGE==='teacher'&&next==='student'){openView('students');toast('请选择学生进入教师观察视角；教师身份保持登录');return}try{await window.ZhixueApi.logout()}catch{}toast('直接登录的学生端与教师账号相互独立，切换身份需要重新登录');setTimeout(()=>location.href=`login.html?role=${next}&next=${next}.html`,180)});

const viewCopy={
  teacherHome:['工作台首页','从班级数据出发，完成研判、教学调整与反馈复盘。'],classes:['课程与班级','查看服务端授权的课程与实际教学班级。'],students:['班级与学生数据','直接读取班级和学生证据，并进入只读教师观察视角。'],analysis:['学情智能研判','查看班级、学生与知识点掌握情况及其依据。'],tasks:['分层任务发布','确认智能体生成的差异化任务并发布到学生端。'],inbox:['学生问题与反馈','处理高频问题，并将结果重新纳入教学研判。'],reports:['报告与复盘','导出学情、答疑记录与教学改进建议。'],
  studentHome:['学习首页','查看当前课程、个人薄弱点和待完成任务。'],courses:['我的课程','查看服务端授权课程并切换独立的学习空间。'],portrait:['个人学情画像','了解掌握情况、证据来源与下一步建议。'],assistant:['课程智能答疑','基于课程资料和公共基础知识提问，并支持连续追问。'],studentTasks:['今日学习计划','执行教师确认发布的个人计划与任务。'],history:['学习记录与反馈','回看学习过程和掌握度变化。'],sharing:['数据共享设置','管理向当前任课教师开放的可选学习明细。']
};
const roleViews={teacher:['teacherHome','classes','students','analysis','tasks','inbox','reports'],student:['studentHome','courses','portrait','assistant','studentTasks','history','sharing']};
function readWorkspaceRoute(){
  if(!['teacher','student'].includes(PAGE))return{};
  const raw=location.hash.replace(/^#/,'');const [path,query='']=raw.split('?');const [role,view]=path.split('/');
  return{role,view:role===PAGE&&roleViews[PAGE].includes(view)?view:null,params:new URLSearchParams(query)};
}
function workspaceHash(view){const params=new URLSearchParams();if(state.activeCourse)params.set('course',state.activeCourse);if(state.activeClass)params.set('class',state.activeClass);return`#${PAGE}/${view}${params.size?`?${params}`:''}`}
function currentView(){return document.querySelector('.view.on')?.id||roleViews[PAGE]?.[0]}
window.openView=function(id,options={}){if(!roleViews[PAGE]?.includes(id))id=roleViews[PAGE][0];document.querySelectorAll('.view').forEach(x=>x.classList.toggle('on',x.id===id));document.querySelectorAll('.menu').forEach(x=>{const active=x.dataset.view===id;x.classList.toggle('on',active);if(active)x.scrollIntoView?.({block:'nearest',inline:'nearest'})});const copy=viewCopy[id];if(copy){const title=document.querySelector('.page-title'),desc=document.querySelector('.page-desc'),crumb=document.querySelector('#crumbName');if(title)title.textContent=copy[0];if(desc)desc.textContent=copy[1];if(crumb)crumb.textContent=copy[0]}if(!options.fromHistory){const method=options.replace?'replaceState':'pushState';history[method]({view:id,course:state.activeCourse,classId:state.activeClass},'',workspaceHash(id))}if(!options.keepScroll)scrollTo({top:0,behavior:options.fromHistory?'auto':'smooth'});renderAll();if(id==='assistant'||id==='history')window.ZhixueQaClient?.refreshStudent();if(id==='inbox')window.ZhixueQaClient?.refreshTeacher();if(id==='tasks')window.ZhixueTaskClient?.setTeacherContext(currentContextKey(),m2State.analysisRunId);if(id==='studentTasks'||id==='history')window.ZhixueTaskClient?.setStudentCourse(course()?.offeringId);if(id==='students')void loadTeacherStudents();if(id==='sharing')void loadSharingPreferences()}
async function restoreWorkspaceRoute(replace=false){if(!roleViews[PAGE])return;const route=readWorkspaceRoute(),beforeCourse=state.activeCourse,beforeClass=state.activeClass,requestedCourse=route.params?.get('course'),requestedClass=route.params?.get('class');if(requestedCourse&&state.courses.some(x=>x.id===requestedCourse))state.activeCourse=requestedCourse;const selected=course();if(PAGE==='teacher'&&requestedClass&&selected?.classes.some(x=>x.id===requestedClass))state.activeClass=requestedClass;else if(!selected?.classes.some(x=>x.id===state.activeClass))state.activeClass=selected?.classes[0]?.id||'';openView(route.view||roleViews[PAGE][0],{fromHistory:true,replace,keepScroll:true});if(replace)history.replaceState({view:route.view||roleViews[PAGE][0],course:state.activeCourse,classId:state.activeClass},'',workspaceHash(route.view||roleViews[PAGE][0]));if(beforeCourse!==state.activeCourse||beforeClass!==state.activeClass){saveState();if(PAGE==='teacher')await loadTeacherDashboard();else applyStudentCourse(state.activeCourse)}}
document.querySelectorAll('.menu').forEach(x=>x.addEventListener('click',()=>openView(x.dataset.view)));
addEventListener('popstate',()=>{void restoreWorkspaceRoute(false)});

function masteryHTML(items){return items.map((x,i)=>{const value=Math.max(0,Math.min(100,Number(x.value)||0));return `<div class="mastery-row"><div><span>${i+1}</span><b>${esc(x.name)}</b><em>${value<60?'需补强':value<75?'继续巩固':'掌握良好'}</em></div><div class="mastery-track"><i style="width:${value}%;--bar:${esc(x.color||'#6d87ff')}"></i></div><strong>${value}%</strong></div>`}).join('')}
function fillMastery(){const preview=document.querySelector('#knowledgePreview');if(preview)preview.innerHTML=masteryHTML(knowledge);const analysis=document.querySelector('#knowledgeAnalysis');if(analysis){const points=m2State.analysis?.knowledge_analysis;analysis.innerHTML=points?.length?masteryHTML(points.map((x,i)=>({name:x.knowledge_point,value:Math.max(0,Math.min(100,parseFloat(x.mastery_rate)||0)),color:['#6d87ff','#44d5e8','#f5ae6f'][i%3]}))):masteryHTML(knowledge)}['#studentMasteryPreview','#studentMasteryFull'].forEach(s=>{const e=document.querySelector(s);if(e)e.innerHTML=masteryHTML(studentKnowledge)})}

function renderCourseSelectors(){
  const c=course();
  const cs=document.querySelector('#courseSelect');if(cs){cs.innerHTML=state.courses.map(x=>`<option value="${x.id}" ${x.id===c.id?'selected':''}>${esc(x.name)}</option>`).join('')}
  const cl=document.querySelector('#classSelect');if(cl&&c){const active=currentClass();cl.innerHTML=c.classes.map(x=>`<option value="${x.id}" ${active&&x.id===active.id?'selected':''}>${esc(x.name)}</option>`).join('')}
  const ss=document.querySelector('#studentCourseSelect');if(ss){const joined=state.courses.filter(x=>state.joined.includes(x.id));ss.innerHTML=joined.map(x=>`<option value="${x.id}" ${x.id===c.id?'selected':''}>${esc(x.name)}</option>`).join('')}
  const cc=document.querySelector('#currentContext');if(cc&&c)cc.textContent=`${c.name} · ${currentClass()?.name||'未分班'}`;
  const pc=document.querySelector('#publishContext');if(pc&&c)pc.textContent=`${c.name} · ${currentClass()?.name||'未分班'} · ${currentClass()?.students||0} 名学生`;
}
function replaceWorkspaceContext(){if(roleViews[PAGE])history.replaceState({view:currentView(),course:state.activeCourse,classId:state.activeClass},'',workspaceHash(currentView()))}
document.querySelector('#courseSelect')?.addEventListener('change',async e=>{state.activeCourse=e.target.value;state.activeClass=course()?.classes[0]?.id||'';saveState();replaceWorkspaceContext();await loadTeacherDashboard()});
document.querySelector('#classSelect')?.addEventListener('change',async e=>{state.activeClass=e.target.value;saveState();replaceWorkspaceContext();await loadTeacherDashboard()});
document.querySelector('#studentCourseSelect')?.addEventListener('change',e=>{state.activeCourse=e.target.value;state.activeClass=course()?.classes[0]?.id||'';saveState();replaceWorkspaceContext();applyStudentCourse(state.activeCourse)});

function renderTeacherCourses(){const box=document.querySelector('#teacherCourseGrid');if(!box)return;box.innerHTML=state.courses.length?state.courses.map(c=>`<article class="card teacher-course ${c.id===state.activeCourse?'selected':''}" style="--course:${c.color}"><header><span class="course-mark">${esc(c.name.slice(0,1))}</span><div><b>${esc(c.name)}</b><small>邀请码 ${esc(c.code)}</small></div><button class="iconbtn" onclick="copyCode('${esc(c.code)}')">复制邀请码</button></header><div class="class-list">${c.classes.map(cl=>`<button onclick="selectContext('${c.id}','${cl.id}')"><span><b>${esc(cl.name)}</b><small>${cl.students} 名学生 · SQLite 已连接</small></span><em>可查看</em></button>`).join('')}</div><footer><p class="readonly-note">课程、班级和学生来自服务端授权数据；本演示版暂不提供新建入口。</p></footer></article>`).join(''):empty('暂无授权课程','请检查服务端连接或联系管理员配置课程权限。')}
window.copyCode=async code=>{try{await navigator.clipboard.writeText(code);toast('邀请码已复制')}catch{toast(`邀请码：${code}`)}};
window.selectContext=(courseId,classId)=>{state.activeCourse=courseId;state.activeClass=classId;saveState();openView('teacherHome');loadTeacherDashboard();toast('已切换课程与班级')};

async function loadTeacherStudents(){if(PAGE!=='teacher'||!course()?.offeringId||!currentClass()?.classId)return;const box=document.querySelector('#teacherStudentList');if(box)box.innerHTML='<p class="data-empty">正在从 SQLite 读取当前班级学生…</p>';try{const payload=await fetchDatabase(`/api/teacher/classes/${currentClass().classId}/students?offeringId=${course().offeringId}`);teacherStudents=payload.data||[];setText('#studentDataUpdated',`实时数据 · ${new Date(payload.updatedAt||Date.now()).toLocaleString('zh-CN')}`);renderTeacherStudents()}catch(error){teacherStudents=[];if(box)box.innerHTML=`<div class="empty"><b>学生数据加载失败</b>${esc(error.message)}；未覆盖旧数据，请点击“刷新数据”重试。</div>`}}
function renderTeacherStudents(){const box=document.querySelector('#teacherStudentList');if(!box)return;const q=(document.querySelector('#studentSearch')?.value||'').trim().toLowerCase(),risk=document.querySelector('#studentRiskFilter')?.value||'all';const rows=teacherStudents.filter(x=>(!q||`${x.studentNo} ${x.displayName} ${(x.weakPoints||[]).join(' ')}`.toLowerCase().includes(q))&&(risk==='all'||risk==='none'&&!x.risk||x.risk?.level===risk));setText('#studentListSummary',`当前 ${rows.length} / ${teacherStudents.length} 名学生 · 数字均来自当前数据`);box.innerHTML=rows.length?rows.map(x=>`<button class="teacher-student-row ${selectedObservation?.student?.studentNo===x.studentNo?'on':''}" data-observe-student="${esc(x.studentNo)}"><span><b>${esc(x.displayName)}</b><small>${esc(x.studentNo)} · 最近活跃 ${esc(x.lastActiveAt?new Date(x.lastActiveAt).toLocaleDateString('zh-CN'):'暂无')}</small></span><em>成绩 ${x.score??'--'}</em><em>掌握 ${x.mastery??'--'}%</em><em>任务 ${x.taskCompletionRate??'--'}%</em><i class="risk-${esc(x.risk?.level||'none')}">${esc(x.risk?.level||'正常')}</i></button>`).join(''):'<p class="data-empty">当前筛选条件下没有学生。</p>'}
async function observeStudent(studentNo){const box=document.querySelector('#studentObservation');if(box)box.innerHTML='<p class="data-empty">正在验证教学关系并读取学生公开数据…</p>';try{const payload=await fetchDatabase(`/api/teacher/students/${encodeURIComponent(studentNo)}/observation?context=${encodeURIComponent(currentContextKey())}`);selectedObservation=payload.data;personalPlanDraft=null;renderTeacherStudents();renderObservation()}catch(error){selectedObservation=null;if(box)box.innerHTML=`<div class="empty"><b>无法查看该学生</b>${esc(error.message)}；没有读取或保存越权数据。</div>`}}
function renderObservation(){const box=document.querySelector('#studentObservation'),o=selectedObservation;if(!box||!o)return;const r=o.shared.required,opt=o.shared.optional,p=o.profile.profile;setText('#observationTitle',`${o.student.displayName} · 教师观察视角`);box.innerHTML=`<div class="observation-banner"><b>只读观察</b><span>${esc(o.course.courseName)} · ${esc(o.student.className)} · ${esc(o.student.studentNo)}</span></div><div class="observation-metrics"><div><span>课程成绩</span><b>${r.score??'--'}</b></div><div><span>综合掌握</span><b>${r.mastery??'--'}%</b></div><div><span>出勤率</span><b>${r.attendanceRate??'--'}%</b></div><div><span>任务完成</span><b>${r.tasks.completionRate??'--'}%</b></div></div><h4>主要薄弱点与证据</h4><div class="observation-points">${(p.weaknesses||[]).map(x=>`<span><b>${esc(x.name)}</b>${x.value}% · ${x.evidenceCount||0} 条证据</span>`).join('')||'暂无知识点证据'}</div><p><b>诊断：</b>${esc(p.probable_cause)}；错题 ${r.wrongBook.total} 条，逾期 ${r.tasks.overdue} 项。</p><h4>学生可选共享</h4><div class="sharing-summary"><span>行为明细：${opt.behaviorDetails?'已开放':'学生未开放'}</span><span>作答原文：${opt.answerText?'已开放':'学生未开放'}</span><span>完整问答：${opt.qaContent?'已开放':'学生未开放'}</span><span>目标偏好：${opt.goalsPreferences?'已开放':'学生未开放'}</span></div><button class="btn primary" id="draftPersonalPlan">为该学生制定计划</button>`;document.querySelector('#draftPersonalPlan')?.addEventListener('click',createPersonalPlan)}
async function createPersonalPlan(){if(!selectedObservation)return;try{const response=await window.ZhixueApi.apiFetch(`/api/teacher/students/${selectedObservation.student.studentNo}/plans/drafts`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({context:currentContextKey()})});const payload=await response.json();if(!response.ok||!payload.success)throw new Error(payload.message||'计划生成失败');personalPlanDraft=payload.data;renderPersonalPlan();toast('已按当前学生画像生成差异化草案，请教师复核')}catch(error){toast(`${error.message}；未发布任何计划`)}}
function renderPersonalPlan(){const panel=document.querySelector('#personalPlanEditor');if(!panel||!personalPlanDraft)return;panel.hidden=false;document.querySelector('#personalPlanGoal').value=personalPlanDraft.goal;document.querySelector('#personalPlanRoute').value=personalPlanDraft.route;document.querySelector('#personalPlanDue').value=personalPlanDraft.dueAt?.slice(0,16)||'';setText('#personalPlanStatus',`v${personalPlanDraft.versionNo} · ${personalPlanDraft.status}`);document.querySelector('#personalPlanTasks').innerHTML=personalPlanDraft.tasks.map((task,index)=>`<article><b>${index+1}. ${esc(task.title)}</b><span>${esc(task.difficulty)} · ${task.duration_minutes} 分钟 · ${esc(task.knowledge_point)}</span><p>${esc(task.reason)}</p></article>`).join('')}
async function savePersonalPlan(publish=false){if(!personalPlanDraft)return;try{const body={context:currentContextKey(),goal:document.querySelector('#personalPlanGoal').value,route:document.querySelector('#personalPlanRoute').value,dueAt:new Date(document.querySelector('#personalPlanDue').value).toISOString(),tasks:personalPlanDraft.tasks};let response=await window.ZhixueApi.apiFetch(`/api/plans/${personalPlanDraft.planId}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),payload=await response.json();if(!response.ok||!payload.success)throw new Error(payload.message||'保存失败');personalPlanDraft=payload.data;if(publish){response=await window.ZhixueApi.apiFetch(`/api/plans/${personalPlanDraft.planId}/publish`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({context:currentContextKey()})});payload=await response.json();if(!response.ok||!payload.success)throw new Error(payload.message||'发布失败');personalPlanDraft=payload.data}renderPersonalPlan();toast(publish?'个人计划已确认发布，学生刷新后可见':'草案已保存到服务器')}catch(error){toast(`${error.message}；原草案未被假装发布`)}}
document.querySelector('#studentSearch')?.addEventListener('input',renderTeacherStudents);document.querySelector('#studentRiskFilter')?.addEventListener('change',renderTeacherStudents);document.querySelector('#refreshStudents')?.addEventListener('click',loadTeacherStudents);document.addEventListener('click',event=>{const target=event.target.closest('[data-observe-student]');if(target)void observeStudent(target.dataset.observeStudent)});document.querySelector('#savePersonalPlan')?.addEventListener('click',()=>savePersonalPlan(false));document.querySelector('#publishPersonalPlan')?.addEventListener('click',async()=>{if(await window.ZhixueDialog.ask({title:'确认发布个人计划',message:'发布后学生将在“今日学习计划”看到该版本。',confirmText:'确认发布'}))await savePersonalPlan(true)});

async function loadSharingPreferences(){if(PAGE!=='student'||!course()?.offeringId)return;const status=document.querySelector('#sharingStatus');if(status)status.textContent='正在读取服务端共享设置…';try{sharingPreferences=(await fetchDatabase(`/api/student/sharing-preferences?offeringId=${course().offeringId}`)).data;document.querySelector('#shareBehavior').checked=sharingPreferences.behaviorDetails;document.querySelector('#shareAnswers').checked=sharingPreferences.answerText;document.querySelector('#shareQa').checked=sharingPreferences.qaContent;document.querySelector('#shareGoals').checked=sharingPreferences.goalsPreferences;setText('#sharingVersion',`版本 ${sharingPreferences.version} · ${sharingPreferences.updatedAt?new Date(sharingPreferences.updatedAt).toLocaleString('zh-CN'):'默认未开放'}`);if(status)status.textContent='设置仅影响可选明细；教学必需数据和历史审计不被篡改。'}catch(error){if(status)status.textContent=`读取失败：${error.message}。请重试，旧设置未被修改。`}}
document.querySelector('#saveSharing')?.addEventListener('click',async()=>{const status=document.querySelector('#sharingStatus');try{const response=await window.ZhixueApi.apiFetch('/api/student/sharing-preferences',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({offeringId:course().offeringId,behaviorDetails:document.querySelector('#shareBehavior').checked,answerText:document.querySelector('#shareAnswers').checked,qaContent:document.querySelector('#shareQa').checked,goalsPreferences:document.querySelector('#shareGoals').checked})}),payload=await response.json();if(!response.ok||!payload.success)throw new Error(payload.message||'保存失败');sharingPreferences=payload.data;await loadSharingPreferences();if(status)status.textContent='共享设置已保存并立即生效。'}catch(error){if(status)status.textContent=`保存失败：${error.message}。服务器未确认，因此不显示成功。`}});
async function loadActivePersonalPlan(){const box=document.querySelector('#activePersonalPlan');if(!box||PAGE!=='student'||!course()?.offeringId)return;try{const plans=(await fetchDatabase(`/api/student/plans/active?offeringId=${course().offeringId}`)).data||[],plan=plans[0];box.innerHTML=plan?`<div class="card-head"><div><h3>今日个人学习计划</h3><small>教师确认发布 · v${plan.versionNo}</small></div><span>${new Date(plan.dueAt)<new Date()?'已逾期':'截止 '+new Date(plan.dueAt).toLocaleDateString('zh-CN')}</span></div><h4>${esc(plan.goal)}</h4><p><b>学习路线：</b>${esc(plan.route)}</p><div class="personal-plan-tasks">${plan.tasks.map((task,index)=>`<article><b>${index+1}. ${esc(task.title)}</b><span>${esc(task.difficulty)} · ${task.duration_minutes} 分钟</span><p>${esc(task.reason)}</p></article>`).join('')}</div><details><summary>为什么推荐</summary><pre>${esc(JSON.stringify(plan.whyRecommended,null,2))}</pre></details>`:'<p class="data-empty">当前课程还没有教师确认发布的个人计划。</p>'}catch(error){box.innerHTML=`<div class="empty"><b>个人计划加载失败</b>${esc(error.message)}；请点击课程或刷新页面重试。</div>`}}

async function m2Http(path,options){let response;try{response=await window.ZhixueApi.apiFetch(path,options)}catch{const error=new Error('本地服务不可用，真实数据导入与研判暂不可用。请启动 Node 服务。');error.offline=true;throw error}let payload;try{payload=await response.json()}catch{const error=new Error('当前服务未返回有效数据，正式操作已停止。');error.offline=true;throw error}if(!response.ok||!payload.success){const missingApi=response.status===404&&payload.code!=='IMPORT_BATCH_NOT_FOUND';const error=new Error(missingApi?'本地服务不提供该真实操作。':payload.message||`接口错误 ${response.status}`);error.code=payload.code;error.details=payload;error.offline=missingApi;throw error}return payload.data}
function m2Post(path,body){return m2Http(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})}
function resetM2Visuals(){setText('#classAverage','--');setText('#classPassRate','--');setText('#classAttendance','--');setText('#classRiskCount','--');setText('#thirdMetricLabel','课堂出勤率');setText('#fourthMetricLabel','需重点关注');setText('#averageSource','演示快照');setText('#passSource','演示快照');setText('#thirdMetricSource','演示快照');setText('#fourthMetricSource','演示快照');setText('#m2TierA','--');setText('#m2TierB','--');setText('#m2TierC','--');setText('#m2Advice1','请先导入并确认数据。');setText('#m2Advice2','请先导入并确认数据。');setText('#m2Advice3','请先导入并确认数据。');setText('#knowledgeSource','演示快照；导入后按有效得分均值计算');setText('#analysisSourceNote','当前展示课程数据库演示快照；导入并确认数据后才会显示本批次的真实研判。');setText('#analysisEvidence','尚未对当前班级的导入批次运行研判。');setText('#skillStatus','导入研判待运行')}
function renderM2Analysis(){
  const a=m2State.analysis;if(!a)return;
  const b=m2State.analysisBatch||m2State.batch,o=a.overall_summary||{},s=a.student_stratification||{},ad=a.teaching_suggestions||{},e=a._evidence||{};
  setText('#classAverage',o.average_score);setText('#classPassRate',o.pass_rate);
  setText('#classAttendance',o.total_students);
  setText('#classRiskCount',`${b.quality.validRows} / ${b.quality.invalidRows}`);
  setText('#thirdMetricLabel','有效学生数');setText('#fourthMetricLabel','有效 / 排除行');
  for(const id of ['#averageSource','#passSource','#thirdMetricSource','#fourthMetricSource'])setText(id,'当前导入批次 · 有效记录');
  setText('#m2TierA',`${s.excellent_students?.length||0} 人`);
  setText('#m2TierB',`${s.potential_students?.length||0} 人`);
  setText('#m2TierC',`${s.struggling_students?.length||0} 人`);
  setText('#m2Advice1',ad.class_universal?.[0]||'暂无班级建议');
  setText('#m2Advice2',ad.individual_guidance?.join(' ')||ad.class_universal?.[1]||'暂无分层建议');
  setText('#m2Advice3',ad.next_teaching_focus||'暂无后续重点');
  setText('#knowledgeSource','当前导入批次 · 按有效得分均值计算');
  setText('#analysisSourceNote',`以下结论来自当前已确认的匿名知识点得分导入批次：${b.file.name}。`);
  setText('#analysisEvidence',`研判 ${m2State.analysisRunId||e.analysisRunId||'未记录'} · 批次 ${b.batchId} · ${b.file.name} · SHA-256 ${b.file.sha256.slice(0,12)}… · 有效 ${b.quality.validRows}/${b.quality.totalRows} 行 · ${o.total_students} 名学生 · ${e.skillId||'academic-performance-analyzer'} ${e.skillVersion||'local-m2-20260917'} · ${e.analyzedAt||e.generatedAt||'已保存'}`);
  setText('#skillStatus','本地 Skill · 已完成研判');fillMastery();
}
function renderM2State(){
  if(PAGE!=='teacher')return;
  const b=m2State.batch,q=b?.quality||m2State.qualityOverride;
  const hasCurrentAnalysis=!!(m2State.analysis&&m2State.analysisBatch?.batchId===b?.batchId);
  const box=document.querySelector('#qualityTable'),score=document.querySelector('#qualityScore');
  const confirm=document.querySelector('#ignoreWarnings'),start=document.querySelector('#startAnalysis'),refresh=document.querySelector('#refreshAnalysis');
  if(confirm)confirm.disabled=!b||m2State.busy||m2State.offline||b.status!=='validated';
  if(start)start.disabled=!b||m2State.busy||m2State.offline||b.status!=='confirmed'||hasCurrentAnalysis;
  if(refresh)refresh.disabled=!b||m2State.busy||m2State.offline||b.status!=='confirmed'||!m2State.analysis;
  if(score){score.textContent=q?`有效率 ${q.validRate}%`:'待检查';score.className=`quality-score ${q?.invalidRows?'warn':q?'good':''}`}
  const status=m2State.busy?(m2State.phase||'正在处理请求…'):m2State.error||(!b?'尚未导入本班级数据':`${hasCurrentAnalysis?'研判完成':b.status==='confirmed'?'已确认':m2State.analysis?'待教师确认 · 已恢复最近正式研判':'待教师确认'} · ${q.totalRows} 行 / 有效 ${q.validRows} / 排除 ${q.invalidRows} / 警告 ${q.warningRows}`);
  setText('#qualitySummary',status);
  if(box){
    if(!q){box.className='quality-empty';box.innerHTML=`<span>◎</span><b>${m2State.offline?'本地服务不可用':'尚未导入数据'}</b><p>${esc(m2State.error||'请选择 CSV / JSON，或载入合成演示数据。')}</p>`}
    else{
      box.className='quality-result';
      const issues=m2State.issues||[],preview=m2State.preview||[];
      box.innerHTML=`<div class="quality-file"><span>${esc(b?.file.format?.toUpperCase()||'检查')}</span><div><b>${esc(b?.file.name||'本次文件')}</b><small>批次 ${esc(b?.batchId||'未保存')} · 总 ${q.totalRows} / 有效 ${q.validRows} / 排除 ${q.invalidRows} / 重复 ${q.duplicateRows} / 警告行 ${q.warningRows}</small></div></div>
      <div class="m2-scroll"><table><thead><tr><th>行号</th><th>字段</th><th>类型</th><th>级别</th><th>问题</th></tr></thead><tbody>${issues.length?issues.slice(0,50).map(x=>`<tr><td>${x.rowNumber?`第 ${x.rowNumber} 行`:'文件'}</td><td>${esc(x.field)}</td><td>${esc(x.type)}</td><td><span class="check ${x.severity==='blocking'?'warn':'good'}">${x.severity==='blocking'?'阻断':'警告'}</span></td><td>${esc(x.message)}</td></tr>`).join(''):'<tr><td colspan="5">未发现数据质量问题</td></tr>'}</tbody></table></div>
      ${issues.length>50?`<p class="m2-hint">页面显示前 50 项；本批共 ${q.blockingIssueCount+q.warningIssueCount} 项，最多保存 500 项明细。</p>`:''}
      ${preview.length?`<details class="m2-preview"><summary>查看匿名数据预览（前 ${preview.length} 行）</summary><div class="m2-scroll"><table><thead><tr><th>行号</th><th>匿名编号</th><th>知识点</th><th>得分</th><th>状态</th></tr></thead><tbody>${preview.map(x=>`<tr><td>第 ${x.rowNumber} 行</td><td>${esc(x.anonymousId||'—')}</td><td>${esc(x.knowledgePoint||'—')}</td><td>${x.score??'—'}</td><td>${x.isValid?'有效':'排除'}</td></tr>`).join('')}</tbody></table></div></details>`:''}`;
    }
  }
  if(m2State.analysis){renderM2Analysis();if(m2State.error)setText('#skillStatus','上次研判结果 · 本次请求失败')}
  else setText('#skillStatus',m2State.offline?'本地服务不可用 · 演示快照':b?.status==='confirmed'?'数据已确认 · 待研判':'导入研判待运行');
  renderTeacherLiveState();
}
async function restoreM2(key,token){const requestToken=m2RequestToken;try{const data=await m2Http(`/api/import/latest?context=${encodeURIComponent(key)}`);if(token!==m2Token||requestToken!==m2RequestToken)return;m2State.batch=data?.batch||null;m2State.issues=data?.issues||[];const snapshot=data?.analysis?{batch:data.batch,analysis:data.analysis}:data?.latestCompleted;const run=snapshot?.analysis,analysisBatch=snapshot?.batch;m2State.analysis=run?.status==='completed'&&analysisBatch?.status==='confirmed'&&run.batchId===analysisBatch.batchId&&run.context===key?run.result:null;m2State.analysisBatch=m2State.analysis?analysisBatch:null;m2State.analysisRunId=m2State.analysis?run.analysisRunId:null;m2State.error='';m2State.offline=false;renderM2State()}catch(error){if(token!==m2Token||requestToken!==m2RequestToken)return;m2State.error=error.message;m2State.offline=!!error.offline;renderM2State()}}
function beginM2Read(){const requestToken=++m2RequestToken;m2State.batch=null;m2State.analysis=null;m2State.analysisRunId=null;m2State.issues=[];m2State.preview=[];m2State.qualityOverride=null;m2State.error='';m2State.busy=true;m2State.phase='正在读取文件…';resetM2Visuals();renderM2State();return requestToken}
async function importM2(fileName,content,requestToken){const context=currentContextKey(),token=m2Token;if(requestToken!==m2RequestToken)return;if(!context){m2State.busy=false;m2State.error='请先选择数据库中的课程和班级';renderM2State();return}m2State.phase='正在服务端逐行质检…';renderM2State();try{const data=await m2Post('/api/import/validate',{context,fileName,content});if(token!==m2Token||requestToken!==m2RequestToken)return;m2State.batch=data.batch;m2State.issues=data.issues||[];m2State.preview=data.preview||[];m2State.qualityOverride=null;m2State.analysisBatch=null;m2State.analysis=null;m2State.analysisRunId=null;m2State.offline=false;renderAll();toast(`质检完成：有效 ${data.quality.validRows} 行，排除 ${data.quality.invalidRows} 行`)}catch(error){if(token!==m2Token||requestToken!==m2RequestToken)return;m2State.batch=null;m2State.analysisBatch=null;m2State.analysis=null;m2State.analysisRunId=null;m2State.issues=error.details?.issues||[];m2State.preview=[];m2State.qualityOverride=error.details?.quality||null;m2State.error=`${error.code?`${error.code}：`:''}${error.message}`;m2State.offline=!!error.offline;toast('导入未完成，请查看质检信息')}finally{if(token===m2Token&&requestToken===m2RequestToken){m2State.busy=false;m2State.phase='';renderM2State()}}}
async function readM2File(file){const requestToken=beginM2Read();if(file.size>10*1024*1024){m2State.busy=false;m2State.error='IMPORT_FILE_TOO_LARGE：文件不得超过 10 MiB';renderM2State();return}try{const content=await file.text();if(requestToken===m2RequestToken)await importM2(file.name,content,requestToken)}catch(error){if(requestToken===m2RequestToken){m2State.busy=false;m2State.error=`文件读取失败：${error.message}`;renderM2State()}}}
async function confirmM2(){const b=m2State.batch,token=m2Token,requestToken=m2RequestToken;if(!b||m2State.busy)return false;if(b.status!=='validated')return true;m2State.busy=true;m2State.phase='正在记录教师确认…';renderM2State();try{const data=await m2Post(`/api/import/${encodeURIComponent(b.batchId)}/confirm`,{context:m2State.context});if(token!==m2Token||requestToken!==m2RequestToken)return false;m2State.batch=data.batch;m2State.error='';return true}catch(error){if(token===m2Token&&requestToken===m2RequestToken){m2State.error=error.message;m2State.offline=!!error.offline}return false}finally{if(token===m2Token&&requestToken===m2RequestToken){m2State.busy=false;m2State.phase='';renderM2State()}}}
async function analyzeM2(){const b=m2State.batch,token=m2Token,requestToken=m2RequestToken;if(m2State.busy)return;if(!b||b.status!=='confirmed'){toast('请先确认本批次质检结果');return}m2State.busy=true;m2State.phase='正在运行本地学情 Skill…';renderM2State();try{const data=await m2Post('/api/analyze',{context:m2State.context,batchId:b.batchId});if(token!==m2Token||requestToken!==m2RequestToken)return;m2State.analysisBatch=b;m2State.analysis=data;m2State.analysisRunId=data._evidence?.analysisRunId||null;m2State.error='';m2State.offline=false;openView('analysis');toast('已按本批有效记录完成真实研判')}catch(error){if(token===m2Token&&requestToken===m2RequestToken){m2State.error=error.message;m2State.offline=!!error.offline;toast('研判失败，旧结论未被替换')}}finally{if(token===m2Token&&requestToken===m2RequestToken){m2State.busy=false;m2State.phase='';renderM2State()}}}
document.querySelector('#loadSample')?.addEventListener('click',async()=>{const requestToken=beginM2Read();try{const response=await fetch('assets/samples/m2-learning-demo.csv');if(!response.ok)throw new Error('示例文件读取失败');const content=await response.text();if(requestToken===m2RequestToken)await importM2('m2-learning-demo.csv',content,requestToken)}catch(error){if(requestToken===m2RequestToken){m2State.busy=false;m2State.error=error.message;renderM2State();toast(error.message)}}});
document.querySelector('#dataFile')?.addEventListener('change',async e=>{const f=e.target.files?.[0];if(!f)return;e.target.value='';await readM2File(f)});
const uploadZone=document.querySelector('#uploadZone');uploadZone?.addEventListener('dragover',e=>{e.preventDefault();uploadZone.classList.add('dragging')});uploadZone?.addEventListener('dragleave',()=>uploadZone.classList.remove('dragging'));uploadZone?.addEventListener('drop',async e=>{e.preventDefault();uploadZone.classList.remove('dragging');const f=e.dataTransfer?.files?.[0];if(f)await readM2File(f)});
document.querySelector('#downloadTemplate')?.addEventListener('click',()=>download('学情数据导入模板.csv','匿名编号,知识点,得分,完成时间\nS001,模型评估,78,2026-09-01','text/csv;charset=utf-8'));
document.querySelector('#startAnalysis')?.addEventListener('click',analyzeM2);
document.querySelector('#ignoreWarnings')?.addEventListener('click',async()=>{if(await confirmM2())toast('质检已确认，警告项保留；现在可以开始研判')});

function renderInbox(){window.ZhixueQaClient?.renderInbox()}
document.querySelectorAll('[data-filter]').forEach(x=>x.addEventListener('click',()=>{activeFilter=x.dataset.filter;document.querySelectorAll('[data-filter]').forEach(y=>y.classList.toggle('on',y===x));window.ZhixueQaClient?.setFilter(activeFilter)}));

document.querySelector('#copyAdvice')?.addEventListener('click',async()=>{const text=[...document.querySelectorAll('.recommend-grid p')].map(x=>x.textContent).join('\n');try{await navigator.clipboard.writeText(text);toast('教学建议已复制')}catch{toast('复制失败，请手动选择')}});

function renderStudentCourses(){const box=document.querySelector('#studentCourseGrid');if(!box)return;const joined=state.courses.filter(x=>state.joined.includes(x.id));box.innerHTML=joined.length?joined.map(c=>{const raw=activeStudentDashboard?.courses?.find(x=>x.id===c.id)?.mastery,mastery=Number(raw),value=raw===null||raw===undefined||!Number.isFinite(mastery)?null:Math.max(0,Math.min(100,mastery));return`<article class="card course"><div class="cover" style="--c1:${c.color};--c2:#36b5d0"><b>${esc(c.name)}</b><span>${c.classes.length} 个班级空间</span></div><div class="course-body"><div class="course-meta"><span>综合掌握度</span><span>${value===null?'--':`${value}%`}</span></div><div class="progress"><i style="width:${value??0}%"></i></div><button class="btn sm" onclick="enterStudentCourse('${c.id}')">进入课程</button></div></article>`}).join(''):empty('暂无授权课程','请检查服务端连接或联系教师确认课程权限。')}
window.enterStudentCourse=id=>{state.activeCourse=id;state.activeClass=course()?.classes[0]?.id||'';saveState();applyStudentCourse(id);openView('studentHome');toast('已进入课程')};

document.querySelector('#sendQuestion')?.addEventListener('click',()=>window.ZhixueQaClient?.send());document.querySelector('#askInput')?.addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='Enter')window.ZhixueQaClient?.send()});

function renderStudentTasks(){window.ZhixueTaskClient?.renderStudentTasks()}
function renderTimeline(){window.ZhixueQaClient?.renderStudentHistory([]);window.ZhixueTaskClient?.renderStudentHistory()}

function renderAll(){fillMastery();renderCourseSelectors();renderTeacherCourses();renderStudentCourses();renderInbox();renderStudentTasks();renderTimeline();renderTeacherLiveState();renderStudentLiveState()}
document.querySelector('#refreshAnalysis')?.addEventListener('click',analyzeM2);

function particles(){const c=document.querySelector('#particles');if(!c)return;const ctx=c.getContext('2d');let w,h,points;function size(){w=c.width=innerWidth;h=c.height=innerHeight;points=Array.from({length:Math.min(70,Math.floor(w/22))},()=>({x:Math.random()*w,y:Math.random()*h,vx:(Math.random()-.5)*.18,vy:(Math.random()-.5)*.18,r:Math.random()*1.3+.35}))}function frame(){ctx.clearRect(0,0,w,h);points.forEach(p=>{p.x+=p.vx;p.y+=p.vy;if(p.x<0||p.x>w)p.vx*=-1;if(p.y<0||p.y>h)p.vy*=-1;ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle='rgba(112,170,255,.42)';ctx.fill()});requestAnimationFrame(frame)}size();frame();addEventListener('resize',size)}
particles();renderAll();workspaceReady.then(async()=>{if(['teacher','student'].includes(PAGE)&&currentAuth){await loadFrontendDatabase();await restoreWorkspaceRoute(true)}});
