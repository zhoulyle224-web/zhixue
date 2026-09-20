/** 智学双擎 Skill 注册表：显示真实本地能力，不冒用外部平台名称。 */
(function(global){'use strict';
const definitions=[
  ['academic-performance-analyzer','班级学情分析','直接分析当前班级成绩、知识点、出勤、任务和答疑证据。','ZhixueSkillAnalyzer'],
  ['course-ai-tutor','课程智能助教','在 K0～K3 中检索、计算和连续答疑；可选真实模型，离线时明确降级。','ZhixueSkillTutor'],
  ['classroom-interaction-generator','课堂互动设计','根据班级薄弱点和常见错误生成分层课堂活动。','ZhixueSkillInteraction'],
  ['course-content-optimizer','课程内容优化','依据学情和反馈生成待教师确认的课程调整建议。','ZhixueSkillContentOptimizer'],
  ['teacher-answer-manager','教师答疑管理','聚合问题、生成回复草案和 FAQ，教师确认后发送。','ZhixueSkillAnswerManager'],
  ['knowledge-base-curator','知识库构建与治理','治理 K0/K1/K2 知识的切片、来源、版本和检索字段。','ZhixueSkillKnowledgeCurator'],
  ['student-profile-analyzer','学生学习画像分析','基于授权学习证据形成可解释画像，不推断敏感人格属性。','ZhixueSkillStudentProfile'],
  ['personalized-learning-planner','个性化学习方案制定','按个人画像自动生成生效方案，并允许任课教师查看和调整。','ZhixueSkillLearningPlanner'],
  ['exercise-coach','练习生成与错因诊断','围绕个人薄弱点生成分级练习、提示和错误分类。','ZhixueSkillExerciseCoach'],
  ['learning-effect-evaluator','学习效果评估','比较计划前后证据并给出下一轮调整建议。','ZhixueSkillEffectEvaluator'],
];
const SKILLS=Object.fromEntries(definitions.map(([name,label,description,exportName])=>[name,{name,label,description,engine:'Zhixue Local Runtime',status:'已接入',module:()=>global[exportName]}]));
function isReady(name){try{return Boolean(SKILLS[name]?.module())}catch{return false}}
function snapshot(){const skills=Object.values(SKILLS).map(s=>({skill_id:s.name,label:s.label,description:s.description,engine:s.engine,status:isReady(s.name)?'ready':'missing'}));return{engine:'Zhixue Local Runtime',skill_count:skills.length,skills}}
global.ZhixueSkillRegistry={SKILLS,isReady,snapshot};
})(window);
