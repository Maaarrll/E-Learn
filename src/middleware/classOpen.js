// src/middleware/classOpen.js
//
// Only a teacher can open the class. While it is closed, every student API
// answers 503, so students can't log in or study. Instructor and admin APIs
// are never blocked. The switch is saved in app_settings (survives restarts)
// and cached here so it isn't read from the DB on every request.
const { pool } = require('../db');

let cached = null; // true/false once loaded

async function isClassOpen() {
  if (cached === null) {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'class_open'");
    cached = rows[0] ? rows[0].value === '1' : false; // closed until a teacher opens it
  }
  return cached;
}

async function setClassOpen(open) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('class_open', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [open ? '1' : '0']
  );
  cached = !!open;
}

async function requireClassOpen(req, res, next) {
  try {
    if (await isClassOpen()) return next();
    res.status(503).json({ error: 'The class is closed. Please wait for your teacher to open it.', classClosed: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { isClassOpen, setClassOpen, requireClassOpen };
