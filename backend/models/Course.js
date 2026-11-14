const mongoose = require('mongoose');

const courseSchema = new mongoose.Schema(
  {
    courseId: { type: String, required: true, unique: true, uppercase: true, trim: true },
    courseName: { type: String, required: true, trim: true },
    facultyId: { type: String, default: '', uppercase: true, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Course', courseSchema);
