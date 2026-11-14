'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const User = require('./models/User');
const { buildSeedData, seedMongoIfEmpty } = require('./seed');
const { router: authRoutes, protect, authorize, sanitizeUser } = require('./routes/auth.routes');
const courseRoutes = require('./routes/course.routes');
const attendanceRoutes = require('./routes/attendance.routes');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/hackathonDB';

app.use(cors());
app.use(express.json({ limit: '1mb' }));

let isDbConnected = false;

// Initialize memory store as fallback when MongoDB is unavailable
app.locals.isDbConnected = false;
app.locals.dbMode = 'memory';
app.locals.mem = buildSeedData();

let dbReadyPromise = null;
function initDb() {
  if (dbReadyPromise) return dbReadyPromise;
  mongoose.set('strictQuery', true);
  dbReadyPromise = mongoose
    .connect(MONGO_URI, { serverSelectionTimeoutMS: 2000 })
    .then(async () => {
      isDbConnected = true;
      app.locals.isDbConnected = true;
      app.locals.dbMode = 'mongodb';
      await seedMongoIfEmpty();
      console.log('Database connected');
      return 'mongodb';
    })
    .catch((err) => {
      isDbConnected = false;
      app.locals.isDbConnected = false;
      app.locals.dbMode = 'memory';
      console.error('MongoDB connection error:', err.message || err);
      return 'memory';
    });
  return dbReadyPromise;
}

// Ensure DB connection attempt completes before handling any /api request
app.use('/api', async (req, res, next) => {
  await initDb();
  next();
});

// GET /api/health
app.get('/api/health', (req, res) => {
  const mode = isDbConnected ? 'mongodb' : 'memory';
  res.json({
    status: 'ok',
    isDbConnected,
    dbMode: mode,
    dbLabel: isDbConnected ? 'MongoDB Live' : 'Demo Mode',
  });
});

// GET /api/users (Admin)
app.get('/api/users', protect, authorize('Admin'), async (req, res, next) => {
  try {
    const role = req.query.role ? String(req.query.role).trim() : '';
    if (req.app.locals.dbMode === 'mongodb') {
      const filter = role ? { role } : {};
      const list = await User.find(filter).sort({ role: 1, userId: 1 }).lean();
      return res.json(list.map(sanitizeUser));
    }
    const { users } = req.app.locals.mem;
    const filtered = role ? users.filter((u) => u.role === role) : users;
    res.json(
      filtered
        .slice()
        .sort((a, b) => a.role.localeCompare(b.role) || a.userId.localeCompare(b.userId))
        .map(sanitizeUser)
    );
  } catch (err) {
    next(err);
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/attendance', attendanceRoutes);

app.use('/api', (req, res) => {
  res.status(404).json({ message: `Route not found: ${req.originalUrl}` });
});

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ message: err.message || 'Server error' });
});

if (require.main === module) {
  initDb().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server started on port ${PORT}`);
    });
  });
}

module.exports = app;
module.exports.initDb = initDb;
