const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema(
  {
    attendanceId: { type: String, required: true, unique: true, trim: true },
    courseId: { type: String, required: true, uppercase: true, trim: true },
    studentId: { type: String, required: true, uppercase: true, trim: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: { type: String, enum: ['Present', 'Late', 'Absent'], required: true },
    lateReason: { type: String, default: '', trim: true },
    checkInTime: { type: String, default: '', trim: true },
    period: { type: String, default: '', trim: true },
    sessionType: { type: String, default: 'Lecture', trim: true },
    topic: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

attendanceSchema.index({ courseId: 1, studentId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', attendanceSchema);
