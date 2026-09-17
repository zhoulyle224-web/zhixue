(()=>{
  const studentContext='student:S240101';
  const labels={extension:'拓展组',improvement:'提升组',consolidation:'巩固组'};
  const teacher={context:'',analysisRunId:'',token:0,version:null,plans:[],busy:false,error:'',offline:false};
  const student={offeringId:null,token:0,active:[],history:[],course:null,busy:false,error:'',offline:false};
  const byId=id=>document.getElementById(id);
  const safe=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const notify=message=>typeof toast==='function'?toast(message):console.info(message);
  const requestId=prefix=>`${prefix}-${crypto.randomUUID?.()||Date.now()+'-'+Math.random().toString(16).slice(2)}`;
  function setText(id,value){const el=byId(id);if(el)el.textContent=value}
  function localDate(value){if(!value)return'';const date=new Date(value);const offset=date.getTimezoneOffset()*60000;return new Date(date-offset).toISOString().slice(0,16)}
  function defaultDue(){return localDate(Date.now()+7*86400000)}
  async function api(path,options){
    let response;
    try{response=await fetch(path,{...options,headers:{accept:'application/json',...(options?.headers||{})}})}
    catch{const error=new Error('本地任务服务不可用。真实发布与完成操作已停用。');error.offline=true;throw error}
    let payload;
    try{payload=await response.json()}catch{const error=new Error('当前部署不提供任务写接口；这里只能查看历史合成快照。');error.offline=true;throw error}
    if(!response.ok||!payload.success){const error=new Error(payload.message||`任务接口错误 ${response.status}`);error.code=payload.code;error.details=payload;error.offline=response.status===404&&payload.code==='API_NOT_FOUND';throw error}
    return payload.data
  }
  const post=(path,body)=>api(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const put=(path,body)=>api(path,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});

  function teacherTasksFromForm(){
    const old=teacher.version?.tasks||{};
    return{
      extension:{title:old.extension?.title||'拓展组任务',detail:byId('taskA')?.value.trim()||'',durationMinutes:35},
      improvement:{title:old.improvement?.title||'提升组任务',detail:byId('taskB')?.value.trim()||'',durationMinutes:25},
      consolidation:{title:old.consolidation?.title||'巩固组任务',detail:byId('taskC')?.value.trim()||'',durationMinutes:20},
    }
  }
  function setTeacherControls(enabled){
    for(const id of ['taskA','taskB','taskC','publishDate'])if(byId(id))byId(id).disabled=!enabled;
    if(byId('saveTaskDraft'))byId('saveTaskDraft').disabled=!enabled||teacher.busy;
    const blocked=(teacher.version?.coverage?.unmappedStudents||0)>0;
    if(byId('publishTasks'))byId('publishTasks').disabled=!enabled||teacher.busy||blocked;
  }
  function renderTeacher(){
    if(!byId('taskRuntimeBanner'))return;
    const version=teacher.version;
    if(teacher.busy)setText('taskRuntimeBanner','正在同步服务端任务版本…');
    else if(teacher.error)setText('taskRuntimeBanner',teacher.error);
    else if(!version)setText('taskRuntimeBanner','当前班级尚无可用于发布任务的已确认研判，请先完成数据导入、确认与研判。');
    else{
      const coverage=version.coverage;
      setText('taskRuntimeBanner',coverage?
        `本次任务覆盖：${coverage.analysisStudents} 名研判样本 / 班级共 ${coverage.classStudents} 名学生；可映射 ${coverage.mappableStudents} 人，无法映射 ${coverage.unmappedStudents} 人。`:
        `当前版本 v${version.versionNo} · ${version.status}`);
    }
    if(!version){setTeacherControls(false);setText('publishStatus',teacher.offline?'本地服务不可用':'等待已确认研判');return}
    const statusLabel={draft:'草案待确认',published:`已发布 · v${version.versionNo}`,superseded:`已替代 · v${version.versionNo}`,revoked:`已撤回 · v${version.versionNo}`}[version.status]||version.status;
    setText('publishStatus',teacher.busy?'处理中…':statusLabel);
    const tasks=version.tasks||{};
    [['A','extension'],['B','improvement'],['C','consolidation']].forEach(([suffix,tier])=>{
      setText(`taskCount${suffix}`,`${labels[tier]} · ${version.tiers?.[tier]??version.stratification?.[tier]?.length??0} 人`);
      setText(`taskTitle${suffix}`,tasks[tier]?.title||'任务草案');
      const input=byId(`task${suffix}`);if(input&&document.activeElement!==input)input.value=tasks[tier]?.detail||'';
    });
    const source=version.source||{};
    setText('taskEvidence',`来源：研判 ${source.analysisRunId||version.sourceAnalysisRunId} · 批次 ${source.batchId||version.sourceBatchId} · ${source.fileName||'已确认数据'} · SHA-256 ${(source.fileSha256||'').slice(0,12)}… · Skill ${source.skillId||'academic-performance-analyzer'} @ ${source.skillVersion||'unknown'} · 薄弱点：${version.weakestKnowledgePoint||source.weakestKnowledgePoint||'未识别'} · 分析时间 ${source.analysisGeneratedAt?new Date(source.analysisGeneratedAt).toLocaleString('zh-CN'):'已留存'}`);
    const date=byId('publishDate');if(date&&!date.value)date.value=localDate(version.dueAt)||defaultDue();
    const coverage=version.coverage;
    setText('publishContext',coverage?
      `本次研判覆盖 ${coverage.analysisStudents} 人（拓展 ${version.tiers.extension} / 提升 ${version.tiers.improvement} / 巩固 ${version.tiers.consolidation}）`:
      `v${version.versionNo} · 已固化发布记录`);
    setTeacherControls(version.status==='draft'&&!teacher.offline);
    if(coverage?.unmappedStudents)setText('taskRuntimeBanner',`当前研判中有 ${coverage.unmappedStudents} 个学生标识无法映射到本班学生，不能发布。请使用与演示学生一致的合成匿名编号重新导入。`);
    if(byId('reviseTask'))byId('reviseTask').hidden=version.status==='draft';
    if(byId('revokeTask'))byId('revokeTask').hidden=version.status!=='published';
    const plans=teacher.plans||[];
    const versions=plans.flatMap(plan=>plan.versions||[]).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    if(byId('taskVersionHistory'))byId('taskVersionHistory').innerHTML=versions.length?versions.map(item=>`<div><b>v${item.versionNo} · ${safe({draft:'草案',published:'已发布',superseded:'已替代',revoked:'已撤回'}[item.status]||item.status)}</b><span>${safe(item.publishedAt?new Date(item.publishedAt).toLocaleString('zh-CN'):new Date(item.createdAt).toLocaleString('zh-CN'))}</span><small>来源 ${safe(item.sourceAnalysisRunId)} · 内容哈希 ${safe((item.contentDigest||'草案待生成').slice(0,12))}</small></div>`).join(''):'<p>暂无发布版本。</p>';
    const current=versions.find(item=>item.versionId===version.versionId)||version;
    renderFeedback(current);
  }
  function renderFeedback(version){
    const box=byId('taskFeedbackSummary');if(!box)return;
    if(!version||version.status==='draft'){box.innerHTML='<p>发布后可查看完成进度。</p>';return}
    const byTier=version.byTier||{};
    box.innerHTML=`<div class="feedback-metrics"><b>${version.completedCount||0} / ${version.assignedCount||0}</b><span>完成率 ${version.completionRate||0}%</span></div><div class="feedback-tiers">${Object.keys(labels).map(tier=>`<span>${labels[tier]} ${byTier[tier]?.completed||0} / ${byTier[tier]?.assigned||0}</span>`).join('')}</div><div class="recent-feedback">${(version.recentFeedback||[]).map(item=>`<p><b>${safe(item.studentRef)}</b> · ${safe(labels[item.tierCode])}<br>${safe(item.feedback)}</p>`).join('')||'<p>暂无学生文字反馈。</p>'}</div><small>任务完成情况为教学反馈证据，不参与本次成绩指标计算。</small>`;
  }
  async function refreshTeacher(context=teacher.context,analysisRunId=teacher.analysisRunId){
    if(!context)return;
    const token=++teacher.token;teacher.context=context;teacher.analysisRunId=analysisRunId||'';teacher.busy=true;teacher.error='';renderTeacher();
    try{
      let plans=await api(`/api/tasks/teacher?context=${encodeURIComponent(context)}`);
      if(token!==teacher.token)return;
      teacher.plans=plans||[];
      if(analysisRunId){
        teacher.version=await post('/api/tasks/drafts',{context,analysisRunId});
        if(token!==teacher.token)return;
        plans=await api(`/api/tasks/teacher?context=${encodeURIComponent(context)}`);
        teacher.plans=plans||[];
      }else teacher.version=plans?.[0]?.currentVersion||null;
      teacher.offline=false;
    }catch(error){if(token!==teacher.token)return;teacher.error=error.message;teacher.offline=!!error.offline;teacher.version=teacher.plans?.[0]?.currentVersion||null}
    finally{if(token===teacher.token){teacher.busy=false;renderTeacher()}}
  }
  async function saveDraft(){
    if(!teacher.version||teacher.version.status!=='draft'||teacher.busy)return null;
    const tasks=teacherTasksFromForm(),dueAt=byId('publishDate')?.value;
    teacher.busy=true;renderTeacher();
    try{
      const data=await put(`/api/tasks/drafts/${encodeURIComponent(teacher.version.versionId)}`,{
        context:teacher.context,dueAt,tasks,
      });
      teacher.version=data;notify('草案已保存到本地服务');return data
    }catch(error){teacher.error=error.message;notify(`保存失败：${error.message}`);return null}
    finally{teacher.busy=false;renderTeacher()}
  }
  async function publishDraft(){
    const saved=await saveDraft();if(!saved)return;
    const c=saved.coverage;
    const summary=`将向本次研判覆盖的 ${c.analysisStudents} 名学生发布 v${saved.versionNo}：\n拓展组 ${saved.tiers.extension} 人\n提升组 ${saved.tiers.improvement} 人\n巩固组 ${saved.tiers.consolidation} 人\n截止 ${new Date(saved.dueAt).toLocaleString('zh-CN')}\n\n确认发布？`;
    if(!confirm(summary))return;
    teacher.busy=true;renderTeacher();
    try{
      await post(`/api/tasks/drafts/${encodeURIComponent(saved.versionId)}/publish`,{
        context:teacher.context,clientRequestId:requestId('publish'),
      });
      notify('任务版本已由服务端确认发布');
      await refreshTeacher(teacher.context,teacher.analysisRunId);
    }catch(error){teacher.error=error.message;teacher.busy=false;renderTeacher();notify(`发布失败：${error.message}`)}
  }
  async function revise(){
    if(!teacher.version||teacher.busy)return;
    try{teacher.version=await post(`/api/tasks/versions/${teacher.version.versionId}/revise`,{context:teacher.context});teacher.error='';notify(`已创建 v${teacher.version.versionNo} 草案`);await refreshTeacher(teacher.context,teacher.analysisRunId)}
    catch(error){teacher.error=error.message;renderTeacher();notify(error.message)}
  }
  async function revoke(){
    if(!teacher.version||teacher.version.status!=='published')return;
    const reason=prompt('请输入撤回理由（1–200 字）','任务内容需调整');if(!reason)return;
    if(!confirm('撤回后未完成学生将不再看到该任务；已有完成记录和反馈仍保留。确认撤回？'))return;
    try{await post(`/api/tasks/versions/${teacher.version.versionId}/revoke`,{context:teacher.context,reason});notify(`v${teacher.version.versionNo} 已撤回，完成记录仍保留`);await refreshTeacher(teacher.context,teacher.analysisRunId)}
    catch(error){teacher.error=error.message;renderTeacher();notify(error.message)}
  }

  function renderStudentTasks(){
    const box=byId('personalTaskList');if(!box)return;
    if(student.busy){setText('studentTaskStatus','正在读取本人当前有效任务…');box.innerHTML='<div class="card panel">加载中…</div>';return}
    if(student.error){setText('studentTaskStatus',student.error);box.innerHTML=`<div class="card panel task-offline"><b>真实任务服务不可用</b><p>${safe(student.error)}</p><small>当前页面不会使用 localStorage 假装完成或反馈成功。</small></div>`;return}
    const tasks=student.active||[],done=tasks.filter(item=>item.completionStatus==='completed').length;
    const rate=tasks.length?Math.round(done/tasks.length*100):0;
    setText('studentTaskStatus',tasks.length?'已从服务端同步当前有效发布版本。':'当前课程没有有效任务；已撤回或历史版本可在学习记录中查看。');
    setText('taskDoneCount',done);setText('taskTotalCount',tasks.length);setText('studentPendingTasks',Math.max(0,tasks.length-done));setText('taskBadge',Math.max(0,tasks.length-done));
    if(byId('studentTaskBar'))byId('studentTaskBar').style.width=`${rate}%`;
    setText('studentProgress',`${rate}%`);
    const first=tasks[0];setText('studentTaskTier',first?`当前：${first.tierLabel}`:'当前：暂无有效任务');setText('studentTaskGoal',first?`本轮重点：${first.source?.weakestKnowledgePoint||first.title}`:'等待教师基于研判确认并发布。');
    box.innerHTML=tasks.length?tasks.map((task,index)=>`<article class="card personal-task ${task.completionStatus==='completed'?'done':''}"><div class="task-number">${task.completionStatus==='completed'?'✓':String(index+1).padStart(2,'0')}</div><div class="task-info"><span>${safe(task.tierLabel)} · v${task.versionNo} · 建议 ${task.durationMinutes} 分钟</span><h3>${safe(task.title)}</h3><p>${safe(task.detail)}</p><div class="task-tags"><i>截止 ${safe(new Date(task.dueAt).toLocaleString('zh-CN'))}</i><i>薄弱点：${safe(task.source?.weakestKnowledgePoint)}</i></div><p class="task-origin">本任务由教师基于最近一次学情研判确认发布。</p>${task.completionStatus==='completed'?'<b class="completed-label">已完成并持久化</b>':`<label class="task-feedback-input">完成反馈（可选，最多 500 字）<textarea id="feedback-${safe(task.assignmentId)}" maxlength="500" placeholder="例如：已完成练习，仍不理解……"></textarea></label><button class="btn primary" onclick="ZhixueTaskClient.complete('${safe(task.assignmentId)}')">完成任务</button>`}</div></article>`).join(''):'<div class="card panel"><b>教师尚未发布当前有效任务</b><p>发布后会通过本地服务出现在这里；静态页面不会创建假任务。</p></div>';
  }
  function renderStudentHistory(){
    const box=byId('runtimeTaskHistory');if(!box)return;
    box.innerHTML=(student.history||[]).length?'<h4>服务端任务记录</h4>'+student.history.map(item=>`<div><b>v${item.versionNo} · ${safe({published:'进行中',superseded:'已替代',revoked:'已撤回'}[item.versionStatus]||item.versionStatus)}</b><span>${safe(item.tierLabel)} · ${safe(item.completionStatus==='completed'?'已完成':'未完成')}</span><small>${safe(item.title)}${item.feedback?` · 反馈：${safe(item.feedback)}`:''}${item.versionStatus==='revoked'&&item.completionStatus==='completed'?' · 后续教师撤回版本，完成记录保留':''}</small></div>`).join(''):'<p>暂无 runtime 任务历史。</p>';
  }
  async function setStudentCourse(offeringId){
    if(!offeringId)return;const token=++student.token;student.offeringId=Number(offeringId);student.busy=true;student.error='';renderStudentTasks();
    try{
      const [active,history]=await Promise.all([
        api(`/api/tasks/student?studentContext=${encodeURIComponent(studentContext)}&offeringId=${student.offeringId}`),
        api(`/api/tasks/student/history?studentContext=${encodeURIComponent(studentContext)}&offeringId=${student.offeringId}`),
      ]);
      if(token!==student.token)return;student.active=active.activeAssignments||[];student.history=history.history||[];student.course=active.course;student.offline=false;
    }catch(error){if(token!==student.token)return;student.active=[];student.history=[];student.error=error.message;student.offline=!!error.offline}
    finally{if(token===student.token){student.busy=false;renderStudentTasks();renderStudentHistory()}}
  }
  async function complete(assignmentId){
    const task=student.active.find(item=>item.assignmentId===assignmentId);if(!task||student.busy)return;
    const field=byId(`feedback-${assignmentId}`),feedback=field?.value||'';
    student.busy=true;renderStudentTasks();
    try{
      await post(`/api/tasks/assignments/${encodeURIComponent(assignmentId)}/complete`,{
        studentContext,feedback,clientRequestId:requestId('complete'),
      });
      notify('完成状态和反馈已写入服务端');await setStudentCourse(student.offeringId);
    }catch(error){student.error=error.message;student.busy=false;renderStudentTasks();notify(`提交失败：${error.message}`)}
  }

  const client={
    setTeacherContext:(context,analysisRunId)=>refreshTeacher(context,analysisRunId),
    refreshTeacher:()=>refreshTeacher(teacher.context,teacher.analysisRunId),
    setStudentCourse,renderStudentTasks,renderStudentHistory,complete,
  };
  window.ZhixueTaskClient=client;
  addEventListener('DOMContentLoaded',()=>{
    byId('saveTaskDraft')?.addEventListener('click',saveDraft);
    byId('publishTasks')?.addEventListener('click',publishDraft);
    byId('reviseTask')?.addEventListener('click',revise);
    byId('revokeTask')?.addEventListener('click',revoke);
    byId('refreshTaskFeedback')?.addEventListener('click',()=>refreshTeacher(teacher.context,teacher.analysisRunId));
  });
})();
