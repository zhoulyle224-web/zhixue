/** course-ai-tutor：只根据调用方显式提供的当前课程资料回答。 */
(function (global) {
  'use strict';
  const SKILL_VERSION = 'course-ai-tutor@local-1.1';
  function pending(reason) {
    return { answer_status: '待人工处理', answer_content: '当前课程资料不足以支持可靠回答，需由教师确认。', related_knowledge: [], guide_questions: [], _refs: [], _evidence: [], _skill_version: SKILL_VERSION, _reason: reason };
  }
  function score(question, item) {
    const q = String(question).toLowerCase();
    const tags = Array.isArray(item.tags) ? item.tags : [];
    let points = 0;
    for (const tag of tags) if (String(tag).trim() && q.includes(String(tag).toLowerCase())) points += Math.min(4, String(tag).length + 1);
    const title = String(item.title || '').toLowerCase();
    if (title.length >= 2 && q.includes(title)) points += 4;
    return points;
  }
  function answer(input) {
    input = input || {};
    const question = String(input.student_question || '').trim();
    const kb = Array.isArray(input.knowledge_base) ? input.knowledge_base : [];
    if (!question) return pending('empty_question');
    if (!kb.length) return pending('knowledge_unavailable');
    const hits = kb.map((item, index) => ({ item, index, points: score(question, item) }))
      .filter(hit => hit.points > 0 && String(hit.item.text || '').trim() && String(hit.item.locator || '').trim())
      .sort((a, b) => b.points - a.points || a.index - b.index).slice(0, 3).map(hit => hit.item);
    if (!hits.length) return pending('no_current_course_evidence');
    const refs = hits.map(hit => String(hit.ref));
    const guides = [...new Set(hits.flatMap(hit => Array.isArray(hit.guide_questions) ? hit.guide_questions : []))].slice(0, 3);
    const related = [...new Set(hits.flatMap(hit => Array.isArray(hit.tags) ? hit.tags : []))].slice(0, 4);
    const answerText = [
      '## 核心知识点\n\n' + hits.map(hit => String(hit.text).trim()).join('\n\n'),
      '## 解题/理解思路\n\n' + hits.map(hit => String(hit.method || '').trim()).filter(Boolean).join('\n\n'),
      '## 答案与总结\n\n' + hits.map(hit => String(hit.summary || '').trim()).filter(Boolean).join('\n\n') + '\n\n依据：' + refs.join('；'),
    ].join('\n\n').slice(0, 1200);
    return {
      answer_status: '已解答', answer_content: answerText,
      related_knowledge: related, guide_questions: guides, _refs: refs,
      _evidence: hits.map(hit => ({ resourceId: hit.resource_id, dbResourceId: hit.db_resource_id,
        courseCode: hit.course_code, courseName: hit.course_name, title: hit.title,
        resourceType: hit.type, locator: hit.locator, chunkId: hit.chunk_id,
        version: hit.version, synthetic: hit.synthetic, sourceLabel: hit.source_label })),
      _skill_version: SKILL_VERSION,
    };
  }
  global.ZhixueSkillTutor = { answer, SKILL_VERSION };
})(window);
