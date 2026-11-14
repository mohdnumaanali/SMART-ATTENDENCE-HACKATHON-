'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('./models/User');
const Course = require('./models/Course');
const Enrollment = require('./models/Enrollment');
const Attendance = require('./models/Attendance');

const STUDENTS_CSV_PATH = path.resolve(
  __dirname,
  '..',
  'public',
  'assets',
  'aistudio',
  'students_100-v3_929aaf02.csv'
);

function loadStudentsFromCsv() {
  const raw = fs.readFileSync(STUDENTS_CSV_PATH, 'utf8').trim();
  const lines = raw.split(/\r?\n/).slice(1);
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const cols = line.split(',');
      return {
        rollNumber: String(cols[2] || '').trim().toUpperCase(),
        name: String(cols[3] || '').trim(),
        department: String(cols[4] || '').trim(),
        semester: Number(cols[5]) || null,
        section: String(cols[6] || '').trim(),
        isActive: String(cols[7] || '').trim().toLowerCase() !== 'false',
      };
    });
}

// Build deterministic sample data: 1 Admin, 2 Faculty, 100 Students from CSV, 7 Courses
function buildSeedData() {
  const passwordHash = bcrypt.hashSync('Password@123', 10);

  const users = [
    {
      userId: 'ADMIN001',
      name: 'Dr. Rajeshwar Rao',
      role: 'Admin',
      email: 'admin@sru.edu.in',
      password: passwordHash,
      department: 'Administration',
      semester: null,
      section: '',
      isActive: true,
    },
    {
      userId: 'FAC001',
      name: 'Dr. Ananya Sharma',
      role: 'Faculty',
      email: 'ananya.sharma@sru.edu.in',
      password: passwordHash,
      department: 'Computer Science',
      semester: null,
      section: '',
      isActive: true,
    },
    {
      userId: 'FAC002',
      name: 'Prof. Vikram Nair',
      role: 'Faculty',
      email: 'vikram.nair@sru.edu.in',
      password: passwordHash,
      department: 'Computer Science',
      semester: null,
      section: '',
      isActive: true,
    },
  ];

  const csvStudents = loadStudentsFromCsv();
  const rateByStudent = new Map();

  csvStudents.forEach((st, idx) => {
    // Varied realistic attendance rates (~58% to ~95%) so both Safe and <75% Defaulter appear
    const baseRates = [0.92, 0.88, 0.84, 0.79, 0.95, 0.64, 0.86, 0.72, 0.90, 0.58];
    const rate = st.isActive ? baseRates[idx % baseRates.length] : 0.52;
    users.push({
      userId: st.rollNumber,
      name: st.name,
      role: 'Student',
      email: `${st.rollNumber.toLowerCase()}@sru.edu.in`,
      password: passwordHash,
      department: st.department,
      semester: st.semester,
      section: st.section,
      isActive: st.isActive,
    });
    rateByStudent.set(st.rollNumber, rate);
  });

  // 10 curriculum subjects split across FAC001 and FAC002
  const courses = [
    { courseId: 'CS2101', courseName: 'AI Assisted Coding & Prompt Engineering', facultyId: 'FAC001' },
    { courseId: 'CS2102', courseName: 'Advanced Data Structures & Algorithms', facultyId: 'FAC001' },
    { courseId: 'CS2103', courseName: 'Database Management Systems', facultyId: 'FAC001' },
    { courseId: 'CS2104', courseName: 'Web Application Development Lab', facultyId: 'FAC001' },
    { courseId: 'CS2105', courseName: 'Discrete Mathematical Structures', facultyId: 'FAC001' },
    { courseId: 'CS2106', courseName: 'Computer Organization & Architecture', facultyId: 'FAC001' },
    { courseId: 'CS2107', courseName: 'Object-Oriented Programming with Java', facultyId: 'FAC001' },
    { courseId: 'CS2108', courseName: 'Design Thinking & Innovation', facultyId: 'FAC002' },
    { courseId: 'HS2101', courseName: 'Professional Communication & Soft Skills', facultyId: 'FAC002' },
    { courseId: 'MC2101', courseName: 'Environmental Science & Sustainability', facultyId: 'FAC002' },
  ];

  // Course-specific enrollments so each course loads only its enrolled students:
  // CS students take all 10 subjects; IT/EC/EE/ME students take their core + institute subjects.
  const deptAllowedByCourse = {
    CS2101: new Set(['Computer Science', 'Information Technology']),
    CS2102: new Set(['Computer Science', 'Information Technology']),
    CS2103: new Set(['Computer Science', 'Information Technology']),
    CS2104: new Set(['Computer Science', 'Electronics and Communication']),
    CS2105: new Set(['Computer Science', 'Electronics and Communication']),
    CS2106: new Set(['Computer Science', 'Electrical Engineering']),
    CS2107: new Set(['Computer Science', 'Electrical Engineering']),
    CS2108: null, // All departments
    HS2101: null, // All departments
    MC2101: null, // All departments
  };

  const enrollments = [];
  for (const st of csvStudents) {
    for (const course of courses) {
      const allowed = deptAllowedByCourse[course.courseId];
      if (!allowed || allowed.has(st.department)) {
        enrollments.push({ studentId: st.rollNumber, courseId: course.courseId });
      }
    }
  }

  // Simple deterministic pseudo-random generator for repeatable sample history
  let seed = 20261114;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const lateReasons = ['Bus/Traffic', 'Medical', 'Prev. Class', 'Other'];
  const attendance = [];
  const today = new Date();
  let seq = 1;

  for (let d = 14; d >= 1; d--) {
    const dt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - d));
    const day = dt.getUTCDay();
    if (day === 0 || day === 6) continue;
    const dateStr = dt.toISOString().slice(0, 10);

    courses.forEach((course, idx) => {
      // Conduct each subject ~3-4 weekdays per week
      if ((day + idx) % 3 === 0) return;
      const enrolled = enrollments.filter((e) => e.courseId === course.courseId);
      for (const enr of enrolled) {
        const target = rateByStudent.get(enr.studentId) || 0.8;
        const r = nextRand();
        let status = 'Absent';
        let lateReason = '';
        if (r < target * 0.88) {
          status = 'Present';
        } else if (r < target) {
          status = 'Late';
          lateReason = lateReasons[Math.floor(nextRand() * lateReasons.length)];
        }
        attendance.push({
          attendanceId: `ATT-${String(seq++).padStart(5, '0')}`,
          courseId: course.courseId,
          studentId: enr.studentId,
          date: dateStr,
          status,
          lateReason,
        });
      }
    });
  }

  return { users, courses, enrollments, attendance };
}

async function seedMongoIfEmpty() {
  const count = await User.countDocuments();
  if (count > 0) return false;
  const data = buildSeedData();
  await User.insertMany(data.users);
  await Course.insertMany(data.courses);
  await Enrollment.insertMany(data.enrollments);
  await Attendance.insertMany(data.attendance);
  return true;
}

async function runCliSeed() {
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/hackathonDB';
  await mongoose.connect(MONGO_URI);
  console.log('Database connected');
  await Promise.all([
    User.deleteMany({}),
    Course.deleteMany({}),
    Enrollment.deleteMany({}),
    Attendance.deleteMany({}),
  ]);
  const data = buildSeedData();
  await User.insertMany(data.users);
  await Course.insertMany(data.courses);
  await Enrollment.insertMany(data.enrollments);
  await Attendance.insertMany(data.attendance);
  console.log(`Seeded ${data.users.length} users, ${data.courses.length} courses, ${data.enrollments.length} enrollments, ${data.attendance.length} attendance records.`);
  await mongoose.disconnect();
}

if (require.main === module) {
  runCliSeed().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}

module.exports = { buildSeedData, seedMongoIfEmpty };
