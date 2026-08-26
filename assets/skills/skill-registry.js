/**
 * 智学双擎 · Skill 系统总控（skill-registry）
 * ------------------------------------------------------------------
 * 集中注册本项目已接入的 OpenClaw/帝王蟹 Skill 适配层，供前端统一调用、
 * 统一显示接入状态。每个 Skill 暴露标准 JSON 输入/输出，与
 * Skills.netease.im 平台上的同名 Skill 契约一致。
 * ------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  // 已接入的 Skill 清单（真实场景可在此动态注册更多 Skill）
  const SKILLS = {
    'academic-performance-analyzer': {
      name: 'academic-performance-analyzer',
      label: '学情智能研判',
      description: '基于成绩数据进行学情分析、教学诊断、学生分层与教学改进建议，输出标准化学情研判 JSON。',
      engine: 'OpenClaw',
      status: '已接入',
      module: function () { return global.ZhixueSkillAnalyzer; }
    },
    'course-ai-tutor': {
      name: 'course-ai-tutor',
      label: '课程AI学习助教',
      description: '以学生身份提出课程学习问题时触发，基于课程知识库解答、提供学习指导与引导思考，输出标准化答疑 JSON。',
      engine: 'OpenClaw',
      status: '已接入',
      module: function () { return global.ZhixueSkillTutor; }
    },
    'classroom-interaction-generator': {
      name: 'classroom-interaction-generator',
      label: '课堂互动生成',
      description: '围绕指定知识点生成课堂互动方案、互动题目与教学游戏，输出标准课堂互动方案 JSON。',
      engine: 'OpenClaw',
      status: '已接入',
      module: function () { return global.ZhixueSkillInteraction; }
    },
    'course-content-optimizer': {
      name: 'course-content-optimizer',
      label: '课程内容迭代',
      description: '基于学生薄弱点与反馈生成课程内容迭代方案（章节调整、案例更新、考核建议），输出标准课程优化 JSON。',
      engine: 'OpenClaw',
      status: '已接入',
      module: function () { return global.ZhixueSkillContentOptimizer; }
    },
    'teacher-answer-manager': {
      name: 'teacher-answer-manager',
      label: '课后答疑管理',
      description: '聚合学生课后提问为高频主题，自动生成统一解答与 FAQ，识别待重点辅导学生，输出标准答疑管理 JSON。',
      engine: 'OpenClaw',
      status: '已接入',
      module: function () { return global.ZhixueSkillAnswerManager; }
    }
  };

  // 查询某个 Skill 是否已接入
  function isReady(name) {
    const s = SKILLS[name];
    if (!s) return false;
    try { return !!s.module(); } catch (e) { return false; }
  }

  // 获取全部 Skill 状态（用于界面展示 / 导出）
  function snapshot() {
    const out = [];
    Object.keys(SKILLS).forEach(function (name) {
      const s = SKILLS[name];
      out.push({
        skill_id: name,
        label: s.label,
        description: s.description,
        engine: s.engine,
        status: isReady(name) ? 'ready' : 'missing',
      });
    });
    return { engine: 'OpenClaw / 帝王蟹', skill_count: out.length, skills: out };
  }

  global.ZhixueSkillRegistry = {
    SKILLS: SKILLS,
    isReady: isReady,
    snapshot: snapshot
  };
})(window);
