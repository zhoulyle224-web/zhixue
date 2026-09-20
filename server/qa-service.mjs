import { randomUUID } from "node:crypto";
import { loadCourseKnowledge, validateEvidence } from "./course-knowledge.mjs";
import { loadCommonKnowledge } from "./common-knowledge.mjs";
import { generateWithProvider, providerStatus } from "./model-provider.mjs";

export class QaError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export function resolveStudentCourse(db, studentContext, offeringId) {
  if (!/^student:S\d{6,}$/.test(String(studentContext || ""))) throw new QaError("QA_STUDENT_CONTEXT_INVALID", "学生课程上下文格式不正确。");
  const studentNo = studentContext.slice(8);
  const student = db.prepare("SELECT id, student_no, class_id FROM students WHERE student_no = ?").get(studentNo);
  if (!student) throw new QaError("QA_STUDENT_NOT_FOUND", "学生记录不存在。", 404);
  const id = Number(offeringId);
  const row = Number.isSafeInteger(id) && id > 0 ? db.prepare(`SELECT o.id AS offeringId, c.id AS courseId, c.course_code AS courseCode,
    c.course_name AS courseName FROM course_offerings o JOIN courses c ON c.id = o.course_id WHERE o.id = ?`).get(id) : null;
  if (!row) throw new QaError("QA_OFFERING_NOT_FOUND", "课程教学班不存在。", 404);
  const enrolled = db.prepare("SELECT 1 FROM enrollments WHERE student_id = ? AND offering_id = ? AND status = '修读中'").get(student.id, id);
  const inClass = db.prepare("SELECT 1 FROM offering_classes WHERE offering_id = ? AND class_id = ?").get(id, student.class_id);
  if (!enrolled || !inClass) throw new QaError("QA_COURSE_FORBIDDEN", "该学生未选修当前教学班。", 403);
  return { studentNo, classId: student.class_id, ...row, teacherContext: `teacher:${id}:${student.class_id}` };
}

export function resolveTeacherContext(db, context) {
  const match = /^teacher:(\d+):(\d+)$/.exec(String(context || ""));
  if (!match) throw new QaError("QA_TEACHER_CONTEXT_INVALID", "教师课程与班级上下文格式不正确。");
  const offeringId = Number(match[1]), classId = Number(match[2]);
  const exists = db.prepare("SELECT 1 FROM offering_classes WHERE offering_id = ? AND class_id = ?").get(offeringId, classId);
  if (!exists) throw new QaError("QA_TEACHER_CONTEXT_INVALID", "教师课程与班级上下文不存在。");
  return { offeringId, classId, context };
}

export async function getQaResources(db, studentContext, offeringId) {
  const course = resolveStudentCourse(db, studentContext, offeringId);
  const pack = await loadCourseKnowledge(course, db);
  const common = await loadCommonKnowledge();
  return { course: { offeringId: course.offeringId, courseId: course.courseId, courseCode: course.courseCode, courseName: course.courseName },
    knowledgeVersion: pack.version, knowledgeAvailable: pack.resources.length > 0,
    commonKnowledgeVersion: common.version, commonKnowledgeCount: common.entries.length,
    mode: providerStatus().configured ? "model-assisted" : "offline-retrieval",
    provider: providerStatus(),
    synthetic: true, sourceLabel: pack.sourceLabel,
    resources: pack.resources.map(({ resourceHash, ...publicResource }) => publicResource),
    sampleQuestions: pack.resources.length ? pack.sampleQuestions : [] };
}

export function qaRecordResponse(record) {
  return { questionId: record.questionId,
    session_id: record.sessionId,
    answer_status: record.status === "teacher_replied" ? "教师已回复" : record.answerState || (record.status === "answered" ? "已解答" : "已转教师"),
    answer_content: record.assistantAnswer, related_knowledge: record.relatedKnowledge,
    answer_source_type: record.answerSourceType, confidence: record.confidence,
    model_provider: record.modelProvider, personalization_basis: record.personalizationBasis,
    guide_questions: record.guideQuestions, _refs: record.evidence.map(e => `《${e.title}》· ${e.locator}`),
    _evidence: record.evidence, course: record.course, knowledgeVersion: record.knowledgeVersion,
    skillVersion: record.skillVersion, handoff: { created: record.handoffStatus !== "not_required", status: record.handoffStatus },
    safe_question: record.question, status: record.status, teacherReply: record.teacherReply,
    createdAt: record.createdAt, repliedAt: record.repliedAt };
}

export async function answerQa({ db, runtimeStore, tutor, studentContext, offeringId, question, clientRequestId, studentLevel, piiRedacted, audit, sessionId, personalizationBasis = [], autoHandoff = true, includeCommon = false }) {
  const course = resolveStudentCourse(db, studentContext, offeringId);
  const requestId = clientRequestId || randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new QaError("QA_DUPLICATE_REQUEST", "请求编号格式不正确。");
  const previous = runtimeStore.getQaByRequest(studentContext, requestId);
  if (previous) {
    if (previous.offeringId !== course.offeringId || previous.question !== question) throw new QaError("QA_DUPLICATE_REQUEST", "请求编号已经用于另一条问题。", 409);
    return { ...qaRecordResponse(previous), pii_redacted: piiRedacted, idempotent: true };
  }
  let conversationHistory = [];
  if (sessionId) {
    const qaSession = runtimeStore.getQaSession(sessionId);
    if (!qaSession || qaSession.student_context !== studentContext || Number(qaSession.offering_id) !== course.offeringId) throw new QaError("QA_SESSION_FORBIDDEN", "该问答会话不属于当前学生与课程。", 403);
    conversationHistory = runtimeStore.getQaSessionHistory(sessionId, 4).flatMap(row => [{ role:"student", content:row.question }, { role:"assistant", content:row.assistantAnswer }]);
  }
  const [pack, common] = await Promise.all([loadCourseKnowledge(course, db), loadCommonKnowledge()]);
  const result = tutor.answer({ student_question: question, course_name: course.courseName,
    knowledge_base: pack.knowledgeBase, common_knowledge: includeCommon ? common.entries : undefined,
    conversation_history: conversationHistory, student_level: studentLevel || "普通",
    personalization_basis: personalizationBasis });
  const answered = result.answer_status === "已解答";
  const courseEvidence = (result._evidence || []).filter(item => item.knowledgeLayer === "K2" || item.courseCode);
  const courseRefs = courseEvidence.map(item => `《${item.title}》· ${item.locator}`);
  const commonEvidence = (result._evidence || []).filter(item => ["K0","K1"].includes(item.knowledgeLayer));
  const commonValid = commonEvidence.every(item => item.knowledgeLayer === "K0" && item.sourceLabel === "确定性计算器" ||
    common.entries.some(source => source.id === item.knowledgeId && source.layer === item.knowledgeLayer && source.locator === item.locator));
  if (answered && ((!courseEvidence.length && !commonEvidence.length) || (courseEvidence.length && !validateEvidence(courseEvidence, courseRefs, pack.knowledgeBase, course.courseCode)) || !commonValid)) {
    await audit({ actorRole: "student", action: "qa_evidence_rejected", objectType: "qa", objectRef: course.courseCode, result: "blocked", courseCode: course.courseCode });
    throw new QaError("QA_EVIDENCE_INVALID", "课程引用校验失败，请稍后重试。", 500);
  }
  let provider = { provider:"offline", model:null }, assistantAnswer = result.answer_content;
  if (answered && providerStatus().configured) {
    const selected = [...courseEvidence.map(item => pack.knowledgeBase.find(source => source.resource_id===item.resourceId&&source.chunk_id===item.chunkId)), ...commonEvidence.map(item => common.entries.find(source => source.id===item.knowledgeId))].filter(Boolean);
    try { const generated = await generateWithProvider({ question, courseName:course.courseName, evidence:selected, history:conversationHistory, studentLevel }); if(generated){assistantAnswer=generated.content;provider=generated;} } catch (error) { provider={provider:"offline-fallback",model:null,errorCode:error.name==='AbortError'?'MODEL_TIMEOUT':'MODEL_UNAVAILABLE'}; }
  }
  const shouldHandoff = !answered && autoHandoff;
  const status = answered || !shouldHandoff ? "answered" : "pending_teacher";
  if (!answered && shouldHandoff) assistantAnswer = `当前《${course.courseName}》课程资料和公共基础知识不足以支持这个问题，已转教师确认。`;
  let saved;
  try {
    saved = runtimeStore.writeQa({ clientRequestId: requestId, studentContext, studentNo: course.studentNo,
      classId: course.classId, offeringId: course.offeringId, courseId: course.courseId,
      courseCode: course.courseCode, courseName: course.courseName, question,
      status, assistantAnswer, evidence: answered ? result._evidence : [],
      relatedKnowledge: result.related_knowledge || [],
      guideQuestions: result.guide_questions || result.follow_up_questions || [], knowledgeVersion: `${pack.version}+${common.version}`,
      skillId: "course-ai-tutor", skillVersion: result._skill_version || tutor.SKILL_VERSION,
      handoffStatus: shouldHandoff ? "pending" : "not_required", teacherContext: course.teacherContext,
      sessionId: sessionId || null, answerState: shouldHandoff ? "待人工处理" : result.answer_status,
      answerSourceType: result.answer_source_type || "无可靠依据", modelProvider: provider.model ? `${provider.provider}:${provider.model}` : provider.provider,
      confidence: result.confidence || "低", personalizationBasis: result.personalization_basis || personalizationBasis });
  } catch (error) {
    // A concurrent retry may have inserted the same request after the first lookup.
    const existing = runtimeStore.getQaByRequest(studentContext, requestId);
    if (existing && existing.offeringId === course.offeringId && existing.question === question) return { ...qaRecordResponse(existing), pii_redacted: piiRedacted, idempotent: true };
    console.error("QA 持久化失败：", error.message);
    throw new QaError(answered ? "QA_RECORD_FAILED" : "QA_HANDOFF_FAILED",
      answered ? "答疑记录未保存，请重试。" : "当前课程资料不足，且教师待办未同步成功。请重试或直接联系教师。", 503);
  }
  await audit({ actorRole: "student", context: studentContext, action: answered ? "qa_answer" : shouldHandoff ? "qa_handoff" : "qa_clarify_or_suggest",
    objectType: "qa", objectRef: saved.questionId, questionId: saved.questionId,
    courseCode: course.courseCode, result: status, redacted: piiRedacted });
  return { ...qaRecordResponse(saved), pii_redacted: piiRedacted };
}

export function createQaSession(db, runtimeStore, studentContext, offeringId, title) {
  const course = resolveStudentCourse(db, studentContext, offeringId);
  return runtimeStore.createQaSession(studentContext, course.offeringId, title || `《${course.courseName}》新对话`);
}

export async function handoffQa({ runtimeStore, studentContext, questionId, audit }) {
  const record = runtimeStore.getQa(questionId);
  if (!record || record.studentContext !== studentContext) throw new QaError("QA_RECORD_FORBIDDEN", "无权转交该问题。", 403);
  if (record.answerState !== "建议转教师" && record.answerState !== "需澄清") throw new QaError("QA_HANDOFF_NOT_REQUIRED", "该问题当前不需要转教师。", 409);
  const saved = runtimeStore.handoffQa(questionId, studentContext);
  if (!saved || saved.handoffStatus !== "pending") throw new QaError("QA_HANDOFF_FAILED", "问题未能转交教师，请重试。", 503);
  await audit({ actorRole:"student",context:studentContext,action:"qa_handoff_confirmed",objectType:"qa",objectRef:questionId,result:"pending" });
  return qaRecordResponse(saved);
}

export function getQaHistory(db, runtimeStore, studentContext, offeringId, limit) {
  const course = resolveStudentCourse(db, studentContext, offeringId);
  return runtimeStore.getStudentQa(studentContext, course.offeringId, Math.min(50, Math.max(1, Number(limit) || 20)))
    .map(({ clientRequestId, studentNo, studentContext: ignoredContext, teacherContext, ...publicRecord }) => publicRecord);
}

export function getQaInbox(db, runtimeStore, context, status, limit) {
  const { offeringId, classId } = resolveTeacherContext(db, context);
  if (!["all", "pending", "replied", "answered"].includes(status)) throw new QaError("QA_STATUS_INVALID", "待办筛选状态不正确。");
  return runtimeStore.getTeacherQa(offeringId, classId, status, Math.min(200, Math.max(1, Number(limit) || 50)))
    .map(({ clientRequestId, studentContext, studentNo, teacherContext, ...publicRecord }) => ({
      ...publicRecord, studentAlias: `${studentNo.slice(0, 3)}****${studentNo.slice(-2)}`,
    }));
}

export async function replyQa({ db, runtimeStore, questionId, context, reply, audit }) {
  resolveTeacherContext(db, context);
  const row = runtimeStore.getQa(questionId);
  if (!row) throw new QaError("QA_RECORD_NOT_FOUND", "问题记录不存在。", 404);
  if (row.teacherContext !== context) throw new QaError("QA_TEACHER_CONTEXT_MISMATCH", "该问题不属于当前课程班级。", 403);
  if (row.status === "answered") throw new QaError("QA_REPLY_NOT_ALLOWED", "已由课程资料解答的问题不在教师待办中。", 409);
  const saved = runtimeStore.replyQa(questionId, context, reply);
  await audit({ actorRole: "teacher", context, action: "qa_teacher_reply", objectType: "qa",
    objectRef: questionId, questionId, result: "teacher_replied", repliedAt: saved.repliedAt });
  return { questionId: saved.questionId, status: saved.status, repliedAt: saved.repliedAt, teacherReply: saved.teacherReply };
}
