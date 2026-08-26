// 无头验证：在 Node 中模拟 window 全局，依次加载三个 Skill 适配层并跑契约测试
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const assetsDir = path.join(__dirname, '..', 'github-pages', 'assets', 'skills');
const sandbox = { window: {} };
sandbox.global = sandbox.window;
vm.createContext(sandbox);

function load(file) {
  const code = fs.readFileSync(path.join(assetsDir, file), 'utf8');
  vm.runInContext(code, sandbox);
}

// 加载顺序与页面一致
load('course-ai-tutor.js');
load('academic-performance-analyzer.js');
load('classroom-interaction-generator.js');
load('course-content-optimizer.js');
load('teacher-answer-manager.js');
load('skill-registry.js');

const W = sandbox.window;
const results = [];
function check(name, cond, detail) { results.push({ name, ok: !!cond, detail }); }

// 1. course-ai-tutor：正常解答
const ans = W.ZhixueSkillTutor.answer({ student_question: '精确率和召回率应该怎么选择？', course_name: '人工智能导论' });
check('tutor.已解答', ans.answer_status === '已解答', 'status=' + ans.answer_status);
check('tutor.有依据', Array.isArray(ans._refs) && ans._refs.length > 0, 'refs=' + (ans._refs||[]).length);
check('tutor.有引导追问', Array.isArray(ans.guide_questions) && ans.guide_questions.length > 0, 'guide=' + (ans.guide_questions||[]).length);
check('tutor.输出含核心知识点', /核心知识点/.test(ans.answer_content), 'len=' + ans.answer_content.length);

// 2. course-ai-tutor：资料不足 → 待人工处理
const pend = W.ZhixueSkillTutor.answer({ student_question: '今天食堂有什么菜？', course_name: '人工智能导论' });
check('tutor.待人工处理', pend.answer_status === '待人工处理' && pend.guide_questions.length === 0, 'status=' + pend.answer_status);

// 3. academic-performance-analyzer：正常研判（synthetic scores via fromState）
const rep = W.ZhixueSkillAnalyzer.fromState(
  [{ name: '模型评估', value: 54 }, { name: '混淆矩阵', value: 58 }, { name: 'AI基础', value: 86 }],
  36
);
check('analyzer.整体', rep.overall_summary && typeof rep.overall_summary.average_score === 'number', 'avg=' + (rep.overall_summary&&rep.overall_summary.average_score));
check('analyzer.知识点', Array.isArray(rep.knowledge_analysis) && rep.knowledge_analysis.length === 3, 'n=' + (rep.knowledge_analysis||[]).length);
check('analyzer.分层', rep.student_stratification && Array.isArray(rep.student_stratification.excellent_students), 'e=' + (rep.student_stratification&&rep.student_stratification.excellent_students.length));
check('analyzer.建议', rep.teaching_suggestions && Array.isArray(rep.teaching_suggestions.class_universal), 'n=' + (rep.teaching_suggestions&&rep.teaching_suggestions.class_universal.length));
check('analyzer.最薄弱点被点名', JSON.stringify(rep.teaching_suggestions).indexOf('模型评估') !== -1, 'weak in advice');

// 4. academic-performance-analyzer：缺数据 → 澄清
const clr = W.ZhixueSkillAnalyzer.analyze({});
check('analyzer.澄清', Array.isArray(clr.ask_clarification) && clr.ask_clarification.length > 0, 'n=' + (clr.ask_clarification||[]).length);

// 5. classroom-interaction-generator
const inter = W.ZhixueSkillInteraction.generate({ knowledge_point: '模型评估与指标选择' });
check('interaction.方案', inter.interaction_package && Array.isArray(inter.interaction_package.rounds), 'rounds=' + (inter.interaction_package&&inter.interaction_package.rounds.length));
check('interaction.游戏', inter.game_or_activity && inter.game_or_activity.name, 'name=' + inter.game_or_activity.name);

// 6. course-content-optimizer
const opt = W.ZhixueSkillContentOptimizer.optimize({
  course_name: '人工智能导论',
  current_outline: '第 4 章 模型评估与第 5 章 混淆矩阵…',
  weak_knowledge: [{ name: '模型评估', mastery_rate: 54 }, { name: '混淆矩阵', mastery_rate: 58 }, { name: 'AI基础', mastery_rate: 86 }],
  student_feedback: [{ content: '评估指标容易混' }]
});
check('optimizer.内容调整', Array.isArray(opt.content_changes) && opt.content_changes.length === 3, 'n=' + (opt.content_changes||[]).length);
check('optimizer.最薄弱优先排序', opt.content_changes[0].knowledge_point === '模型评估' && opt.content_changes[0].priority === '高', 'top=' + (opt.content_changes[0]||{}).knowledge_point);
check('optimizer.章节调整', Array.isArray(opt.chapter_adjustments) && opt.chapter_adjustments.length > 0, 'n=' + (opt.chapter_adjustments||[]).length);
check('optimizer.案例与考核', Array.isArray(opt.case_updates) && Array.isArray(opt.assessment_updates), 'case+assess');
check('optimizer.落地计划', Array.isArray(opt.implementation_plan) && opt.implementation_plan.length === 3, 'n=' + (opt.implementation_plan||[]).length);
const optClr = W.ZhixueSkillContentOptimizer.optimize({ course_name: 'x' });
check('optimizer.澄清', Array.isArray(optClr.ask_clarification) && optClr.ask_clarification.length > 0, 'n=' + (optClr.ask_clarification||[]).length);

// 7. teacher-answer-manager
const ansm = W.ZhixueSkillAnswerManager.analyze({
  course_name: '人工智能导论',
  questions: [
    { student: 'S01', question: '准确率和召回率怎么选？' },
    { student: 'S02', question: '混淆矩阵怎么看？' },
    { student: 'S03', question: '回归拟合和过拟合有什么联系？' },
    { student: 'S01', question: '评估指标还是不太懂' }
  ]
});
check('answer.聚合高频', Array.isArray(ansm.aggregate) && ansm.aggregate.length > 0, 'n=' + (ansm.aggregate||[]).length);
check('answer.统一解答', Array.isArray(ansm.unified_answers) && ansm.unified_answers.length === ansm.aggregate.length, 'n=' + (ansm.unified_answers||[]).length);
check('answer.FAQ', Array.isArray(ansm.faq_updates) && ansm.faq_updates.length > 0, 'n=' + (ansm.faq_updates||[]).length);
check('answer.重点辅导名单', Array.isArray(ansm.remedial_targets) && ansm.remedial_targets.some(t => t.student === 'S01'), 'targets=' + (ansm.remedial_targets||[]).map(t=>t.student).join(','));
check('answer.总结', typeof ansm.summary === 'string' && ansm.summary.length > 0, 'summary');
const ansClr = W.ZhixueSkillAnswerManager.analyze({ course_name: 'x', questions: [] });
check('answer.澄清', Array.isArray(ansClr.ask_clarification) && ansClr.ask_clarification.length > 0, 'n=' + (ansClr.ask_clarification||[]).length);

// 8. skill-registry：5 个
const snap = W.ZhixueSkillRegistry.snapshot();
check('registry.5skill', snap.skill_count === 5 && snap.skills.every(s => s.status === 'ready'), 'n=' + snap.skill_count);

// 输出
results.forEach(r => console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + (r.ok ? '' : '  <- ' + r.detail)));
const failed = results.filter(r => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
