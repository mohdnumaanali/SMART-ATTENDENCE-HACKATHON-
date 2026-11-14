'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'sru_secret_2026';
const ROLES = ['Admin', 'Faculty', 'Student'];

function sanitizeUser(u) {
  return {
    userId: u.userId,
    name: u.name,
    role: u.role,
    email: u.email,
    department: u.department || '',
    semester: u.semester ?? null,
    section: u.section || '',
    isActive: u.isActive !== false,
  };
}

function signToken(u) {
  return jwt.sign(
    { userId: u.userId, role: u.role, name: u.name, email: u.email },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

async function findUserByIdOrEmail(req, identifier) {
  const clean = String(identifier || '').trim();
  if (!clean) return null;
  if (req.app.locals.dbMode === 'mongodb') {
    if (clean.includes('@')) {
      return User.findOne({ email: clean.toLowerCase() }).lean();
    }
    return User.findOne({ userId: clean.toUpperCase() }).lean();
  }
  const { users } = req.app.locals.mem;
  if (clean.includes('@')) {
    return users.find((u) => u.email.toLowerCase() === clean.toLowerCase()) || null;
  }
  return users.find((u) => u.userId.toUpperCase() === clean.toUpperCase()) || null;
}

async function protect(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Authentication required' });

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ message: 'Session expired or invalid. Please sign in again.' });
    }

    let user;
    if (req.app.locals.dbMode === 'mongodb') {
      user = await User.findOne({ userId: decoded.userId }).lean();
    } else {
      user = req.app.locals.mem.users.find((u) => u.userId === decoded.userId) || null;
    }

    if (!user) return res.status(401).json({ message: 'User account not found' });
    req.user = sanitizeUser(user);
    next();
  } catch (err) {
    next(err);
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied for your role' });
    }
    next();
  };
}

// POST /api/auth/register
router.post('/register', async (req, res, next) => {
  try {
    const { userId, name, role, email, password } = req.body || {};
    const cleanId = String(userId || '').trim().toUpperCase();
    const cleanName = String(name || '').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanRole = ROLES.includes(role) ? role : null;

    if (!cleanId || !cleanName || !cleanRole || !cleanEmail || !password) {
      return res.status(400).json({ message: 'User ID, name, role, email, and password are required' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    const hashedPassword = await bcrypt.hash(String(password), 10);

    if (req.app.locals.dbMode === 'mongodb') {
      const exists = await User.findOne({ $or: [{ userId: cleanId }, { email: cleanEmail }] }).lean();
      if (exists) {
        return res.status(409).json({ message: 'User ID or email is already registered' });
      }
      const created = await User.create({
        userId: cleanId,
        name: cleanName,
        role: cleanRole,
        email: cleanEmail,
        password: hashedPassword,
        department: String(req.body?.department || '').trim(),
        semester: req.body?.semester != null ? Number(req.body.semester) || null : null,
        section: String(req.body?.section || '').trim(),
        isActive: req.body?.isActive !== false,
      });
      const user = sanitizeUser(created);
      return res.status(201).json({ token: signToken(user), user });
    }

    const { users } = req.app.locals.mem;
    if (users.some((u) => u.userId === cleanId || u.email === cleanEmail)) {
      return res.status(409).json({ message: 'User ID or email is already registered' });
    }
    const created = {
      userId: cleanId,
      name: cleanName,
      role: cleanRole,
      email: cleanEmail,
      password: hashedPassword,
      department: String(req.body?.department || '').trim(),
      semester: req.body?.semester != null ? Number(req.body.semester) || null : null,
      section: String(req.body?.section || '').trim(),
      isActive: req.body?.isActive !== false,
    };
    users.push(created);
    const user = sanitizeUser(created);
    res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { identifier, email, userId, password, role } = req.body || {};
    const lookup = identifier || userId || email;
    if (!lookup || !password) {
      return res.status(400).json({ message: 'Enter your User ID / Email and password' });
    }

    const found = await findUserByIdOrEmail(req, lookup);
    if (!found) {
      return res.status(401).json({ message: 'Invalid credentials or role selected' });
    }
    if (role && found.role !== role) {
      return res.status(401).json({ message: `This account is registered as ${found.role}, not ${role}` });
    }
    const valid = await bcrypt.compare(String(password), found.password);
    if (!valid) {
      return res.status(401).json({ message: 'Invalid credentials or role selected' });
    }

    const user = sanitizeUser(found);
    res.json({ token: signToken(user), user });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', protect, (req, res) => {
  res.json({ user: req.user });
});

module.exports = { router, protect, authorize, sanitizeUser };
