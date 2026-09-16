/**
 * 智学双擎 · Skill 适配层 —— course-content-optimizer（课程内容智能迭代）
 * ------------------------------------------------------------------
 * 遵循 Skills.netease.im 上 Skill「course-content-optimizer」的契约：
 *
 *   输入：course_name、current_outline（当前大纲）、weak_knowledge[{name,mastery_rate}]、
 *        student_feedback[]（可选）、teaching_notes（可选）
 *   输出：标准课程优化方案 JSON
 *      {
 *        iteration_summary: 一句话迭代结论,
 *        content_changes:  [{ knowledge_point, current_mastery, adjustment, priority }],
 *        chapter_adjustments: [{ chapter, adjustment, reason }],
 *        case_updates:       [{ topic, proposed_case, purpose }],
 *        assessment_updates: [{ type, focus, change }],
 *        implementation_plan:[{ step, action, timeline }]
 *      }
 *   缺参（无课程大纲或薄弱点时）返回 { ask_clarification: [...] }
 * ------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  function optimize(input) {
    input = input || {};
    const course = String(input.course_name || '').trim();
    const outline = String(input.current_outline || '').trim();
    const weak = Array.isArray(input.weak_knowledge) ? input.weak_knowledge : [];
    const feedback = Array.isArray(input.student_feedback) ? input.student_feedback : [];

    // 规则 B：缺少迭代依据（当前大纲或薄弱点）→ 澄清
    if (!outline || weak.length === 0) {
      const q = [];
      if (!outline) q.push('请提供当前课程大纲或章节结构，以便定位需要迭代的内容。');
      if (weak.length === 0) q.push('请提供学生薄弱知识点（含掌握率），作为内容迭代的依据。');
      return { ask_clarification: q };
    }

    const plan = weak.map(function (w) {
      const name = String(w.name || '').trim() || '待定位知识点';
      const rate = Number(w.mastery_rate);
      const r = isNaN(rate) ? 0 : Math.max(0, Math.min(100, rate));
      let adjustment;
      if (r < 55) {
        adjustment = '拆分讲解 + 补充平行练习与可视化示例，并纳入章节小结复测';
      } else if (r < 75) {
        adjustment = '增加应用型案例与易错辨析，教学设计上放慢推理速度';
      } else {
        adjustment = '保持现有讲解，转为拓展与进阶应用，避免重复耗时';
      }
      return {
        knowledge_point: name,
        current_mastery: r,
        adjustment: adjustment,
        priority: r < 55 ? '高' : (r < 75 ? '中' : '低')
      };
    });
    // 按薄弱度排序，最薄弱在前
    plan.sort(function (a, b) { return a.current_mastery - b.current_mastery; });

    const weakNames = plan.map(function (p) { return p.knowledge_point; });
    const top = plan[0] ? plan[0].knowledge_point : '最薄弱点';

    const chapter_adjustments = plan.slice(0, 2).map(function (p, i) {
      return {
        chapter: '相关章节 · 薄弱点「' + p.knowledge_point + '」',
        adjustment: p.current_mastery < 60 ? '重组课时权重并前置复测' : '增加小结回顾与章节小测',
        reason: p.knowledge_point + ' 当前掌握率 ' + p.current_mastery + '%，需针对性加固'
      };
    });

    const case_updates = [
      { topic: top, proposed_case: '贴近真实场景的「' + top + '」综合应用案例', purpose: '让学生在情境中巩固薄弱点' },
      { topic: '跨章节迁移', proposed_case: '将「' + weakNames.slice(0, 2).join('」与「') + '」串联的综合任务', purpose: '促成知识网络而非孤立记忆' }
    ];

    const assessment_updates = [
      { type: '课堂小测', focus: top, change: '增加 2 道针对该薄弱点的诊断题' },
      { type: '阶段考核', focus: weakNames.slice(0, 2).join('、'), change: '调整命题比例，覆盖薄弱知识点' },
      { type: '过程性评价', focus: '学习反馈', change: '综合学生反馈（' + feedback.length + ' 条）优化评价维度' }
    ];

    const implementation_plan = [
      { step: 1, action: '按「最薄弱优先」修订对应章节内容与课时', timeline: '第 1 周' },
      { step: 2, action: '上线新案例与针对性练习，并更新章节小结复测', timeline: '第 2 周' },
      { step: 3, action: '下一轮学情研判对比掌握率变化，确认迭代效果', timeline: '第 3-4 周' }
    ];

    return {
      iteration_summary: '围绕薄弱点「' + plan[0].knowledge_point + '」（掌握率 ' + plan[0].current_mastery + '%）优先迭代，共生成 ' + plan.length + ' 项内容调整与闭环复测计划。',
      content_changes: plan,
      chapter_adjustments: chapter_adjustments,
      case_updates: case_updates,
      assessment_updates: assessment_updates,
      implementation_plan: implementation_plan
    };
  }

  global.ZhixueSkillContentOptimizer = {
    optimize: optimize
  };
})(window);
