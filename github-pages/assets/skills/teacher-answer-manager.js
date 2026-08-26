/**
 * 智学双擎 · Skill 适配层 —— teacher-answer-manager（课后答疑管理）
 * ------------------------------------------------------------------
 * 遵循 Skills.netease.im 上同名 Skill 的契约（教师侧答疑管理）：
 *
 *   输入：course_name、questions[{ student, question, status, asked_at }]（学生提问记录）、
 *        existing_faq[]（可选）
 *   输出：标准答疑管理 JSON
 *      {
 *        aggregate: [{ topic, question_count, share_enabled, students , representative_question }],
 *        unified_answers: [{ topic, answer, references }],
 *        faq_updates:     [{ question, answer, action }],
 *        remedial_targets:[{ student, weakness, action }],
 *        summary:         一句话处理结论
 *      }
 *   缺参（无提问记录）时返回 { ask_clarification: [...] }
 * ------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  function shard(topics) {
    const bucket = {};
    topics.forEach(function (t) {
      const k = String(t).trim();
      if (!k) return;
      if (!bucket[k]) bucket[k] = 0;
      bucket[k] += 1;
    });
    return Object.keys(bucket)
      .map(function (k) { return { topic: k, count: bucket[k] }; })
      .sort(function (a, b) { return b.count - a.count; });
  }

  function analyze(input) {
    input = input || {};
    const course = String(input.course_name || '').trim();
    const qs = Array.isArray(input.questions) ? input.questions : [];

    // 规则 B：没有学生提问记录 → 澄清
    if (qs.length === 0) {
      return { ask_clarification: ['请提供学生课后提问记录（学生、问题、状态），以便聚合高频问题并生成统一解答。'] };
    }

    // 粗略主题归类
    const topics = qs.map(function (q) {
      const text = String(q.question || q.text || '').trim();
      if (/回归|拟合|过拟合/.test(text)) return '模型回归与拟合理解';
      if (/评估|指标|准确率|召回率|混淆/.test(text)) return '模型评估指标区分';
      if (/二叉树|遍历|深度|叶子/.test(text)) return '二叉树遍历与结构';
      if (/排序|复杂度|查找/.test(text)) return '排序算法与复杂度';
      if (/泛化|样本|数据/.test(text)) return '泛化与数据划分';
      return '概念辨析与应用';
    });

    const shards = shard(topics);
    const topTopic = shards.length ? shards[0].topic : '高频问题';
    const total = qs.length;

    const aggregate = shards.map(function (s) {
      const students = qs.filter(function (q, i) { return topics[i] === s.topic; })
        .map(function (q) { return q.student || q.student_id || '未署名'; });
      return {
        topic: s.topic,
        question_count: s.count,
        share_enabled: true,
        students: students.slice(0, 6),
        representative_question: (qs[topics.indexOf(s.topic)] || {}).question || ''
      };
    });

    function answerFor(topic) {
      if (topic.indexOf('回归') !== -1) return '回归用于刻画变量间关系，重点理解损失函数与过拟合风险；可通过训练/验证曲线判断拟合程度。';
      if (topic.indexOf('评估') !== -1) return '准确率衡量整体正确，召回率关注正例查全，混淆矩阵是计算它们的基础，先区分正负例定义再套公式。';
      if (topic.indexOf('二叉树') !== -1) return '先序遍历根最先，中序遍历根居中，后序遍历根最后；理解递归序即可推出三种序列。';
      if (topic.indexOf('排序') !== -1) return '复杂度关注比较与交换次数；如归并稳定 O(n log n)，快排平均 O(n log n) 但最坏 O(n²)。';
      if (topic.indexOf('泛化') !== -1) return '训练集与测试集应无信息泄漏，交叉验证比单次划分更稳健地评估泛化能力。';
      return '建议结合教材定义与一个示例逐步推导，若仍不理解建议到答疑时间点对点讲解。';
    }
    const unified = shards.map(function (s) {
      return { topic: s.topic, answer: answerFor(s.topic), references: ['课件对应章节', s.share ? '统一答疑板' : '补充讲义'] };
    });

    // FAQ 更新：新增高频主题，已有 FAQ 内命中则 update
    const existing = Array.isArray(input.existing_faq) ? input.existing_faq : [];
    const knownQ = existing.map(function (f) { return String(f.question || ''); });
    const faq_updates = shards.map(function (s) {
      const hit = s.representative_question && knownQ.indexOf(s.representative_question) !== -1;
      return {
        question: s.representative_question || '关于「' + s.topic + '」的常见疑问',
        answer: answerFor(s.topic),
        action: hit ? 'update（已有条目，更新解答）' : 'create（新增 FAQ 条目）'
      };
    });

    // 待重点辅导：识别提问中暴露较弱的、且重复提问的学生
    const byStudent = {};
    qs.forEach(function (q, i) {
      const s = q.student || q.student_id || '未署名';
      if (!byStudent[s]) byStudent[s] = { count: 0, topics: [] };
      byStudent[s].count += 1;
      if (byStudent[s].topics.indexOf(topics[i]) === -1) byStudent[s].topics.push(topics[i]);
    });
    const remedial_targets = Object.keys(byStudent)
      .filter(function (s) { return byStudent[s].count >= 2; })
      .map(function (s) {
        return { student: s, weakness: byStudent[s].topics.join('、'), action: '安排针对薄弱点的个性化辅导与复测' };
      });

    return {
      aggregate: aggregate,
      unified_answers: unified,
      faq_updates: faq_updates,
      remedial_targets: remedial_targets,
      summary: '共聚合 ' + shards.length + ' 类高频问题（' + total + ' 条提问），命中「' + topTopic + '」为最集中话题，已生成统一解答与 ' + remedial_targets.length + ' 位待重点辅导名单。'
    };
  }

  global.ZhixueSkillAnswerManager = {
    analyze: analyze
  };
})(window);
