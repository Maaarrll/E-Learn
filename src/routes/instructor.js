// src/routes/instructor.js
// Instructor login / logout for the Admin Dashboard (Instructor ID + password).
// Accounts are managed by the main admin (Instructors tab) or with
// "npm run instructor" (scripts/instructor.js).
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { rateLimit } = require('../middleware/rateLimit');
const { isValidPassword, PASSWORD_RULES_MESSAGE } = require('../utils/passwords');
const { isClassOpen, setClassOpen } = require('../middleware/classOpen');
const { photoUpload, uploadPhoto, deletePhoto } = require('../utils/photos');
const {
  requireInstructor,
  issueInstructorSession,
  clearInstructorSession,
} = require('../middleware/instructorGuard');

const router = express.Router();
const MINUTE = 60 * 1000;

// Same reply time whether or not the ID exists
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

const loginLimiter = rateLimit({
  windowMs: 15 * MINUTE,
  max: 8,
  keyFn: (req) => `instructor:${req.ip}:${String((req.body && req.body.instructorId) || '').trim()}`,
  message: 'Too many login attempts. Please wait 15 minutes and try again.',
});

const loginIpLimiter = rateLimit({
  windowMs: 15 * MINUTE,
  max: 30,
  keyFn: (req) => `instructor-ip:${req.ip}`,
  message: 'Too many login attempts. Please wait 15 minutes and try again.',
});

const publicInstructor = (row) => ({ instructorId: row.instructor_id, fullName: row.full_name });

// POST /api/instructor/login  { instructorId, password }
router.post('/login', loginIpLimiter, loginLimiter, async (req, res, next) => {
  try {
    const { instructorId, password } = req.body || {};
    const id = typeof instructorId === 'string' ? instructorId.trim() : '';
    if (!id || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Instructor ID and password are required.' });
    }

    const { rows } = await pool.query('SELECT * FROM instructors WHERE instructor_id = $1', [id]);
    const instructor = rows[0];
    const passwordOk = await bcrypt.compare(password, instructor ? instructor.password_hash : DUMMY_PASSWORD_HASH);
    if (!instructor || !passwordOk) {
      return res.status(401).json({ error: 'Invalid instructor ID or password.' });
    }

    await pool.query('UPDATE instructors SET last_login_at = NOW() WHERE id = $1', [instructor.id]);
    issueInstructorSession(res, instructor.id, instructor.session_version);
    res.json({ instructor: publicInstructor(instructor) });
  } catch (err) {
    next(err);
  }
});

// POST /api/instructor/logout
router.post('/logout', (req, res) => {
  clearInstructorSession(res);
  res.json({ ok: true });
});

// GET /api/instructor/me
router.get('/me', requireInstructor, (req, res) => {
  const { instructorId, fullName, role, isAdmin, sections, profilePhoto } = req.instructor;
  res.json({ instructor: { instructorId, fullName, role, isAdmin, sections, profilePhoto } });
});

const audit = (instructorRowId, action, details = '') => pool.query(
  'INSERT INTO instructor_audit_log (instructor_id, action, details) VALUES ($1, $2, $3)',
  [instructorRowId, action, details]
);

// GET /api/instructor/profile — everything the My profile page shows
router.get('/profile', requireInstructor, async (req, res, next) => {
  try {
    const { rows: [r] } = await pool.query('SELECT created_at, last_login_at FROM instructors WHERE id = $1', [req.instructor.id]);
    const { instructorId, fullName, role, isAdmin, sections, profilePhoto } = req.instructor;
    res.json({ instructorId, fullName, role, isAdmin, sections, profilePhoto, createdAt: r.created_at, lastLoginAt: r.last_login_at });
  } catch (err) {
    next(err);
  }
});

// PUT /api/instructor/profile  { fullName } — change your own name (ID, role and sections stay with the main admin)
router.put('/profile', requireInstructor, async (req, res, next) => {
  try {
    const fullName = typeof (req.body || {}).fullName === 'string' ? req.body.fullName.trim().replace(/\s+/g, ' ') : '';
    if (!fullName || fullName.length > 120) return res.status(400).json({ error: 'Give your name (up to 120 characters).' });
    if (fullName !== req.instructor.fullName) {
      await pool.query('UPDATE instructors SET full_name = $1 WHERE id = $2', [fullName, req.instructor.id]);
      await audit(req.instructor.id, 'update_profile', `"${req.instructor.fullName}" to "${fullName}"`);
    }
    res.json({ fullName });
  } catch (err) {
    next(err);
  }
});

// Every upload uses Cloudinary quota
const photoLimiter = rateLimit({
  windowMs: 60 * MINUTE,
  max: 10,
  keyFn: (req) => `instructor-photo:${req.instructor.id}`,
  message: 'Too many photo uploads. Please try again in an hour.',
});

// POST /api/instructor/photo  (multipart "photo") -> { profilePhoto }
router.post('/photo', requireInstructor, photoLimiter, photoUpload, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const url = await uploadPhoto(req.file.buffer, 'hcilearn/instructor_photos', `instructor${req.instructor.id}`);
    await pool.query('UPDATE instructors SET profile_photo = $1 WHERE id = $2', [url, req.instructor.id]);
    res.json({ profilePhoto: url });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/instructor/photo — back to initials
router.delete('/photo', requireInstructor, async (req, res, next) => {
  try {
    await pool.query('UPDATE instructors SET profile_photo = NULL WHERE id = $1', [req.instructor.id]);
    deletePhoto('hcilearn/instructor_photos', `instructor${req.instructor.id}`);
    res.json({ profilePhoto: null });
  } catch (err) {
    next(err);
  }
});

// GET /api/instructor/class  -> { open }
router.get('/class', requireInstructor, async (req, res, next) => {
  try {
    res.json({ open: await isClassOpen() });
  } catch (err) {
    next(err);
  }
});

// PUT /api/instructor/class  { open }  Only teachers can open or close the class.
router.put('/class', requireInstructor, async (req, res, next) => {
  try {
    const open = (req.body || {}).open === true;
    await setClassOpen(open);
    await pool.query(
      'INSERT INTO instructor_audit_log (instructor_id, action, details) VALUES ($1, $2, $3)',
      [req.instructor.id, open ? 'open_class' : 'close_class', '']
    ).catch(err => console.error('Audit log failed:', err.message));
    res.json({ open });
  } catch (err) {
    next(err);
  }
});

const passwordLimiter = rateLimit({
  windowMs: 15 * MINUTE,
  max: 10,
  keyFn: (req) => `instructor-pw:${req.ip}`,
  message: 'Too many attempts. Please wait 15 minutes and try again.',
});

// POST /api/instructor/password  { currentPassword, newPassword }
// Logs out other devices; this one gets a fresh session.
router.post('/password', requireInstructor, passwordLimiter, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const { rows } = await pool.query('SELECT password_hash, session_version FROM instructors WHERE id = $1', [req.instructor.id]);
    if (typeof currentPassword !== 'string' || !(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
      return res.status(400).json({ error: 'Your current password is not correct.' });
    }
    if (!isValidPassword(newPassword)) return res.status(400).json({ error: PASSWORD_RULES_MESSAGE });
    if (newPassword === currentPassword) return res.status(400).json({ error: 'Choose a password different from the current one.' });

    const { rows: updated } = await pool.query(
      'UPDATE instructors SET password_hash = $1, session_version = session_version + 1 WHERE id = $2 RETURNING session_version',
      [await bcrypt.hash(newPassword, 12), req.instructor.id]
    );
    issueInstructorSession(res, req.instructor.id, updated[0].session_version);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
