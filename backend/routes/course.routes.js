'use strict';

const express = require('express');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const { protect, authorize } = require('./auth.routes');

const router = express.Router();

// GET /api/courses (Admin: list all courses with faculty names and enrolled counts)
router.get('/', protect, authorize('Admin'), async (req, res, next) => {
  try {
    if (req.app.locals.dbMode === 'mongodb') {
      const [courses, faculty, enrollments] = await Promise.all([
        Course.find().sort({ courseId: 1 }).lean(),
        User.find({ role: 'Faculty' }).select('userId name').lean(),
        Enrollment.find().lean(),
      ]);
      const facMap = new Map(faculty.map((f) => [f.userId, f.name]));
      const countMap = new Map();
      enrollments.forEach((e) => countMap.set(e.courseId, (countMap.get(e.courseId) || 0) + 1));
      return res.json(
        courses.map((c) => ({
          courseId: c.courseId,
          courseName: c.courseName,
          facultyId: c.facultyId || '',
          facultyName: facMap.get(c.facultyId) || '',
          enrolledCount: countMap.get(c.courseId) || 0,
        }))
      );
    }

    const { courses, users, enrollments } = req.app.locals.mem;
    const facMap = new Map(users.filter((u) => u.role === 'Faculty').map((f) => [f.userId, f.name]));
    const countMap = new Map();
    enrollments.forEach((e) => countMap.set(e.courseId, (countMap.get(e.courseId) || 0) + 1));
    res.json(
      courses
        .slice()
        .sort((a, b) => a.courseId.localeCompare(b.courseId))
        .map((c) => ({
          courseId: c.courseId,
          courseName: c.courseName,
          facultyId: c.facultyId || '',
          facultyName: facMap.get(c.facultyId) || '',
          enrolledCount: countMap.get(c.courseId) || 0,
        }))
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/courses/enrollments (Admin: list all enrollments with student & course info)
router.get('/enrollments', protect, authorize('Admin'), async (req, res, next) => {
  try {
    if (req.app.locals.dbMode === 'mongodb') {
      const [enrollments, students, courses] = await Promise.all([
        Enrollment.find().sort({ courseId: 1, studentId: 1 }).lean(),
        User.find({ role: 'Student' }).select('userId name email').lean(),
        Course.find().select('courseId courseName').lean(),
      ]);
      const stMap = new Map(students.map((s) => [s.userId, s]));
      const cMap = new Map(courses.map((c) => [c.courseId, c]));
      return res.json(
        enrollments.map((e) => ({
          studentId: e.studentId,
          studentName: stMap.get(e.studentId)?.name || e.studentId,
          studentEmail: stMap.get(e.studentId)?.email || '',
          courseId: e.courseId,
          courseName: cMap.get(e.courseId)?.courseName || e.courseId,
        }))
      );
    }

    const { enrollments, users, courses } = req.app.locals.mem;
    const stMap = new Map(users.filter((u) => u.role === 'Student').map((s) => [s.userId, s]));
    const cMap = new Map(courses.map((c) => [c.courseId, c]));
    res.json(
      enrollments
        .slice()
        .sort((a, b) => a.courseId.localeCompare(b.courseId) || a.studentId.localeCompare(b.studentId))
        .map((e) => ({
          studentId: e.studentId,
          studentName: stMap.get(e.studentId)?.name || e.studentId,
          studentEmail: stMap.get(e.studentId)?.email || '',
          courseId: e.courseId,
          courseName: cMap.get(e.courseId)?.courseName || e.courseId,
        }))
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/courses/add (Admin)
router.post('/add', protect, authorize('Admin'), async (req, res, next) => {
  try {
    const courseId = String(req.body?.courseId || '').trim().toUpperCase();
    const courseName = String(req.body?.courseName || '').trim();
    const facultyId = String(req.body?.facultyId || '').trim().toUpperCase();

    if (!courseId || !courseName) {
      return res.status(400).json({ message: 'Course ID and Course Name are required' });
    }

    if (req.app.locals.dbMode === 'mongodb') {
      if (await Course.exists({ courseId })) {
        return res.status(409).json({ message: `Course ${courseId} already exists` });
      }
      if (facultyId && !(await User.exists({ userId: facultyId, role: 'Faculty' }))) {
        return res.status(400).json({ message: `Faculty ${facultyId} not found` });
      }
      const created = await Course.create({ courseId, courseName, facultyId });
      return res.status(201).json({ message: `Course ${courseId} created`, course: created });
    }

    const { courses, users } = req.app.locals.mem;
    if (courses.some((c) => c.courseId === courseId)) {
      return res.status(409).json({ message: `Course ${courseId} already exists` });
    }
    if (facultyId && !users.some((u) => u.userId === facultyId && u.role === 'Faculty')) {
      return res.status(400).json({ message: `Faculty ${facultyId} not found` });
    }
    const created = { courseId, courseName, facultyId };
    courses.push(created);
    res.status(201).json({ message: `Course ${courseId} created`, course: created });
  } catch (err) {
    next(err);
  }
});

// POST /api/courses/assignFaculty (Admin)
router.post('/assignFaculty', protect, authorize('Admin'), async (req, res, next) => {
  try {
    const courseId = String(req.body?.courseId || '').trim().toUpperCase();
    const facultyId = String(req.body?.facultyId || '').trim().toUpperCase();
    if (!courseId || !facultyId) {
      return res.status(400).json({ message: 'Course ID and Faculty ID are required' });
    }

    if (req.app.locals.dbMode === 'mongodb') {
      const [course, fac] = await Promise.all([
        Course.findOne({ courseId }),
        User.findOne({ userId: facultyId, role: 'Faculty' }).lean(),
      ]);
      if (!course) return res.status(404).json({ message: `Course ${courseId} not found` });
      if (!fac) return res.status(404).json({ message: `Faculty ${facultyId} not found` });
      course.facultyId = facultyId;
      await course.save();
      return res.json({ message: `${fac.name} assigned to ${courseId}`, course });
    }

    const { courses, users } = req.app.locals.mem;
    const course = courses.find((c) => c.courseId === courseId);
    const fac = users.find((u) => u.userId === facultyId && u.role === 'Faculty');
    if (!course) return res.status(404).json({ message: `Course ${courseId} not found` });
    if (!fac) return res.status(404).json({ message: `Faculty ${facultyId} not found` });
    course.facultyId = facultyId;
    res.json({ message: `${fac.name} assigned to ${courseId}`, course });
  } catch (err) {
    next(err);
  }
});

// POST /api/courses/enrollStudent (Admin)
router.post('/enrollStudent', protect, authorize('Admin'), async (req, res, next) => {
  try {
    const studentId = String(req.body?.studentId || '').trim().toUpperCase();
    const courseId = String(req.body?.courseId || '').trim().toUpperCase();
    if (!studentId || !courseId) {
      return res.status(400).json({ message: 'Student ID and Course ID are required' });
    }

    if (req.app.locals.dbMode === 'mongodb') {
      const [st, course] = await Promise.all([
        User.findOne({ userId: studentId, role: 'Student' }).lean(),
        Course.findOne({ courseId }).lean(),
      ]);
      if (!st) return res.status(404).json({ message: `Student ${studentId} not found` });
      if (!course) return res.status(404).json({ message: `Course ${courseId} not found` });
      if (await Enrollment.exists({ studentId, courseId })) {
        return res.status(409).json({ message: `${studentId} is already enrolled in ${courseId}` });
      }
      const created = await Enrollment.create({ studentId, courseId });
      return res.status(201).json({ message: `${st.name} (${studentId}) enrolled in ${courseId}`, enrollment: created });
    }

    const { users, courses, enrollments } = req.app.locals.mem;
    const st = users.find((u) => u.userId === studentId && u.role === 'Student');
    const course = courses.find((c) => c.courseId === courseId);
    if (!st) return res.status(404).json({ message: `Student ${studentId} not found` });
    if (!course) return res.status(404).json({ message: `Course ${courseId} not found` });
    if (enrollments.some((e) => e.studentId === studentId && e.courseId === courseId)) {
      return res.status(409).json({ message: `${studentId} is already enrolled in ${courseId}` });
    }
    const created = { studentId, courseId };
    enrollments.push(created);
    res.status(201).json({ message: `${st.name} (${studentId}) enrolled in ${courseId}`, enrollment: created });
  } catch (err) {
    next(err);
  }
});

// GET /api/courses/faculty/:facultyId (Faculty)
router.get('/faculty/:facultyId', protect, authorize('Faculty', 'Admin'), async (req, res, next) => {
  try {
    const facultyId = String(req.params.facultyId || '').trim().toUpperCase();
    if (req.user.role === 'Faculty' && req.user.userId !== facultyId) {
      return res.status(403).json({ message: 'You can only view courses assigned to you' });
    }

    if (req.app.locals.dbMode === 'mongodb') {
      const courses = await Course.find({ facultyId }).sort({ courseId: 1 }).lean();
      const enrollments = await Enrollment.find({ courseId: { $in: courses.map((c) => c.courseId) } }).lean();
      const countMap = new Map();
      enrollments.forEach((e) => countMap.set(e.courseId, (countMap.get(e.courseId) || 0) + 1));
      return res.json(
        courses.map((c) => ({
          courseId: c.courseId,
          courseName: c.courseName,
          facultyId: c.facultyId,
          enrolledCount: countMap.get(c.courseId) || 0,
        }))
      );
    }

    const { courses, enrollments } = req.app.locals.mem;
    const mine = courses.filter((c) => c.facultyId === facultyId).sort((a, b) => a.courseId.localeCompare(b.courseId));
    res.json(
      mine.map((c) => ({
        courseId: c.courseId,
        courseName: c.courseName,
        facultyId: c.facultyId,
        enrolledCount: enrollments.filter((e) => e.courseId === c.courseId).length,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/courses/student/:studentId (Student)
router.get('/student/:studentId', protect, authorize('Student', 'Admin'), async (req, res, next) => {
  try {
    const studentId = String(req.params.studentId || '').trim().toUpperCase();
    if (req.user.role === 'Student' && req.user.userId !== studentId) {
      return res.status(403).json({ message: 'You can only view your own enrolled courses' });
    }

    if (req.app.locals.dbMode === 'mongodb') {
      const enrollments = await Enrollment.find({ studentId }).lean();
      const courseIds = enrollments.map((e) => e.courseId);
      const [courses, faculty] = await Promise.all([
        Course.find({ courseId: { $in: courseIds } }).sort({ courseId: 1 }).lean(),
        User.find({ role: 'Faculty' }).select('userId name').lean(),
      ]);
      const facMap = new Map(faculty.map((f) => [f.userId, f.name]));
      return res.json(
        courses.map((c) => ({
          courseId: c.courseId,
          courseName: c.courseName,
          facultyId: c.facultyId,
          facultyName: facMap.get(c.facultyId) || 'Unassigned',
        }))
      );
    }

    const { enrollments, courses, users } = req.app.locals.mem;
    const courseIds = new Set(enrollments.filter((e) => e.studentId === studentId).map((e) => e.courseId));
    const facMap = new Map(users.filter((u) => u.role === 'Faculty').map((f) => [f.userId, f.name]));
    res.json(
      courses
        .filter((c) => courseIds.has(c.courseId))
        .sort((a, b) => a.courseId.localeCompare(b.courseId))
        .map((c) => ({
          courseId: c.courseId,
          courseName: c.courseName,
          facultyId: c.facultyId,
          facultyName: facMap.get(c.facultyId) || 'Unassigned',
        }))
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
