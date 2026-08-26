/**
 * 智学双擎 · Skill 适配层 —— classroom-interaction-generator（课堂互动生成）
 * ------------------------------------------------------------------
 * 遵循 Skills.netease.im 上 Skill「classroom-interaction-generator」的契约：
 *
 *   输入：knowledge_point（核心知识点）及可选参数
 *   输出：标准课堂互动方案 JSON
 *      {
 *        interaction_package: { title, target_knowledge_point, estimated_minutes,
 *          rounds: [{ round, activity_type, objective, instructions, materials, assessment }] },
 *        follow_up_questions: [ ... ],
 *        game_or_activity: { name, rules, scoring, materials }
 *      }
 * ------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  function generate(input) {
    input = input || {};
    const kp = String(input.knowledge_point || '').trim() || '当前核心知识点';

    // 依据知识点关键词选择互动活动类型
    const lower = kp.toLowerCase();
    let activity;
    if (lower.indexOf('指标') !== -1 || lower.indexOf('评估') !== -1 || lower.indexOf('评价') !== -1) {
      activity = '情境判断 + 指标计算接力';
    } else if (lower.indexOf('二叉树') !== -1 || lower.indexOf('遍历') !== -1) {
      activity = '纸牌排序 + 遍历表演';
    } else if (lower.indexOf('排序') !== -1) {
      activity = '分组排序比赛';
    } else {
      activity = '概念抢答 + 应用配对';
    }

    return {
      interaction_package: {
        title: '理解「' + kp + '」的课堂互动',
        target_knowledge_point: kp,
        estimated_minutes: 12,
        rounds: [
          {
            round: 1,
            activity_type: '独立思考',
            objective: '激活学生对「' + kp + '」的已有认知',
            instructions: '每人先用 2 分钟写下对这个知识点的理解与一个常见误区。',
            materials: '白纸 / 平板答题',
            assessment: '收集关键词，识别共性误区'
          },
          {
            round: 2,
            activity_type: '小组协作',
            objective: '在真实情境中应用并辨析「' + kp + '」',
            instructions: '分组完成一次「' + kp + '」相关的情境应用题，并给出判断理由。',
            materials: '情境题卡一组',
            assessment: '小组互评：结论是否紧扣概念、理由是否充分'
          },
          {
            round: 3,
            activity_type: '全班展示与反馈',
            objective: '澄清误区、巩固正确理解',
            instructions: '小组代表展示结论，教师针对共性误区进行即时纠正并总结要点。',
            materials: '板书 / 电子白板',
            assessment: '随堂 2 题快测，确认掌握度提升'
          }
        ]
      },
      follow_up_questions: [
        '你能用自己的话再解释一遍「' + kp + '」吗？',
        '请举一个生活中用到「' + kp + '」的例子。',
        '尝试把「' + kp + '」与上一个章节的知识点联系起来。'
      ],
      game_or_activity: {
        name: activity + ' · 计分赛',
        rules: '分组抢答，答对加 2 分，答错扣 1 分，可求助组员一次；最终按积分排名。',
        scoring: '基础题 1 分、情境题 2 分、讲解题 3 分',
        materials: '题目卡 ×12、计分板、抢答器（可用举手替代）'
      }
    };
  }

  global.ZhixueSkillInteraction = {
    generate: generate
  };
})(window);
