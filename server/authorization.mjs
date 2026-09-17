import { AuthError } from "./auth-service.mjs";

export function requireRole(session, role) {
  if (session.role !== role) {
    throw new AuthError("AUTH_ROLE_FORBIDDEN", "当前登录身份无权执行该操作。", 403);
  }
  return session;
}

export function parseTeacherContext(context) {
  const match = /^teacher:(\d+):(\d+)$/.exec(String(context || ""));
  if (!match) throw new AuthError("AUTH_CONTEXT_INVALID", "教师课程与班级上下文格式不正确。", 400);
  return { offeringId: Number(match[1]), classId: Number(match[2]), context: `teacher:${Number(match[1])}:${Number(match[2])}` };
}

export function authorizeTeacherContext(db, session, context) {
  requireRole(session, "teacher");
  const parsed = parseTeacherContext(context);
  const allowed = db.prepare(`SELECT 1 FROM course_offerings o
    JOIN offering_classes oc ON oc.offering_id=o.id
    WHERE o.id=? AND o.teacher_id=? AND oc.class_id=?`)
    .get(parsed.offeringId, session.actorRefId, parsed.classId);
  if (!allowed) throw new AuthError("AUTH_CONTEXT_FORBIDDEN", "该课程或班级不在当前教师授权范围内。", 403);
  return parsed;
}

export function authorizeTeacherOffering(db, session, offeringId) {
  requireRole(session, "teacher");
  const id = Number(offeringId);
  if (!Number.isInteger(id) || id < 1) throw new AuthError("AUTH_CONTEXT_INVALID", "课程标识不正确。", 400);
  const allowed = db.prepare("SELECT 1 FROM course_offerings WHERE id=? AND teacher_id=?")
    .get(id, session.actorRefId);
  if (!allowed) throw new AuthError("AUTH_OFFERING_FORBIDDEN", "该课程不在当前教师授权范围内。", 403);
  return id;
}

export function authorizeStudentSelf(session, studentContext) {
  requireRole(session, "student");
  const expected = "student:" + session.actorRefCode;
  if (studentContext && studentContext !== expected) {
    throw new AuthError("AUTH_STUDENT_SCOPE_FORBIDDEN", "只能访问当前学生本人的数据。", 403);
  }
  return expected;
}

export function authorizeStudentOffering(db, session, offeringId) {
  requireRole(session, "student");
  const id = Number(offeringId);
  if (!Number.isInteger(id) || id < 1) throw new AuthError("AUTH_CONTEXT_INVALID", "课程标识不正确。", 400);
  const allowed = db.prepare(`SELECT 1 FROM enrollments
    WHERE student_id=? AND offering_id=? AND status<>'退选'`).get(session.actorRefId, id);
  if (!allowed) throw new AuthError("AUTH_OFFERING_FORBIDDEN", "该课程不在当前学生选课范围内。", 403);
  return id;
}

export function scopedCatalog(db, session) {
  if (session.role === "teacher") {
    return db.prepare(`SELECT o.id AS offering_id,c.course_code,c.course_name,
      cl.id AS class_id,cl.class_code,cl.class_name,COUNT(e.id) AS student_count
      FROM course_offerings o JOIN courses c ON c.id=o.course_id
      JOIN offering_classes oc ON oc.offering_id=o.id JOIN classes cl ON cl.id=oc.class_id
      LEFT JOIN students s ON s.class_id=cl.id
      LEFT JOIN enrollments e ON e.offering_id=o.id AND e.student_id=s.id AND e.status<>'退选'
      WHERE o.teacher_id=?
      GROUP BY o.id,c.course_code,c.course_name,cl.id,cl.class_code,cl.class_name
      ORDER BY c.course_name,cl.class_name`).all(session.actorRefId);
  }
  return db.prepare(`SELECT o.id AS offering_id,c.course_code,c.course_name,
    cl.id AS class_id,cl.class_code,cl.class_name,1 AS student_count
    FROM enrollments e JOIN course_offerings o ON o.id=e.offering_id
    JOIN courses c ON c.id=o.course_id JOIN students s ON s.id=e.student_id
    JOIN classes cl ON cl.id=s.class_id
    WHERE e.student_id=? AND e.status<>'退选' ORDER BY c.course_name`).all(session.actorRefId);
}
