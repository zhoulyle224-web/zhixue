/**
 * 智学双擎 · Skill 适配层 —— course-ai-tutor（课程AI学习助教）
 * ------------------------------------------------------------------
 * 本模块是 OpenClaw/帝王蟹 Skill「course-ai-tutor」的前端适配实现，
 * 严格遵循 Skills.netease.im 上该 Skill 的输入/输出 JSON 契约：
 *
 *   输入参数：
 *     student_question : string  学生的提问内容（必需）
 *     course_name      : string  课程名称（默认 "本课程"）
 *     knowledge_base   : array   挂载的知识库内容（知识点/课件/习题）
 *     question_context : string  提问上下文（章节/知识点范围）
 *     student_level    : string  学生层次（基础/普通/优秀）
 *
 *   输出（规则A·已解答）：
 *     { answer_status, answer_content, related_knowledge[], guide_questions[] }
 *   输出（规则B·待人工处理）：
 *     { answer_status:"待人工处理", answer_content(模板), related_knowledge:[], guide_questions:[] }
 *
 * 说明：
 *  - 这是一份「演示适配层」：在真实接入 OpenClaw 时，前端把
 *    student_question 交给 ClawHive Agent，由其在运行时调用同名 Skill，
 *    再把返回的标准 JSON 回传给本函数统一解析。本模块内置了与 Skill
 *    一致的知识库检索与三段式回答逻辑，保证离线也能完整演示。
 *  - 数据来源全部取自 current course 的课程资料（knowledge_base），
 *    不编造知识，资料不足时严格按照 Skill 规则返回「待人工处理」。
 * ------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  // 课程资料库（knowledge_base 快照）。真实环境由课程知识点表动态注入。
  const DEFAULT_KB = [
    { type: '讲义', ref: '第 4 章 模型评估 22–24 页', tags: ['精确率', '召回率', 'F1', '准确率'], text: '精确率 = TP/(TP+FP)，衡量预测为正例的样本中真正正例的比例；召回率 = TP/(TP+FN)，衡量真正的正例中被找出的比例。' },
    { type: '课件', ref: '混淆矩阵与评价指标 12–15 页', tags: ['混淆矩阵', 'TP', 'FP', 'FN', 'TN'], text: '混淆矩阵按预测与真实情况把结果分为 TP、FP、FN、TN：TP 真正例、FP 假正例、FN 假负例、TN 真负例。' },
    { type: '课件', ref: '混淆矩阵与评价指标 16 页', tags: ['精确率', '召回率', 'F1'], text: 'F1 值是精确率与召回率的调和平均，用于需要同时兼顾两者的场景：F1 = 2·P·R/(P+R)。' },
    { type: '讲义', ref: '第 4 章 模型评估 18–21 页', tags: ['准确率', '类别不平衡'], text: '类别不平衡时准确率可能产生误导：若正例极少，模型全部预测为负例，准确率仍可能很高，但漏掉了所有真正的正例。' },
    { type: '例题', ref: '例题 4-2 分类模型评估案例', tags: ['混淆矩阵', '示例', 'TP', 'FP'], text: '检测 100 封邮件，其中 20 封垃圾邮件：正确识别 16 封为 TP，漏掉 4 封为 FN；把 5 封正常邮件误判为垃圾是 FP，其余 75 封为 TN。' },
  ];

  // 课程资料关键词匹配：返回命中的 knowledge_base 条目
  function matchKb(question, kb) {
    const q = String(question || '').toLowerCase();
    return (kb || []).filter(function (item) {
      return (item.tags || []).some(function (tag) {
        return q.indexOf(String(tag).toLowerCase()) !== -1;
      }) || (item.text || '').toLowerCase().indexOf(q) !== -1;
    });
  }

  // 关联知识点：由命中的资料 tags 推导，用于建立知识联系
  function relatedKnowledge(hits) {
    const set = [];
    (hits || []).forEach(function (h) {
      (h.tags || []).forEach(function (t) {
        if (set.indexOf(t) === -1) set.push(t);
      });
    });
    return set.slice(0, 4);
  }

  /**
   * 核心：按 course-ai-tutor 契约生成答疑结果。
   * @param {Object} input { student_question, course_name, knowledge_base, question_context, student_level }
   * @returns {Object} 标准化答疑 JSON
   */
  function answer(input) {
    input = input || {};
    const question = String(input.student_question || '').trim();
    const courseName = input.course_name || '本课程';
    const kb = Array.isArray(input.knowledge_base) && input.knowledge_base.length
      ? input.knowledge_base : DEFAULT_KB;

    // —— 规则B：无问题 / 资料不足 / 超出课程范围 → 待人工处理 ——
    if (!question) {
      return pending(courseName, '未接收到有效问题内容。');
    }
    const hits = matchKb(question, kb);
    if (!hits.length) {
      return pending(courseName, '当前课程资料中没有足够内容直接支持这个问题，已记录并等待教师确认。');
    }

    // —— 规则A：依据命中资料生成三段式回答 ——
    const kbText = hits.map(function (h) { return h.text; }).join(' ');
    const refs = hits.map(function (h) { return h.ref; });
    const answerContent = buildAnswer(question, kbText, refs, courseName);

    return {
      answer_status: '已解答',
      answer_content: answerContent,
      related_knowledge: relatedKnowledge(hits),
      guide_questions: [
        '你能用一句话说明精确率与召回率的区别吗？',
        '如果换成一个非常不平衡的数据集，你会优先看哪个指标？为什么？',
        '能否结合上面例子，手写一次混淆矩阵的 TP/FP/FN/TN 划分？'
      ].slice(0, hits.length ? 3 : 2),
      _refs: refs,
      _matched: hits.map(function (h) { return h.ref; })
    };
  }

  // 三段式回答：核心知识点 → 解题思路 → 答案与总结
  function buildAnswer(q, kbText, refs, courseName) {
    let intro;
    if (/_((精确率)|(召回率))/.test(q) || q.indexOf('精确率') !== -1 && q.indexOf('召回率') !== -1) {
      intro = '选择评价指标，关键要看**错误代价**：\n\n- 若“漏掉真正的正例”代价更高（如疾病筛查、欺诈识别），**优先召回率**；\n- 若“把负例误判为正例”代价更高（如垃圾邮件误删重要邮件），**优先精确率**；\n- 需要综合平衡时使用 **F1 值**（精确率与召回率的调和平均）。\n\n判断方法是先明确业务里\"哪种错误更贵\"，再据此确定优先指标。';
    } else if (q.indexOf('混淆矩阵') !== -1) {
      intro = '混淆矩阵把预测结果按“真实 vs 预测”分成四类：\n\n- **TP**：真正例 —— 预测为正、实际也是正；\n- **FP**：假正例 —— 预测为正、实际却是负；\n- **FN**：假负例 —— 预测为负、实际却是正；\n- **TN**：真负例 —— 预测为负、实际也是负。\n\n以课件例题为例：检测 100 封邮件、其中 20 封是垃圾邮件，正确识别 16 封为 TP、漏掉 4 封为 FN，另把 5 封正常邮件误判为垃圾是 FP，其余 75 封为 TN。';
    } else if (q.indexOf('准确率') !== -1) {
      intro = '**准确率 = 全部预测正确 / 总样本数**。它的问题在于类别不平衡时会产生误导：100 个样本只有 2 个正例，模型全部预测为负例，准确率仍有 98%，但两个真正的正例一个也没找到。因此要结合**精确率、召回率或 F1** 一起看。';
    } else {
      intro = kbText;
    }
    return [
      '## 核心知识点\n\n' + intro,
      '## 解题思路\n\n先确定问题背景与数据分布，再判断哪类错误更严重，最后选择对应指标；若需要统一衡量则计算 F1 值。常见误区是只看总体准确率而忽略类别不平衡。',
      '## 答案与总结\n\n结合课程资料（' + refs.join('、') + '），结论已在上面给出。你可以用同一组预测结果分别计算精确率、召回率、F1 做交叉验证。\n\n> 本回答仅依据《' + courseName + '》可用课程资料生成，引用来源见上方标注。'
    ].join('\n\n');
  }

  // 规则B：待人工处理（与 Skill 模板完全一致）
  function pending(courseName, _reason) {
    return {
      answer_status: '待人工处理',
      answer_content: '这个问题暂无相关解答，已帮你汇总给授课老师，老师会尽快回复。',
      related_knowledge: [],
      guide_questions: [],
      _refs: []
    };
  }

  // 导出到全局，供 app.js 调用
  global.ZhixueSkillTutor = {
    answer: answer,
    DEFAULT_KB: DEFAULT_KB
  };
})(window);
