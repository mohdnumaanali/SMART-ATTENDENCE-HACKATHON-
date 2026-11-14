'use strict';

const express = require('express');
const crypto = require('crypto');
const Attendance = require('../models/Attendance');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const { protect, authorize } = require('./auth.routes');

const router = express.Router();
const VALID_STATUSES = ['Present', 'Late', 'Absent'];

function classesNeededFor75(attended, total) {
  if (total === 0) return 0;
  if ((attended / total) * 100 >= 75) return 0;
  // (attended + x) / (total + x) >= 0.75  =>  x >= 3 * total - 4 * attended
  return Math.max(0, Math.ceil(3 * total - 4 * attended));
}

function safeMissesAt75(attended, total) {
  if (total === 0) return 0;
  if ((attended / total) * 100 < 75) return 0;
  return Math.max(0, Math.floor((4 * attended) / 3 - total));
}

async function loadCourseContext(req, courseId) {
  if (req.app.locals.dbMode === 'mongodb') {
    const course = await Course.findOne({ courseId }).lean();
    if (!course) return null;
    const enrollments = await Enrollment.find({ courseId }).lean();
    const studentIds = enrollments.map((e) => e.studentId);
    const students = await User.find({ userId: { $in: studentIds }, role: 'Student' })
      .select('userId name email department semester section isActive')
      .sort({ userId: 1 })
      .lean();
    const records = await Attendance.find({ courseId }).lean();
    return { course, students, records };
  }

  const { courses, enrollments, users, attendance } = req.app.locals.mem;
  const course = courses.find((c) => c.courseId === courseId);
  if (!course) return null;
  const studentIdSet = new Set(enrollments.filter((e) => e.courseId === courseId).map((e) => e.studentId));
  const students = users
    .filter((u) => u.role === 'Student' && studentIdSet.has(u.userId))
    .map((u) => ({
      userId: u.userId,
      name: u.name,
      email: u.email,
      department: u.department || '',
      semester: u.semester ?? null,
      section: u.section || '',
      isActive: u.isActive !== false,
    }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
  const records = attendance.filter((r) => r.courseId === courseId);
  return { course, students, records };
}

// POST /api/attendance/mark (Faculty)
router.post('/mark', protect, authorize('Faculty'), async (req, res, next) => {
  try {
    const courseId = String(req.body?.courseId || '').trim().toUpperCase();
    const date = String(req.body?.date || '').trim();
    const period = String(req.body?.period || '').trim();
    const sessionType = String(req.body?.sessionType || 'Lecture').trim();
    const topic = String(req.body?.topic || '').trim().slice(0, 150);
    const records = req.body?.records;

    if (!courseId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: 'Valid courseId and date (YYYY-MM-DD) are required' });
    }
    if (!Array.isArray(records) || !records.length) {
      return res.status(400).json({ message: 'Attendance records array is required' });
    }

    const ctx = await loadCourseContext(req, courseId);
    if (!ctx) return res.status(404).json({ message: `Course ${courseId} not found` });
    if (ctx.course.facultyId !== req.user.userId) {
      return res.status(403).json({ message: 'You can only mark attendance for courses assigned to you' });
    }

    const enrolledIds = new Set(ctx.students.map((s) => s.userId));
    const cleanRecords = [];
    for (const r of records) {
      const studentId = String(r.studentId || '').trim().toUpperCase();
      const status = r.status;
      const lateReason = status === 'Late' ? String(r.lateReason || '').trim() : '';
      const checkInTime = status === 'Absent' ? '' : String(r.checkInTime || '').trim();
      if (!enrolledIds.has(studentId)) {
        return res.status(400).json({ message: `Student ${studentId} is not enrolled in ${courseId}` });
      }
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ message: 'Status must be Present, Late, or Absent' });
      }
      cleanRecords.push({ studentId, status, lateReason, checkInTime });
    }

    if (req.app.locals.dbMode === 'mongodb') {
      const ops = cleanRecords.map((r) => ({
        updateOne: {
          filter: { courseId, studentId: r.studentId, date },
          update: {
            $set: {
              status: r.status,
              lateReason: r.lateReason,
              checkInTime: r.checkInTime,
              period,
              sessionType,
              topic,
            },
            $setOnInsert: {
              attendanceId: `ATT-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
              courseId,
              studentId: r.studentId,
              date,
            },
          },
          upsert: true,
        },
      }));
      await Attendance.bulkWrite(ops);
    } else {
      const { attendance } = req.app.locals.mem;
      for (const r of cleanRecords) {
        const existing = attendance.find(
          (a) => a.courseId === courseId && a.studentId === r.studentId && a.date === date
        );
        if (existing) {
          existing.status = r.status;
          existing.lateReason = r.lateReason;
          existing.checkInTime = r.checkInTime;
          existing.period = period;
          existing.sessionType = sessionType;
          existing.topic = topic;
        } else {
          attendance.push({
            attendanceId: `ATT-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
            courseId,
            studentId: r.studentId,
            date,
            status: r.status,
            lateReason: r.lateReason,
            checkInTime: r.checkInTime,
            period,
            sessionType,
            topic,
          });
        }
      }
    }

    const summary = {
      present: cleanRecords.filter((r) => r.status === 'Present').length,
      late: cleanRecords.filter((r) => r.status === 'Late').length,
      absent: cleanRecords.filter((r) => r.status === 'Absent').length,
      total: cleanRecords.length,
    };

    res.status(201).json({
      message: `Attendance saved for ${courseId} (${date})`,
      courseId,
      date,
      summary,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/attendance/course/:courseId (Faculty)
router.get('/course/:courseId', protect, authorize('Faculty', 'Admin'), async (req, res, next) => {
  try {
    const courseId = String(req.params.courseId || '').trim().toUpperCase();
    const date = req.query.date ? String(req.query.date).trim() : '';

    const ctx = await loadCourseContext(req, courseId);
    if (!ctx) return res.status(404).json({ message: `Course ${courseId} not found` });
    if (req.user.role === 'Faculty' && ctx.course.facultyId !== req.user.userId) {
      return res.status(403).json({ message: 'You can only view attendance for your assigned courses' });
    }

    // Compute real cumulative percentage per student for this course
    const statsByStudent = new Map();
    for (const r of ctx.records) {
      const st = statsByStudent.get(r.studentId) || { attended: 0, total: 0 };
      if (r.status !== 'Absent') st.attended += 1;
      st.total += 1;
      statsByStudent.set(r.studentId, st);
    }

    const dateRecords = date ? ctx.records.filter((r) => r.date === date) : [];
    const byStudent = new Map(dateRecords.map((r) => [r.studentId, r]));
    const firstRec = dateRecords[0] || null;

    res.json({
      course: ctx.course,
      date: date || null,
      alreadyMarked: dateRecords.length > 0,
      sessionMeta: firstRec
        ? {
            period: firstRec.period || '',
            sessionType: firstRec.sessionType || 'Lecture',
            topic: firstRec.topic || '',
          }
        : null,
      students: ctx.students.map((s) => {
        const rec = byStudent.get(s.userId);
        const st = statsByStudent.get(s.userId) || { attended: 0, total: 0 };
        const cumulativePercentage = st.total ? +((st.attended / st.total) * 100).toFixed(1) : 100;
        return {
          studentId: s.userId,
          name: s.name,
          email: s.email,
          department: s.department || '',
          semester: s.semester ?? null,
          section: s.section || '',
          isActive: s.isActive !== false,
          cumulativePercentage,
          status: rec ? rec.status : 'Present',
          lateReason: rec ? rec.lateReason : '',
          checkInTime: rec ? rec.checkInTime || '' : '',
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/attendance/report/:courseId (Faculty)
router.get('/report/:courseId', protect, authorize('Faculty', 'Admin'), async (req, res, next) => {
  try {
    const courseId = String(req.params.courseId || '').trim().toUpperCase();
    const ctx = await loadCourseContext(req, courseId);
    if (!ctx) return res.status(404).json({ message: `Course ${courseId} not found` });
    if (req.user.role === 'Faculty' && ctx.course.facultyId !== req.user.userId) {
      return res.status(403).json({ message: 'You can only view reports for your assigned courses' });
    }

    const sessionDates = new Set(ctx.records.map((r) => r.date));
    const counts = new Map();
    let totalPresent = 0;
    let totalLate = 0;
    let totalAbsent = 0;

    for (const r of ctx.records) {
      let c = counts.get(r.studentId);
      if (!c) {
        c = { present: 0, late: 0, absent: 0, total: 0 };
        counts.set(r.studentId, c);
      }
      if (r.status === 'Present') { c.present += 1; totalPresent += 1; }
      else if (r.status === 'Late') { c.late += 1; totalLate += 1; }
      else { c.absent += 1; totalAbsent += 1; }
      c.total += 1;
    }

    const students = ctx.students.map((s) => {
      const c = counts.get(s.userId) || { present: 0, late: 0, absent: 0, total: 0 };
      const attended = c.present + c.late;
      const percentage = c.total ? +((attended / c.total) * 100).toFixed(1) : 100;
      const eligible = c.total === 0 ? true : percentage >= 75;
      return {
        studentId: s.userId,
        name: s.name,
        email: s.email,
        department: s.department || '',
        semester: s.semester ?? null,
        section: s.section || '',
        isActive: s.isActive !== false,
        present: c.present,
        late: c.late,
        absent: c.absent,
        attended,
        total: c.total,
        percentage,
        eligible,
        classesNeededFor75: classesNeededFor75(attended, c.total),
      };
    });

    const defaulters = students.filter((s) => s.total > 0 && s.percentage < 75);
    const totalEntries = totalPresent + totalLate + totalAbsent;
    const averagePercentage = totalEntries
      ? +(((totalPresent + totalLate) / totalEntries) * 100).toFixed(1)
      : 0;

    res.json({
      course: ctx.course,
      summary: {
        totalStudents: students.length,
        totalSessions: sessionDates.size,
        averagePercentage,
        present: totalPresent,
        late: totalLate,
        absent: totalAbsent,
        defaultersCount: defaulters.length,
      },
      students,
      defaulters,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/attendance/student/:studentId (Student)
router.get('/student/:studentId', protect, authorize('Student', 'Faculty', 'Admin'), async (req, res, next) => {
  try {
    const studentId = String(req.params.studentId || '').trim().toUpperCase();
    if (req.user.role === 'Student' && req.user.userId !== studentId) {
      return res.status(403).json({ message: 'You can only view your own attendance' });
    }

    let enrollments;
    let courses;
    let faculty;
    let records;

    if (req.app.locals.dbMode === 'mongodb') {
      enrollments = await Enrollment.find({ studentId }).lean();
      const courseIds = enrollments.map((e) => e.courseId);
      [courses, faculty, records] = await Promise.all([
        Course.find({ courseId: { $in: courseIds } }).sort({ courseId: 1 }).lean(),
        User.find({ role: 'Faculty' }).select('userId name').lean(),
        Attendance.find({ studentId }).sort({ date: -1 }).lean(),
      ]);
    } else {
      const mem = req.app.locals.mem;
      enrollments = mem.enrollments.filter((e) => e.studentId === studentId);
      const courseIds = new Set(enrollments.map((e) => e.courseId));
      courses = mem.courses
        .filter((c) => courseIds.has(c.courseId))
        .sort((a, b) => a.courseId.localeCompare(b.courseId));
      faculty = mem.users.filter((u) => u.role === 'Faculty');
      records = mem.attendance
        .filter((r) => r.studentId === studentId)
        .slice()
        .sort((a, b) => b.date.localeCompare(a.date));
    }

    const facMap = new Map(faculty.map((f) => [f.userId, f.name]));
    const courseMap = new Map(courses.map((c) => [c.courseId, c]));
    const statsByCourse = new Map();

    for (const r of records) {
      let c = statsByCourse.get(r.courseId);
      if (!c) {
        c = { present: 0, late: 0, absent: 0, total: 0 };
        statsByCourse.set(r.courseId, c);
      }
      if (r.status === 'Present') c.present += 1;
      else if (r.status === 'Late') c.late += 1;
      else c.absent += 1;
      c.total += 1;
    }

    let sumPresent = 0;
    let sumLate = 0;
    let sumAbsent = 0;
    let sumTotal = 0;

    const courseRows = courses.map((c) => {
      const st = statsByCourse.get(c.courseId) || { present: 0, late: 0, absent: 0, total: 0 };
      const attended = st.present + st.late;
      const percentage = st.total ? +((attended / st.total) * 100).toFixed(1) : 100;
      sumPresent += st.present;
      sumLate += st.late;
      sumAbsent += st.absent;
      sumTotal += st.total;
      return {
        courseId: c.courseId,
        courseName: c.courseName,
        courseType: c.courseId.startsWith('MC')
          ? 'Mandatory'
          : /lab/i.test(c.courseName)
            ? 'Practical Lab'
            : 'Theory',
        facultyId: c.facultyId || '',
        facultyName: facMap.get(c.facultyId) || 'Unassigned',
        present: st.present,
        late: st.late,
        absent: st.absent,
        attended,
        total: st.total,
        percentage,
        eligible: st.total === 0 ? true : percentage >= 75,
        classesNeededFor75: classesNeededFor75(attended, st.total),
      };
    });

    const overallAttended = sumPresent + sumLate;
    const overallPercentage = sumTotal ? +((overallAttended / sumTotal) * 100).toFixed(1) : 100;

    records.sort((a, b) => b.date.localeCompare(a.date) || a.courseId.localeCompare(b.courseId));

    res.json({
      studentId,
      overall: {
        present: sumPresent,
        late: sumLate,
        absent: sumAbsent,
        attended: overallAttended,
        total: sumTotal,
        percentage: overallPercentage,
        eligible: sumTotal === 0 ? true : overallPercentage >= 75,
        classesNeededFor75: classesNeededFor75(overallAttended, sumTotal),
        safeMisses: safeMissesAt75(overallAttended, sumTotal),
      },
      courses: courseRows,
      recentHistory: records.map((r) => {
        const attended = r.status === 'Absent' ? 0 : 1;
        const late = r.status === 'Late' ? 1 : 0;
        return {
          date: r.date,
          courseId: r.courseId,
          courseName: courseMap.get(r.courseId)?.courseName || r.courseId,
          held: 1,
          attended,
          late,
          dailyPct: attended ? 100 : 0,
          status: r.status,
          lateReason: r.lateReason || '',
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
