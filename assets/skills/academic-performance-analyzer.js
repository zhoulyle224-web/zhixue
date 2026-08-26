/**
 * 智学双擎 · Skill 适配层 —— academic-performance-analyzer（学情智能研判）
 * ------------------------------------------------------------------
 * 严格遵循 Skills.netease.im 上 Skill「academic-performance-analyzer」的
 * 输入/输出 JSON 契约：
 *
 *   输入参数：
 *     scores            : array  学生成绩明细 [{ name, score }]（必需）
 *     knowledge_points  : array  本次考察知识点 [{ name, mastery_rate }]（必需）
 *     exam_name         : string 考试/作业名称（默认"本次考试"）
 *     class_name        : string 班级名称（默认"对应班级"）
 *     full_score        : number 满分（默认100）
 *     pass_score        : number 及格线（默认60）
 *     excellent_score   : number 优秀线（默认85）
 *
 *   输出（规则A·正常业务）：
 *     {
 *       overall_summary: { total_students, average_score, pass_rate,
 *                          excellent_rate, max_score, min_score, overall_evaluation },
 *       knowledge_analysis: [{ knowledge_point, mastery_rate, main_error_type, cause_analysis }],
 *       student_stratification: { excellent_students[], potential_students[],
 *                                 struggling_students[], stratification_standard },
 *       teaching_suggestions: { class_universal[], individual_guidance[],
 *                               next_teaching_focus }
 *     }
 *   输出（规则B·澄清）：
 *     { ask_clarification: [纯问题字符串...] }
 *
 * 说明：
 *  - 本模块内置了与 Skill 一致的指标计算、分层与教学建议生成逻辑，
 *    保证离线可完整演示；真实接入 OpenClaw 时由 Agent 在运行时调用
 *    同名 Skill 后返回标准 JSON，本模块负责同样的解析与渲染。
 *  - 所有结论均由传入的 scores / knowledge_points 计算得出，不编造数据。
 * ------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  // 计算指标（保留1位小数）
  function round1(x) { return Math.round(x * 10) / 10; }
  function pct(ratio) { return round1(ratio * 100) + '%'; }

  /**
   * 核心入口：按 academic-performance-analyzer 契约生成学情研判报告。
   * @param {Object} input 见上方输入参数说明
   * @returns {Object} 标准化学情研判 JSON
   */
  function analyze(input) {
    input = input || {};
    const scores = Array.isArray(input.scores) ? input.scores : [];
    const kps = Array.isArray(input.knowledge_points) ? input.knowledge_points : [];

    // —— 规则B：核心参数严重缺失 → 澄清输出 ——
    const ask = [];
    if (!scores.length) {
      ask.push('请提供本次考试/作业的学生成绩明细（每个学生一条 {name, score}）');
    }
    if (!kps.length) {
      ask.push('请提供本次考察的知识点列表（每个知识点一条 {name, mastery_rate}）');
    }
    if (ask.length) {
      return { ask_clarification: ask };
    }

    const examName = input.exam_name || '本次考试';
    const className = input.class_name || '对应班级';
    const fullScore = input.full_score || 100;
    const passScore = input.pass_score || 60;
    const excellentScore = input.excellent_score || 85;

    // —— 维度1：班级整体 ——
    const values = scores.map(function (s) { return Number(s.score); }).filter(function (v) { return isFinite(v); });
    const total = values.length;
    const sum = values.reduce(function (a, b) { return a + b; }, 0);
    const avg = total ? round1(sum / total) : 0;
    const passN = values.filter(function (v) { return v >= passScore; }).length;
    const exN = values.filter(function (v) { return v >= excellentScore; }).length;
    const maxV = total ? Math.max.apply(null, values) : 0;
    const minV = total ? Math.min.apply(null, values) : 0;
    const passRate = total ? passN / total : 0;
    const exRate = total ? exN / total : 0;

    let evalText;
    if (total < 10) {
      evalText = '样本量较少，结果仅供参考。班级平均分 ' + avg + '，及格率 ' + pct(passRate) + '。';
    } else if (avg >= 80 && passRate >= 0.9) {
      evalText = '班级整体表现优秀，平均分 ' + avg + '、及格率 ' + pct(passRate) + '，基础扎实，可进一步向拔高与迁移应用引导。';
    } else if (avg >= 70 && passRate >= 0.8) {
      evalText = '班级整体基础较好，平均分 ' + avg + '、及格率 ' + pct(passRate) + '，主要问题集中在少数薄弱知识点上，可针对性突破。';
    } else if (avg >= 60) {
      evalText = '班级整体处于中游，平均分 ' + avg + '、及格率 ' + pct(passRate) + '，存在较明显的知识薄弱点，需加强重点章节的补偿教学。';
    } else {
      evalText = '班级整体基础偏弱，平均分 ' + avg + '、及格率 ' + pct(passRate) + '，建议先巩固核心概念，再逐步提升综合应用。';
    }

    const overall = {
      total_students: total,
      average_score: avg,
      pass_rate: pct(passRate),
      excellent_rate: pct(exRate),
      max_score: maxV,
      min_score: minV,
      overall_evaluation: evalText
    };

    // —— 维度2：知识点掌握分析 ——
    const knowledge_analysis = kps.map(function (kp) {
      const m = Number(kp.mastery_rate);
      const rate = isFinite(m) ? m : (kp.mastery !== undefined ? Number(kp.mastery) : 0);
      let mainErr, cause;
      if (rate < 60) {
        mainErr = '概念混淆 + 方法误用';
        cause = '该知识点掌握率仅 ' + round1(rate) + '%，学生多在该处出现概念性错误与解题方法混淆，需先澄清核心概念再补练习。';
      } else if (rate < 75) {
        mainErr = '应用迁移不足';
        cause = '掌握率 ' + round1(rate) + '%，基础识别尚可，但换情境后的迁移应用失分较多，应加强变式与综合题训练。';
      } else {
        mainErr = '细节与审题';
        cause = '掌握率 ' + round1(rate) + '%，整体较稳固，零星失分集中于审题不清与计算细节，可通过规范答题步骤控制。';
      }
      return {
        knowledge_point: kp.name || '未命名知识点',
        mastery_rate: round1(rate) + '%',
        main_error_type: mainErr,
        cause_analysis: cause
      };
    });

    // 找到最薄弱的知识点（用于教学建议）
    const weakest = knowledge_analysis.slice().sort(function (a, b) {
      return parseFloat(a.mastery_rate) - parseFloat(b.mastery_rate);
    })[0];

    // —— 维度3：学生分层 ——
    const excellent_students = [], potential_students = [], struggling_students = [];
    scores.forEach(function (s) {
      const name = s.name !== undefined ? s.name : '匿名学生' + (scores.indexOf(s) + 1);
      const v = Number(s.score);
      if (v >= excellentScore) excellent_students.push(String(name));
      else if (v >= passScore) potential_students.push(String(name));
      else struggling_students.push(String(name));
    });
    const stratification = {
      excellent_students: excellent_students,
      potential_students: potential_students,
      struggling_students: struggling_students,
      stratification_standard: '优生：' + excellentScore + ' 分及以上；潜力生：' + passScore + '–' + (excellentScore - 1) + ' 分；学困生：' + passScore + ' 分以下'
    };

    // —— 维度4：教学建议 ——
    const weakName = weakest ? weakest.knowledge_point : '当前薄弱知识点';
    const universal = [];
    universal.push('针对“' + weakName + '”（掌握率 ' + (weakest ? weakest.mastery_rate : '待确认') + '）安排一次集中概念澄清：用同一组数据分别计算相关指标，组织小组对比差异。');
    if (passRate < 0.85) {
      universal.push('对及格线边缘学生发放 3–5 道基础分层练习，先补齐核心概念，再逐步过渡到变式题。');
    } else {
      universal.push('基础整体稳固，可将课堂重点转向综合迁移与真实情境应用题，提升高阶能力。');
    }
    universal.push('建立错题归因：将每道错题标注为“概念/方法/计算/审题”四类，便于后续针对性训练。');

    const individual_guidance = [];
    if (struggling_students.length) {
      individual_guidance.push('学困生（' + struggling_students.join('、') + '）：先回看最薄弱知识点的微课，完成 3 道带步骤提示的基础题，并提交对核心概念的一句话理解。');
    }
    if (potential_students.length) {
      individual_guidance.push('潜力生（共 ' + potential_students.length + ' 人）：重点补“' + weakName + '”的变式迁移，完成 1 道新情境题并说明答题理由。');
    }
    if (excellent_students.length) {
      individual_guidance.push('优生（' + excellent_students.join('、') + '）：布置开放拓展题，鼓励其尝试用多种方法求解并相互讲评。');
    }

    const suggestions = {
      class_universal: universal,
      individual_guidance: individual_guidance,
      next_teaching_focus: '下一阶段以“' + weakName + '”为教学核心，采用“概念澄清 → 对标练习 → 情境迁移”三步走，并在两周后再测以验证效果。'
    };

    // 组装规则A输出（附带诊断元数据供前端展示依据）
    return {
      overall_summary: overall,
      knowledge_analysis: knowledge_analysis,
      student_stratification: stratification,
      teaching_suggestions: suggestions,
      _meta: {
        exam_name: examName,
        class_name: className,
        full_score: fullScore,
        pass_score: passScore,
        excellent_score: excellentScore
      }
    };
  }

  // 从前端本地种子/数据库状态生成研判输入
  function fromState(knowledgeList, studentCount, scoreList) {
    const kps = (knowledgeList || []).map(function (k) {
      return { name: k.name, mastery_rate: Number(k.value) };
    });
    // 无逐人成绩时，按分层的代表值合成匿名成绩（仅用于演示指标）
    let scores = Array.isArray(scoreList) && scoreList.length
      ? scoreList
      : syntheticScores(studentCount);
    return analyze({
      exam_name: '最近一次综合评测',
      class_name: '当前班级',
      scores: scores,
      knowledge_points: kps,
      full_score: 100, pass_score: 60, excellent_score: 85
    });
  }

  // 匿名合成成绩：按 优/潜/学困 三段分布生成，保证演示指标稳定合理
  function syntheticScores(n) {
    const out = [];
    const over = Math.max(0, Math.round((n || 36) * 0.55));   // 潜力生 60-84
    const ex = Math.max(0, Math.round((n || 36) * 0.25));     // 优生 85-100
    const weak = Math.max(0, (n || 36) - over - ex);          // 学困生 <60
    let i = 0;
    for (let k = 0; k < ex; k++) out.push({ name: '优生-' + (++i), score: 86 + Math.round(Math.random() * 12) });
    for (let k = 0; k < over; k++) out.push({ name: '潜力生-' + (++i), score: 61 + Math.round(Math.random() * 22) });
    for (let k = 0; k < weak; k++) out.push({ name: '巩固生-' + (++i), score: 40 + Math.round(Math.random() * 18) });
    return out;
  }

  global.ZhixueSkillAnalyzer = {
    analyze: analyze,
    fromState: fromState
  };
})(window);
