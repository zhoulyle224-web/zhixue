import { randomUUID } from "node:crypto";
import { loadCourseKnowledge, validateEvidence } from "./course-knowledge.mjs";

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
  return { course: { offeringId: course.offeringId, courseId: course.courseId, courseCode: course.courseCode, courseName: course.courseName },
    knowledgeVersion: pack.version, knowledgeAvailable: pack.resources.length > 0,
    synthetic: true, sourceLabel: pack.sourceLabel,
    resources: pack.resources.map(({ resourceHash, ...publicResource }) => publicResource),
    sampleQuestions: pack.resources.length ? pack.sampleQuestions : [] };
}

export function qaRecordResponse(record) {
  return { questionId: record.questionId,
    answer_status: record.status === "answered" ? "已解答" : record.status === "teacher_replied" ? "教师已回复" : "待人工处理",
    answer_content: record.assistantAnswer, related_knowledge: record.relatedKnowledge,
    guide_questions: record.guideQuestions, _refs: record.evidence.map(e => `《${e.title}》· ${e.locator}`),
    _evidence: record.evidence, course: record.course, knowledgeVersion: record.knowledgeVersion,
    skillVersion: record.skillVersion, handoff: { created: record.handoffStatus !== "not_required", status: record.handoffStatus },
    safe_question: record.question, status: record.status, teacherReply: record.teacherReply,
    createdAt: record.createdAt, repliedAt: record.repliedAt };
}

export async function answerQa({ db, runtimeStore, tutor, studentContext, offeringId, question, clientRequestId, studentLevel, piiRedacted, audit }) {
  const course = resolveStudentCourse(db, studentContext, offeringId);
  const requestId = clientRequestId || randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new QaError("QA_DUPLICATE_REQUEST", "请求编号格式不正确。");
  const previous = runtimeStore.getQaByRequest(studentContext, requestId);
  if (previous) {
    if (previous.offeringId !== course.offeringId || previous.question !== question) throw new QaError("QA_DUPLICATE_REQUEST", "请求编号已经用于另一条问题。", 409);
    return { ...qaRecordResponse(previous), pii_redacted: piiRedacted, idempotent: true };
  }
  const pack = await loadCourseKnowledge(course, db);
  const result = tutor.answer({ student_question: question, course_name: course.courseName,
    knowledge_base: pack.knowledgeBase, student_level: studentLevel || "普通" });
  const answered = result.answer_status === "已解答";
  if (answered && !validateEvidence(result._evidence, result._refs, pack.knowledgeBase, course.courseCode)) {
    await audit({ actorRole: "student", action: "qa_evidence_rejected", objectType: "qa", objectRef: course.courseCode, result: "blocked", courseCode: course.courseCode });
    throw new QaError("QA_EVIDENCE_INVALID", "课程引用校验失败，请稍后重试。", 500);
  }
  const status = answered ? "answered" : "pending_teacher";
  const assistantAnswer = answered ? result.answer_content : `当前《${course.courseName}》可用课程资料不足以支持这个问题，已转教师确认。`;
  let saved;
  try {
    saved = runtimeStore.writeQa({ clientRequestId: requestId, studentContext, studentNo: course.studentNo,
      classId: course.classId, offeringId: course.offeringId, courseId: course.courseId,
      courseCode: course.courseCode, courseName: course.courseName, question,
      status, assistantAnswer, evidence: answered ? result._evidence : [],
      relatedKnowledge: answered ? result.related_knowledge : [],
      guideQuestions: answered ? result.guide_questions : [], knowledgeVersion: pack.version,
      skillId: "course-ai-tutor", skillVersion: result._skill_version || tutor.SKILL_VERSION,
      handoffStatus: answered ? "not_required" : "pending", teacherContext: course.teacherContext });
  } catch (error) {
    // A concurrent retry may have inserted the same request after the first lookup.
    const existing = runtimeStore.getQaByRequest(studentContext, requestId);
    if (existing && existing.offeringId === course.offeringId && existing.question === question) return { ...qaRecordResponse(existing), pii_redacted: piiRedacted, idempotent: true };
    console.error("QA 持久化失败：", error.message);
    throw new QaError(answered ? "QA_RECORD_FAILED" : "QA_HANDOFF_FAILED",
      answered ? "答疑记录未保存，请重试。" : "当前课程资料不足，且教师待办未同步成功。请重试或直接联系教师。", 503);
  }
  await audit({ actorRole: "student", context: studentContext, action: answered ? "qa_answer" : "qa_handoff",
    objectType: "qa", objectRef: saved.questionId, questionId: saved.questionId,
    courseCode: course.courseCode, result: status, redacted: piiRedacted });
  return { ...qaRecordResponse(saved), pii_redacted: piiRedacted };
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
