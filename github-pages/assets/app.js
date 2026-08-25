const AUTH_KEY = 'zhixue_demo_auth_v1';
const PAGE = document.body.dataset.page || 'home';
const authAccounts = {
  teacher:{account:'teacher2026',password:'demo123',name:'演示教师',target:'teacher.html'},
  student:{account:'student2026',password:'demo123',name:'演示学生',target:'student.html'}
};

function readAuth(){
  for(const store of [localStorage,sessionStorage]){try{const v=JSON.parse(store.getItem(AUTH_KEY));if(v?.role&&authAccounts[v.role])return v}catch{}}
  return null;
}
function clearAuth(){localStorage.removeItem(AUTH_KEY);sessionStorage.removeItem(AUTH_KEY)}
function protectWorkspace(){
  if(!['teacher','student'].includes(PAGE))return;
  const auth=readAuth();
  if(!auth||auth.role!==PAGE){location.replace(`login.html?role=${PAGE}&next=${PAGE}.html`);return}
  auth.primaryRole=auth.primaryRole||auth.role;
  const identity=document.querySelector('#userIdentity');if(identity)identity.textContent=auth.name;
  const switchBtn=document.querySelector('#roleSwitchBtn');
  if(switchBtn&&PAGE==='student'&&auth.primaryRole!=='teacher')switchBtn.hidden=true;
}
protectWorkspace();

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
const knowledge = [
  {name:'人工智能基础',value:86,color:'#46dfa1'},
  {name:'机器学习流程',value:74,color:'#43d8ff'},
  {name:'数据预处理',value:69,color:'#617fff'},
  {name:'模型评估',value:54,color:'#ffb45e'},
  {name:'混淆矩阵',value:58,color:'#ff8e7c'}
];
const studentKnowledge = [
  {name:'人工智能基础',value:86,color:'#46dfa1'},
  {name:'机器学习流程',value:67,color:'#43d8ff'},
  {name:'数据预处理',value:72,color:'#617fff'},
  {name:'模型评估',value:48,color:'#ffb45e'},
  {name:'混淆矩阵',value:55,color:'#ff8e7c'}
];

function clone(x){return JSON.parse(JSON.stringify(x))}
function loadState(){try{const v=JSON.parse(localStorage.getItem(KEY));return v&&Array.isArray(v.courses)?v:clone(seed)}catch{return clone(seed)}}
function saveState(){localStorage.setItem(KEY,JSON.stringify(state));renderAll()}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,7)}
function esc(s=''){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function toast(text){const box=document.querySelector('.toast');if(!box)return;box.textContent=text;box.classList.add('show');clearTimeout(window.__toast);window.__toast=setTimeout(()=>box.classList.remove('show'),2400)}
function course(){return state.courses.find(x=>x.id===state.activeCourse)||state.courses[0]}
function currentClass(){const c=course();return c?.classes.find(x=>x.id===state.activeClass)||c?.classes[0]}
function empty(title,desc){return `<div class="empty"><b>${title}</b>${desc}</div>`}
function download(name,content,type='application/json'){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}

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
  document.querySelector('#loginForm')?.addEventListener('submit',e=>{
    e.preventDefault();const expected=authAccounts[role];
    if(!account.value.trim()||!password.value){error.textContent='请填写演示账号和密码';return}
    const entered=account.value.trim(),isTeacher=entered===authAccounts.teacher.account&&password.value===authAccounts.teacher.password,isStudent=entered===authAccounts.student.account&&password.value===authAccounts.student.password;
    if(role==='teacher'&&isStudent){error.textContent='学生账号没有教师端权限，请切换到“学生”身份登录';password.focus();return}
    if(role==='teacher'&&!isTeacher||role==='student'&&!isTeacher&&!isStudent){error.textContent='演示账号或密码不正确，可点击下方账号一键填入';password.focus();return}
    const primaryRole=isTeacher?'teacher':'student';const displayName=primaryRole==='teacher'&&role==='student'?'演示教师 · 学生视角':authAccounts[primaryRole].name;
    clearAuth();const auth={role,primaryRole,name:displayName,account:entered,loginAt:new Date().toISOString()};const store=document.querySelector('#rememberLogin').checked?localStorage:sessionStorage;store.setItem(AUTH_KEY,JSON.stringify(auth));
    document.querySelector('.login-submit').classList.add('loading');submit.textContent='登录成功，正在进入';error.textContent='';toast('身份验证成功');setTimeout(()=>location.href=expected.target,420);
  });
  const existing=readAuth();if(existing&&authAccounts[existing.role]){const quick=document.createElement('button');quick.className='continue-session';quick.textContent=`继续以“${existing.name}”进入`;quick.onclick=()=>location.href=authAccounts[existing.role].target;document.querySelector('.demo-accounts').before(quick)}
  setRole(role);
}
setupLogin();

document.querySelector('#logoutBtn')?.addEventListener('click',()=>{clearAuth();toast('已退出模拟账号');setTimeout(()=>location.href='index.html',260)});
document.querySelector('#roleSwitchBtn')?.addEventListener('click',e=>{const auth=readAuth(),next=e.currentTarget.dataset.switchRole;if(!auth)return;if(auth.primaryRole!=='teacher'){toast('学生账号没有教师端权限');e.currentTarget.hidden=true;return}const useLocal=!!localStorage.getItem(AUTH_KEY);auth.role=next;auth.name=next==='student'?'演示教师 · 学生视角':'演示教师';clearAuth();(useLocal?localStorage:sessionStorage).setItem(AUTH_KEY,JSON.stringify(auth));toast(next==='student'?'正在切换到学生视角':'正在返回教师端');setTimeout(()=>location.href=authAccounts[next].target,280)});

const viewCopy={
  teacherHome:['工作台首页','从班级数据出发，完成研判、教学调整与反馈复盘。'],classes:['课程与班级','先建立课程，再按实际教学对象划分班级。'],import:['数据导入与质检','导入匿名学习数据，并在分析前处理数据质量问题。'],analysis:['学情智能研判','查看班级、学生与知识点掌握情况及其依据。'],tasks:['分层任务发布','确认智能体生成的差异化任务并发布到学生端。'],inbox:['学生问题与反馈','处理高频问题，并将结果重新纳入教学研判。'],reports:['报告与复盘','导出学情、答疑记录与教学改进建议。'],
  studentHome:['学习首页','查看当前课程、个人薄弱点和待完成任务。'],courses:['我的课程','加入课程并切换独立的学习空间。'],portrait:['个人学情画像','了解掌握情况、证据来源与下一步建议。'],assistant:['课程智能答疑','基于课程资料提问，答案附带引用依据。'],studentTasks:['个性化任务','完成教师确认发布的专属学习任务。'],history:['学习记录与反馈','回看学习过程和掌握度变化。']
};
window.openView=function(id){document.querySelectorAll('.view').forEach(x=>x.classList.toggle('on',x.id===id));document.querySelectorAll('.menu').forEach(x=>x.classList.toggle('on',x.dataset.view===id));const copy=viewCopy[id];if(copy){const title=document.querySelector('.page-title'),desc=document.querySelector('.page-desc'),crumb=document.querySelector('#crumbName');if(title)title.textContent=copy[0];if(desc)desc.textContent=copy[1];if(crumb)crumb.textContent=copy[0]}scrollTo({top:0,behavior:'smooth'});renderAll()}
document.querySelectorAll('.menu').forEach(x=>x.addEventListener('click',()=>openView(x.dataset.view)));

function masteryHTML(items){return items.map((x,i)=>`<div class="mastery-row"><div><span>${i+1}</span><b>${x.name}</b><em>${x.value<60?'需补强':x.value<75?'继续巩固':'掌握良好'}</em></div><div class="mastery-track"><i style="width:${x.value}%;--bar:${x.color}"></i></div><strong>${x.value}%</strong></div>`).join('')}
function fillMastery(){['#knowledgePreview','#knowledgeAnalysis'].forEach(s=>{const e=document.querySelector(s);if(e)e.innerHTML=masteryHTML(knowledge)});['#studentMasteryPreview','#studentMasteryFull'].forEach(s=>{const e=document.querySelector(s);if(e)e.innerHTML=masteryHTML(studentKnowledge)})}

function renderCourseSelectors(){
  const c=course();
  const cs=document.querySelector('#courseSelect');if(cs){cs.innerHTML=state.courses.map(x=>`<option value="${x.id}" ${x.id===c.id?'selected':''}>${esc(x.name)}</option>`).join('')}
  const cl=document.querySelector('#classSelect');if(cl&&c){const active=currentClass();cl.innerHTML=c.classes.map(x=>`<option value="${x.id}" ${active&&x.id===active.id?'selected':''}>${esc(x.name)}</option>`).join('')}
  const ss=document.querySelector('#studentCourseSelect');if(ss){const joined=state.courses.filter(x=>state.joined.includes(x.id));ss.innerHTML=joined.map(x=>`<option value="${x.id}" ${x.id===c.id?'selected':''}>${esc(x.name)}</option>`).join('')}
  const cc=document.querySelector('#currentContext');if(cc&&c)cc.textContent=`${c.name} · ${currentClass()?.name||'未分班'}`;
  const pc=document.querySelector('#publishContext');if(pc&&c)pc.textContent=`${c.name} · ${currentClass()?.name||'未分班'} · ${currentClass()?.students||0} 名学生`;
}
document.querySelector('#courseSelect')?.addEventListener('change',e=>{state.activeCourse=e.target.value;state.activeClass=course()?.classes[0]?.id||'';saveState()});
document.querySelector('#classSelect')?.addEventListener('change',e=>{state.activeClass=e.target.value;saveState()});
document.querySelector('#studentCourseSelect')?.addEventListener('change',e=>{state.activeCourse=e.target.value;state.activeClass=course()?.classes[0]?.id||'';saveState()});

function renderTeacherCourses(){const box=document.querySelector('#teacherCourseGrid');if(!box)return;box.innerHTML=state.courses.map(c=>`<article class="card teacher-course ${c.id===state.activeCourse?'selected':''}" style="--course:${c.color}"><header><span class="course-mark">${esc(c.name.slice(0,1))}</span><div><b>${esc(c.name)}</b><small>邀请码 ${esc(c.code)}</small></div><button class="iconbtn" onclick="copyCode('${esc(c.code)}')">复制邀请码</button></header><div class="class-list">${c.classes.map(cl=>`<button onclick="selectContext('${c.id}','${cl.id}')"><span><b>${esc(cl.name)}</b><small>${cl.students} 名学生 · ${cl.imported?'已有数据':'待导入'}</small></span><em>${cl.imported?'可研判':'未导入'}</em></button>`).join('')}</div><footer><input class="field" id="add-${c.id}" placeholder="新班级名称"><button class="btn sm" onclick="addClass('${c.id}')">＋ 添加班级</button></footer></article>`).join('')}
window.copyCode=async code=>{try{await navigator.clipboard.writeText(code);toast('邀请码已复制')}catch{toast(`邀请码：${code}`)}};
window.selectContext=(courseId,classId)=>{state.activeCourse=courseId;state.activeClass=classId;saveState();openView('teacherHome');toast('已切换课程与班级')};
window.addClass=courseId=>{const input=document.querySelector(`#add-${courseId}`),name=input?.value.trim();if(!name){toast('请输入班级名称');return}const c=state.courses.find(x=>x.id===courseId);c.classes.push({id:uid(),name,students:0,imported:false});saveState();toast('班级已添加')};
document.querySelector('#showCreateCourse')?.addEventListener('click',()=>document.querySelector('#courseBuilder')?.classList.toggle('on'));
document.querySelector('#createCourse')?.addEventListener('click',()=>{const n=document.querySelector('#newCourseName'),c=document.querySelector('#newCourseCode'),name=n.value.trim(),code=c.value.trim().toUpperCase();if(!name||!code){toast('请填写课程名称和邀请码');return}if(state.courses.some(x=>x.code===code)){toast('该邀请码已存在');return}const id=uid();state.courses.push({id,name,code,color:'#5f7df4',classes:[{id:id+'-1',name:'一班',students:0,imported:false}]});n.value='';c.value='';state.activeCourse=id;state.activeClass=id+'-1';saveState();toast('课程已创建，可继续添加班级')});

function qualityResult(fileName='示例数据.csv',count=36){return `<div class="quality-result"><div class="quality-file"><span>CSV</span><div><b>${esc(fileName)}</b><small>${count} 条匿名记录 · 已完成字段解析</small></div></div><table><thead><tr><th>检查项目</th><th>结果</th><th>处理建议</th></tr></thead><tbody><tr><td>必要字段</td><td><span class="check good">完整</span></td><td>匿名编号、知识点、得分均存在</td></tr><tr><td>空值检查</td><td><span class="check warn">2 个</span></td><td>建议补充完成时间，可保留分析</td></tr><tr><td>重复记录</td><td><span class="check warn">1 条</span></td><td>将按匿名编号与任务编号去重</td></tr><tr><td>异常成绩</td><td><span class="check good">0 条</span></td><td>所有得分均在 0–100 范围</td></tr></tbody></table></div>`}
function showQuality(name,count){const box=document.querySelector('#qualityTable');if(!box)return;box.className='';box.innerHTML=qualityResult(name,count);document.querySelector('#qualitySummary').textContent=`${count} 条记录 · 2 项提醒 · 无阻断错误`;document.querySelector('#qualityScore').textContent='质量 94%';document.querySelector('#qualityScore').className='quality-score good';document.querySelector('#ignoreWarnings').disabled=false;document.querySelector('#startAnalysis').disabled=false;state.imported=true;const cl=currentClass();if(cl){cl.imported=true;cl.students=count}saveState()}
document.querySelectorAll('.data-type').forEach(x=>x.addEventListener('click',()=>{document.querySelectorAll('.data-type').forEach(y=>y.classList.toggle('on',y===x));toast(`已选择${x.dataset.type}数据`)}));
document.querySelector('#loadSample')?.addEventListener('click',()=>{showQuality('匿名学习数据_示例.csv',36);toast('示例数据已载入并完成质检')});
document.querySelector('#dataFile')?.addEventListener('change',e=>{const f=e.target.files[0];if(!f)return;const reader=new FileReader();reader.onload=()=>{let count=f.name.endsWith('.json')?(()=>{try{const d=JSON.parse(reader.result);return Array.isArray(d)?d.length:1}catch{return 0}})():Math.max(0,String(reader.result).trim().split(/\r?\n/).length-1);if(!count){toast('无法识别文件内容');return}showQuality(f.name,count);toast('文件解析完成')};reader.readAsText(f)});
document.querySelector('#downloadTemplate')?.addEventListener('click',()=>download('学情数据导入模板.csv','匿名编号,知识点,得分,作业完成,互动次数,完成时间\nS001,模型评估,78,是,2,2026-08-24','text/csv;charset=utf-8'));
document.querySelector('#startAnalysis')?.addEventListener('click',()=>{openView('analysis');toast('已基于确认数据完成研判')});
document.querySelector('#ignoreWarnings')?.addEventListener('click',()=>toast('已记录教师确认，提醒项将在报告中保留'));

function questionHTML(q,teacher=false){return `<article class="item question-item"><div class="item-top"><div><div class="item-text">${esc(q.text)}</div><div class="meta">${new Date(q.created).toLocaleString('zh-CN')} · ${esc(q.source||'课程资料')}</div></div><span class="badge ${q.status==='done'?'done':''}">${q.status==='done'?'已回复':'待回复'}</span></div>${q.answer?`<div class="answer"><b>教师回复</b><br>${esc(q.answer)}</div>`:''}${teacher?`<div class="item-actions"><button class="iconbtn" onclick="toggleReply('${q.id}')">${q.answer?'修改回复':'回复学生'}</button></div><div class="reply" id="reply-${q.id}"><textarea placeholder="写下清晰、可执行的回复">${esc(q.answer||'')}</textarea><button class="btn primary sm" onclick="saveReply('${q.id}')">保存并同步</button></div>`:''}</article>`}
window.toggleReply=id=>document.querySelector(`#reply-${id}`)?.classList.toggle('on');
window.saveReply=id=>{const q=state.questions.find(x=>x.id===id),v=document.querySelector(`#reply-${id} textarea`)?.value.trim();if(!v){toast('请先填写回复');return}q.answer=v;q.status='done';saveState();toast('回复已同步到学生学习记录')};
function renderInbox(){const qs=state.questions.filter(q=>q.courseId===state.activeCourse),pending=qs.filter(q=>q.status==='pending').length,filtered=qs.filter(q=>activeFilter==='all'||q.status===activeFilter);document.querySelectorAll('#pendingBadge').forEach(x=>x.textContent=pending);const pc=document.querySelector('#pendingCount');if(pc)pc.textContent=pending;const box=document.querySelector('#inboxList');if(box)box.innerHTML=filtered.length?filtered.map(q=>questionHTML(q,true)).join(''):empty('暂无相关问题','学生在课程答疑中提交的问题会出现在这里。');const ac=document.querySelector('#answeredCount');if(ac)ac.textContent=qs.filter(q=>q.status==='done').length}
document.querySelectorAll('[data-filter]').forEach(x=>x.addEventListener('click',()=>{activeFilter=x.dataset.filter;document.querySelectorAll('[data-filter]').forEach(y=>y.classList.toggle('on',y===x));renderInbox()}));

document.querySelector('#publishTasks')?.addEventListener('click',()=>{const vals=[['t1','taskA','拓展组'],['t2','taskB','提升组'],['t3','taskC','巩固组']];state.tasks=vals.map(([id,input,tier],i)=>({id:`published-${id}`,courseId:state.activeCourse,tier,title:document.querySelector(`#${input}`).value.trim().split(/[，。]/)[0]||'分层学习任务',detail:document.querySelector(`#${input}`).value.trim(),duration:['35 分钟','25 分钟','20 分钟'][i],done:false}));state.published=true;saveState();document.querySelector('#publishStatus').textContent='已发布';document.querySelector('#publishStatus').classList.add('done');toast('分层任务已发布到学生端')});
document.querySelector('#copyAdvice')?.addEventListener('click',async()=>{const text=[...document.querySelectorAll('.recommend-grid p')].map(x=>x.textContent).join('\n');try{await navigator.clipboard.writeText(text);toast('教学建议已复制')}catch{toast('复制失败，请手动选择')}});
document.querySelectorAll('[data-export]').forEach(x=>x.addEventListener('click',()=>{const kind=x.dataset.export,content={课程:course()?.name,班级:currentClass()?.name,导出时间:new Date().toLocaleString('zh-CN'),类型:kind,知识点掌握:knowledge,学生分层:{拓展组:8,提升组:17,巩固组:11},问题记录:state.questions};download(`智学双擎_${kind}.json`,JSON.stringify(content,null,2));toast('文件已导出')}));

function renderStudentCourses(){const box=document.querySelector('#studentCourseGrid');if(!box)return;const joined=state.courses.filter(x=>state.joined.includes(x.id));box.innerHTML=joined.length?joined.map(c=>`<article class="card course"><div class="cover" style="--c1:${c.color};--c2:#36b5d0"><b>${esc(c.name)}</b><span>${c.classes.length} 个班级空间</span></div><div class="course-body"><div class="course-meta"><span>综合掌握度</span><span>${c.id==='ai'?'64%':'71%'}</span></div><div class="progress"><i style="width:${c.id==='ai'?64:71}%"></i></div><button class="btn sm" onclick="enterStudentCourse('${c.id}')">进入课程</button></div></article>`).join(''):empty('还没有课程','使用教师提供的邀请码加入课程。')}
window.enterStudentCourse=id=>{state.activeCourse=id;state.activeClass=course()?.classes[0]?.id||'';saveState();openView('studentHome');toast('已进入课程')};
document.querySelector('#showJoinCourse')?.addEventListener('click',()=>document.querySelector('#joinCoursePanel')?.classList.toggle('on'));
document.querySelector('#joinCourse')?.addEventListener('click',()=>{const input=document.querySelector('#joinCode'),code=input.value.trim().toUpperCase(),c=state.courses.find(x=>x.code===code);if(!c){toast('未找到该邀请码，请向教师确认');return}if(!state.joined.includes(c.id))state.joined.push(c.id);state.activeCourse=c.id;state.activeClass=c.classes[0]?.id||'';input.value='';saveState();toast(`已加入《${c.name}》`)});

function assistantAnswer(q){const lower=q.toLowerCase();if(lower.includes('精确率')||lower.includes('召回率'))return {text:'选择指标要看错误代价：如果漏掉一个真正的正例代价更高（如疾病筛查），优先关注召回率；如果把负例误判为正例代价更高（如垃圾邮件误删重要邮件），优先关注精确率。两者需要综合时可使用 F1 值。',source:'《第 4 章 模型评估》22–24 页；课件“混淆矩阵与评价指标”第 16 页'};if(lower.includes('混淆矩阵'))return {text:'混淆矩阵把预测结果分为 TP、FP、FN、TN 四类。例如检测 100 封邮件，其中 20 封垃圾邮件：正确识别 16 封是 TP，漏掉 4 封是 FN；把 5 封正常邮件误判为垃圾邮件是 FP，其余 75 封是 TN。',source:'课件“混淆矩阵与评价指标”第 12–15 页；例题 4-2'};if(lower.includes('准确率'))return {text:'类别不平衡时，准确率可能掩盖问题。例如 100 个样本只有 2 个正例，模型全部预测为负例，准确率仍有 98%，但两个真正的正例一个也没找到。因此还要结合召回率、精确率或 F1 值。',source:'《第 4 章 模型评估》18–21 页'};return {text:'当前课程资料中没有足够内容直接支持这个问题。我已把问题记录到当前课程，你可以补充具体题目或等待教师回复。',source:'资料检索范围：第 4 章讲义、模型评估课件与例题 4-2'} }
function addChat(role,content,source=''){const box=document.querySelector('#chatMessages');if(!box)return;const div=document.createElement('div');div.className=`chat ${role}`;div.innerHTML=`<span>${role==='ai'?'AI':'我'}</span><div><b>${role==='ai'?'课程学习助手':'我的问题'}</b><p>${esc(content)}</p>${source?`<button class="citation">依据：${esc(source)}</button>`:''}</div>`;box.appendChild(div);box.scrollTop=box.scrollHeight}
function sendQuestion(){const input=document.querySelector('#askInput'),q=input?.value.trim();if(!q){toast('请先输入课程问题');return}addChat('user',q);input.value='';const pending={id:uid(),courseId:state.activeCourse,text:q,status:'pending',answer:'',created:new Date().toISOString(),source:'课程智能答疑'};state.questions.unshift(pending);saveState();setTimeout(()=>{const a=assistantAnswer(q);addChat('ai',a.text,a.source);toast('回答已生成，并附带课程资料依据')},350)}
document.querySelector('#sendQuestion')?.addEventListener('click',sendQuestion);document.querySelector('#askInput')?.addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='Enter')sendQuestion()});document.querySelectorAll('[data-question]').forEach(x=>x.addEventListener('click',()=>{document.querySelector('#askInput').value=x.dataset.question;sendQuestion()}));

function renderStudentTasks(){const tasks=state.tasks.filter(t=>t.courseId===state.activeCourse&&(!t.tier||t.tier==='巩固组')),done=tasks.filter(t=>t.done).length,rate=tasks.length?Math.round(done/tasks.length*100):0;const box=document.querySelector('#personalTaskList');if(box)box.innerHTML=tasks.length?tasks.map((t,i)=>`<article class="card personal-task ${t.done?'done':''}"><div class="task-number">${t.done?'✓':String(i+1).padStart(2,'0')}</div><div class="task-info"><span>${esc(t.tier||'专属任务')} · ${esc(t.duration||'20 分钟')}</span><h3>${esc(t.title)}</h3><p>${esc(t.detail)}</p><div class="task-tags"><i>课程资料支持</i><i>完成后反馈教师</i></div></div><button class="btn ${t.done?'':'primary'}" onclick="togglePersonalTask('${t.id}')">${t.done?'已完成':'标记完成'}</button></article>`).join(''):empty('教师尚未发布任务','发布后会自动出现在当前课程中。');const bar=document.querySelector('#studentTaskBar');if(bar)bar.style.width=rate+'%';const prog=document.querySelector('#studentProgress');if(prog)prog.textContent=rate+'%';const doneEl=document.querySelector('#taskDoneCount');if(doneEl)doneEl.textContent=done;const pending=document.querySelector('#studentPendingTasks');if(pending)pending.textContent=Math.max(0,tasks.length-done);const badge=document.querySelector('#taskBadge');if(badge)badge.textContent=Math.max(0,tasks.length-done)}
window.togglePersonalTask=id=>{const t=state.tasks.find(x=>x.id===id);if(t)t.done=!t.done;saveState();toast(t.done?'任务完成，结果已加入学习反馈':'任务已恢复为待完成')};
function renderTimeline(){const box=document.querySelector('#learningTimeline');if(!box)return;const done=state.tasks.filter(t=>t.done);const items=[...done.map(t=>({title:`完成任务：${t.title}`,desc:'任务结果已计入当前课程画像'})),...state.questions.slice(0,3).map(q=>({title:`提交问题：${q.text}`,desc:q.status==='done'?'已获得教师回复':'已记录，等待教师回复'}))];box.innerHTML=items.length?items.map((x,i)=>`<div><i class="${i===0?'active':''}"></i><b>${esc(x.title)}</b><p>${esc(x.desc)}</p></div>`).join(''):empty('暂无学习记录','完成任务或提交问题后会自动记录。')}
document.querySelector('#exportStudentData')?.addEventListener('click',()=>{download('智学双擎_个人学习记录.json',JSON.stringify({课程:course()?.name,掌握画像:studentKnowledge,任务:state.tasks,问题:state.questions},null,2));toast('学习记录已导出')});

function renderAll(){fillMastery();renderCourseSelectors();renderTeacherCourses();renderStudentCourses();renderInbox();renderStudentTasks();renderTimeline()}
document.querySelector('#refreshAnalysis')?.addEventListener('click',()=>{toast('已使用当前确认数据重新生成研判结果');document.querySelector('#knowledgeAnalysis')?.classList.add('flash');setTimeout(()=>document.querySelector('#knowledgeAnalysis')?.classList.remove('flash'),650)});

function particles(){const c=document.querySelector('#particles');if(!c)return;const ctx=c.getContext('2d');let w,h,points;function size(){w=c.width=innerWidth;h=c.height=innerHeight;points=Array.from({length:Math.min(70,Math.floor(w/22))},()=>({x:Math.random()*w,y:Math.random()*h,vx:(Math.random()-.5)*.18,vy:(Math.random()-.5)*.18,r:Math.random()*1.3+.35}))}function frame(){ctx.clearRect(0,0,w,h);points.forEach(p=>{p.x+=p.vx;p.y+=p.vy;if(p.x<0||p.x>w)p.vx*=-1;if(p.y<0||p.y>h)p.vy*=-1;ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle='rgba(112,170,255,.42)';ctx.fill()});requestAnimationFrame(frame)}size();frame();addEventListener('resize',size)}
particles();renderAll();
