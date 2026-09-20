/* M1 课程答疑界面：服务端是问答、待办和回复的唯一正式数据源。 */
(function (global) {
  'use strict';
  const studentContext = () => `student:${global.ZhixueApi.current?.actorRefCode || 'S240101'}`;
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const time = value => value ? new Date(value).toLocaleString('zh-CN') : '—';
  let studentCourse = null, teacherContext = '', studentToken = 0, teacherToken = 0, qaSessionId = null;
  let resources = null, resourceError = '', history = [], inbox = [], filter = 'all', sending = false, taskCache = [];
  let teacherLoading = false, teacherError = '';

  async function api(path, options) {
    let response, payload;
    try { response = await global.ZhixueApi.apiFetch(path, options); }
    catch { const error = new Error('本地答疑服务不可用，请启动 Node 服务后重试。教师待办尚未同步。'); error.offline = true; throw error; }
    try { payload = await response.json(); }
    catch { const error = new Error('当前站点不提供正式答疑服务；请使用本地 Node 版。教师待办尚未同步。'); error.offline = true; throw error; }
    if (!response.ok || !payload.success) { const error = new Error(payload.message || `接口错误 ${response.status}`); error.code = payload.code; error.offline = response.status === 404 && payload.code === 'API_NOT_FOUND'; throw error; }
    return payload.data;
  }

  function status(message, tone = '') { const el = $('#qaStatus'); if (el) { el.textContent = message; el.dataset.tone = tone; } }
  function setSending(value) { sending = value; const button = $('#sendQuestion'); if (button) { button.disabled = value; button.textContent = value ? '正在检索当前课程资料…' : '发送问题'; } }
  function initialChat(course) {
    const el = $('#chatMessages'); if (!el) return;
    el.innerHTML = `<div class="chat ai"><span>AI</span><div><b>课程智能助教</b><p>你好！我会优先使用《${esc(course?.name || '当前课程')}》资料，也能回答通用基础和计算机公共基础问题。无模型配置时会明确显示离线检索模式；资料不足时由你决定是否转教师。</p></div></div>`;
  }
  function evidenceHtml(evidence) {
    if (!evidence?.length) return '';
    return `<details class="qa-evidence"><summary>查看 ${evidence.length} 条回答依据</summary>${evidence.map(item => `<div><b>${esc(item.title || item.sourceLabel || '知识依据')}</b> · ${esc(item.locator || '已校验')}<br><small>${esc(item.knowledgeLayer || item.resourceType || '知识库')} · ${esc(item.sourceLabel || '本地资料')} · ${esc(item.version || '当前版本')}${item.resourceId ? ` · ${esc(item.resourceId)}` : ''}</small></div>`).join('')}</details>`;
  }
  function chat(role, content, extra = '') {
    const el = $('#chatMessages'); if (!el) return;
    const node = document.createElement('div'); node.className = `chat ${role}`;
    node.innerHTML = `<span>${role === 'ai' ? 'AI' : role === 'teacher' ? '师' : '我'}</span><div><b>${role === 'ai' ? '本地 Skill' : role === 'teacher' ? '教师回复' : '我的问题'}</b><p>${esc(content).replace(/\n/g, '<br>')}</p>${extra}</div>`;
    el.appendChild(node); el.scrollTop = el.scrollHeight;
  }
  function renderResources() {
    const course = studentCourse;
    const count = $('#qaResourceCount'), list = $('#qaResourceList'), quick = $('#qaQuickQuestions');
    if (!course) return;
    if (count) count.textContent = resourceError ? '● 当前课程资料加载失败' : resources ? `● ${resources.mode==='model-assisted'?'模型增强':'离线知识检索'} · 课程资料 ${resources.resources.length} 份 · 公共知识 ${resources.commonKnowledgeCount||0} 条` : '● 正在加载知识库';
    if (list) list.innerHTML = resourceError ? `<p class="qa-empty-resource">${esc(resourceError)}；本地正式答疑暂不可用。</p>` : resources?.resources.length ? resources.resources.map(r => `<details class="qa-resource"><summary><span>${esc(r.resourceType)}</span><b>${esc(r.title)}</b><small>${esc(r.version)} · 合成演示</small></summary><p>${esc(r.chapter || '')} · 资源 ${esc(r.resourceId)}</p></details>`).join('') : resources ? `<p class="qa-empty-resource">当前课程暂无专属资料，仍可使用 ${resources.commonKnowledgeCount || 0} 条通用与计算机公共基础知识；证据不足时可由你决定是否转教师。</p>` : '<p class="qa-empty-resource">正在加载当前课程资料…</p>';
    if (quick) quick.innerHTML = (resources?.sampleQuestions || []).map(q => `<button data-qa-question="${esc(q)}">${esc(q)}</button>`).join('');
  }
  function renderStudentHistory(doneTasks) {
    const timeline = $('#learningTimeline'); if (!timeline) return;
    if (doneTasks) taskCache = doneTasks;
    const entries = [...taskCache.map(t => ({ title:`完成任务：${t.title}`, detail:'当前课程任务记录' })),
      ...history.map(q => ({ title:`提交问题：${q.question}`, detail:q.teacherReply ? `教师回复：${q.teacherReply}` : q.status === 'answered' ? `本地 Skill 已解答 · ${q.evidence[0]?.title || ''}` : '资料不足 · 已进入教师待办' }))];
    timeline.innerHTML = entries.length ? entries.map((x, i) => `<div><i class="${i === 0 ? 'active' : ''}"></i><b>${esc(x.title)}</b><p>${esc(x.detail)}</p></div>`).join('') : '<div class="empty"><b>暂无学习记录</b>提交课程问题后将显示在这里。</div>';
  }
  function renderChatHistory() {
    initialChat(studentCourse);
    for (const row of [...history].reverse()) {
      chat('user', row.question, `<small>问题编号 ${esc(row.questionId)} · ${time(row.createdAt)}</small>`);
      const pending = row.status === 'pending_teacher';
      const handoff = row.answerState === '建议转教师' || row.answerState === '需澄清' ? `<button class="btn sm" data-qa-handoff="${esc(row.questionId)}">转给任课教师</button>` : '';
      chat('ai', row.assistantAnswer, `${pending ? '<small>已由学生确认转教师</small>' : evidenceHtml(row.evidence)}${handoff}<small>${esc(row.answerSourceType||'')} · ${esc(row.modelProvider||'offline')} · 问题编号 ${esc(row.questionId)}</small>`);
      if (row.teacherReply) chat('teacher', row.teacherReply, `<small>${time(row.repliedAt)}</small>`);
    }
  }
  async function refreshStudent() {
    if (!studentCourse?.offeringId) return;
    const course = { ...studentCourse }, token = ++studentToken;
    resources = null; resourceError = ''; history = []; renderResources(); initialChat(course); status('正在加载当前课程资料与答疑记录…');
    const query = `studentContext=${encodeURIComponent(studentContext())}&offeringId=${course.offeringId}`;
    const [resourceResult, historyResult] = await Promise.allSettled([
      api(`/api/qa/resources?${query}`), api(`/api/qa/history?${query}`),
    ]);
    if (token !== studentToken || studentCourse.offeringId !== course.offeringId) return;
    if (resourceResult.status === 'fulfilled') resources = resourceResult.value;
    else resourceError = resourceResult.reason?.message || '课程资料加载失败';
    if (historyResult.status === 'fulfilled') history = historyResult.value;
    renderResources(); renderChatHistory(); renderStudentHistory();
    if (resourceResult.status === 'rejected' || historyResult.status === 'rejected') {
      status(resourceResult.reason?.message || historyResult.reason?.message || '课程答疑加载失败', 'error');
    } else status(resources.knowledgeAvailable ? '当前答疑优先使用本课程资料，并可补充通用与计算机公共基础知识。' : `当前课程暂无专属资料，可使用 ${resources.commonKnowledgeCount || 0} 条公共基础知识；证据不足时由你决定是否转教师。`);
  }
  function setStudentCourse(course) {
    const changed = studentCourse?.offeringId !== course?.offeringId;
    studentCourse = course?.offeringId ? { offeringId: course.offeringId, name: course.name } : null;
    if (changed) { qaSessionId=null; ++studentToken; refreshStudent(); }
  }
  async function send() {
    const input = $('#askInput'), question = input?.value.trim();
    if (sending || !question) { if (!question) status('请先输入课程问题。', 'error'); return; }
    if (question.length > 500) { status('问题不能超过 500 字。', 'error'); return; }
    const course = studentCourse && { ...studentCourse };
    if (!course) { status('请先选择有教学班编号的课程。', 'error'); return; }
    setSending(true); status(`正在理解问题并检索《${course.name}》及公共基础知识…`); const requestId = crypto.randomUUID();
    try {
      if (!qaSessionId) { const session = await api('/api/qa/sessions', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ studentContext:studentContext(), offeringId:course.offeringId, title:question.slice(0,40) }) }); qaSessionId=session.sessionId; }
      const result = await api(`/api/qa/sessions/${encodeURIComponent(qaSessionId)}/messages`, { method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ studentContext:studentContext(), offeringId:course.offeringId, question, clientRequestId:requestId }) });
      if (studentCourse?.offeringId === course.offeringId) {
        input.value = ''; await refreshStudent();
        status(result.answer_status === '已解答' ? `${result.answer_source_type} · ${result.model_provider} · ${result._evidence.length} 条依据` : `${result.answer_status} · 未自动转教师 · 问题编号 ${result.questionId}`);
      } else status(`《${course.name}》的问题已提交；切回该课程可查看结果。`);
    } catch (error) {
      if (studentCourse?.offeringId === course.offeringId) status(`${error.message} 问题未确认保存时请重试。`, 'error');
    } finally { setSending(false); }
  }

  function renderInbox() {
    const box = $('#inboxList'); if (!box) return;
    if (teacherLoading) { box.innerHTML = '<div class="empty"><b>正在加载服务端问题…</b></div>'; return; }
    if (teacherError) { box.innerHTML = `<div class="empty"><b>教师收件箱加载失败</b>${esc(teacherError)}</div>`; return; }
    const filtered = inbox.filter(row => filter === 'all' || filter === 'pending' && row.status === 'pending_teacher' || filter === 'replied' && row.status === 'teacher_replied' || filter === 'answered' && row.status === 'answered');
    const pending = inbox.filter(row => row.status === 'pending_teacher').length;
    document.querySelectorAll('#pendingBadge').forEach(el => { el.textContent = pending; });
    if ($('#pendingCount')) $('#pendingCount').textContent = pending;
    box.innerHTML = filtered.length ? filtered.map(row => `<article class="item question-item"><div class="item-top"><div><div class="item-text">${esc(row.question)}</div><div class="meta">${esc(row.course.courseName)} · ${time(row.createdAt)} · ${esc(row.studentAlias)}</div></div><span class="badge ${row.status === 'pending_teacher' ? '' : 'done'}">${row.status === 'pending_teacher' ? '待回复' : row.status === 'teacher_replied' ? '教师已回复' : 'Skill 已解答'}</span></div>${row.teacherReply ? `<div class="answer"><b>教师回复</b><br>${esc(row.teacherReply)}</div>` : ''}${row.status !== 'answered' ? `<div class="item-actions"><button class="iconbtn" data-qa-reply-open="${esc(row.questionId)}">${row.teacherReply ? '修改回复' : '回复学生'}</button></div><div class="reply" id="reply-${esc(row.questionId)}"><textarea maxlength="2000" placeholder="写下清晰、可执行的回复">${esc(row.teacherReply || '')}</textarea><button class="btn primary sm" data-qa-reply-save="${esc(row.questionId)}">保存并同步</button></div>` : evidenceHtml(row.evidence)}</article>`).join('') : '<div class="empty"><b>当前筛选下暂无问题</b>学生正式提问会从服务端同步到这里。</div>';
  }
  async function refreshTeacher() {
    const context = teacherContext, token = ++teacherToken, box = $('#inboxList');
    if (!context || !box) return;
    teacherLoading = true; teacherError = ''; renderInbox();
    try { const result = await api(`/api/qa/teacher-inbox?context=${encodeURIComponent(context)}&status=all`);
      if (token !== teacherToken || context !== teacherContext) return; inbox = result; teacherLoading = false; renderInbox();
    } catch (error) { if (token === teacherToken) { teacherLoading = false; teacherError = error.message; renderInbox(); } }
  }
  function setTeacherContext(context) { if (teacherContext !== context) { teacherContext = context; inbox = []; teacherError = ''; ++teacherToken; refreshTeacher(); } }
  function setFilter(value) { filter = value === 'done' ? 'replied' : value; renderInbox(); }
  async function saveReply(id) {
    const node = document.getElementById(`reply-${id}`), reply = node?.querySelector('textarea')?.value.trim(), button = node?.querySelector('button');
    if (!reply) { if (button) button.textContent = '请填写回复'; return; }
    if (button) { button.disabled = true; button.textContent = '正在同步…'; }
    try { await api(`/api/qa/${encodeURIComponent(id)}/reply`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ context:teacherContext, reply }) }); await refreshTeacher(); }
    catch (error) { if (button) { button.disabled = false; button.textContent = `同步失败：${error.message}`; } }
  }
  async function handoff(id) {
    try { await api(`/api/qa/${encodeURIComponent(id)}/handoff`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({studentContext:studentContext()}) }); await refreshStudent(); status('已确认转给任课教师。'); }
    catch (error) { status(`转交失败：${error.message}。问题仍保留，可重试。`, 'error'); }
  }
  document.addEventListener('click', event => {
    const question = event.target.closest('[data-qa-question]'); if (question) { if ($('#askInput')) $('#askInput').value = question.dataset.qaQuestion; send(); }
    const open = event.target.closest('[data-qa-reply-open]'); if (open) document.getElementById(`reply-${open.dataset.qaReplyOpen}`)?.classList.toggle('on');
    const save = event.target.closest('[data-qa-reply-save]'); if (save) saveReply(save.dataset.qaReplySave);
    const transfer = event.target.closest('[data-qa-handoff]'); if (transfer) handoff(transfer.dataset.qaHandoff);
  });
  global.ZhixueQaClient = { setStudentCourse, refreshStudent, send, renderStudentHistory, setTeacherContext, refreshTeacher, renderInbox, setFilter };
})(window);
