// src/routes/admin.js
// Admin dashboard (read-only): student progress, class insights, CSV export
// and the audit log. Every route needs an instructor login
// (see middleware/instructorGuard.js and routes/instructor.js).
const express = require('express');
const { pool } = require('../db');
const { requireInstructor, requireAdminRole } = require('../middleware/instructorGuard');
const { getContent } = require('../contentStore');
const { todayLocal, addDays, toYmd, computeStreaks } = require('../utils/dates');
const { getBadges } = require('./gamify');
const { decryptEmail } = require('../utils/emailSecurity');
const { sendInactiveReminder } = require('../utils/mailer');
const { adminName } = require('../utils/names');
const { markUpdated } = require('../updates');
const { deletePhoto } = require('../utils/photos');
const { YEAR_SECTION_REGEX } = require('../utils/students');

const router = express.Router();
router.use(requireInstructor);

const INACTIVE_AFTER_DAYS = 7;

async function audit(instructorRowId, action, targetUserId = null, details = '') {
  await pool.query(
    'INSERT INTO instructor_audit_log (instructor_id, action, target_user_id, details) VALUES ($1, $2, $3, $4)',
    [instructorRowId, action, targetUserId, details]
  );
}

// Timestamp -> YYYY-MM-DD in Philippine time
function tsToYmd(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(ts));
}

// Can this instructor see this student? Admins see everyone; other
// instructors only the sections assigned to them (program + year/section).
function canSee(instructor, student) {
  if (instructor.isAdmin) return true;
  return instructor.sections.some(sec =>
    sec.program === (student.program || '') && sec.yearSection === (student.year_section || ''));
}

// Every student this instructor can see, with progress numbers
async function loadStudents(instructor) {
  const content = await getContent();
  const { caseStudies, decks: deckTotal, videos: videoTotal } = content.totals;
  const totalActivities = caseStudies + deckTotal + videoTotal;
  const videoIds = [...content.videoTitles.keys()];
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, u.first_name, u.last_name, u.username, u.program, u.year_section, u.student_id, u.profile_photo,
            u.created_at, u.disabled_at, u.email_enc IS NOT NULL AS can_email, u.reminded_at,
            cs.solved_ids, sc.completed_ids
     FROM users u
     LEFT JOIN case_study_progress cs ON cs.user_id = u.id
     LEFT JOIN study_card_progress sc ON sc.user_id = u.id
     ORDER BY u.full_name`
  );
  const students = rows.filter(r => canSee(instructor, r));
  const ids = students.map(s => s.id);
  if (!ids.length) return [];

  const perUser = async (sql, params = []) => {
    const { rows: r } = await pool.query(sql, [ids, ...params]);
    return new Map(r.map(x => [x.user_id, x]));
  };

  const videos = await perUser(
    `SELECT user_id, COUNT(DISTINCT video_id)::int AS n FROM video_progress
     WHERE user_id = ANY($1::int[]) AND video_id = ANY($2) GROUP BY user_id`, [videoIds]);
  // Only badges that still exist (the daily-goal ones were removed)
  const badges = await perUser(
    'SELECT user_id, COUNT(*)::int AS n FROM user_badges WHERE user_id = ANY($1::int[]) AND badge_id = ANY($2) GROUP BY user_id',
    [getBadges(content.totals).map(b => b.id)]);
  const answers = await perUser(
    `SELECT user_id, COALESCE(SUM(answers), 0)::int AS answers, COALESCE(SUM(correct), 0)::int AS correct
     FROM daily_activity WHERE user_id = ANY($1::int[]) GROUP BY user_id`);
  const lastLog = await perUser(
    'SELECT user_id, MAX(created_at) AS last FROM activity_log WHERE user_id = ANY($1::int[]) GROUP BY user_id');

  const today = todayLocal();
  const { rows: dayRows } = await pool.query(
    `SELECT user_id, day FROM daily_activity
     WHERE user_id = ANY($1::int[]) AND day >= $2 AND (answers > 0 OR videos > 0 OR topics_read > 0)`,
    [ids, addDays(today, -400)]
  );
  const daysByUser = new Map();
  for (const r of dayRows) {
    if (!daysByUser.has(r.user_id)) daysByUser.set(r.user_id, []);
    daysByUser.get(r.user_id).push(toYmd(r.day));
  }

  return students.map(s => {
    // Only published items count
    const solved = s.solved_ids ? JSON.parse(s.solved_ids).filter(id => content.caseByKey.has(Number(id))).length : 0;
    const decks = s.completed_ids ? JSON.parse(s.completed_ids).filter(id => content.deckByKey.has(Number(id))).length : 0;
    const watched = videos.get(s.id) ? videos.get(s.id).n : 0;
    const days = (daysByUser.get(s.id) || []).sort().reverse();
    const streak = computeStreaks(days, today);

    // Last active = latest study day or logged activity
    const candidates = [days[0]];
    if (lastLog.get(s.id) && lastLog.get(s.id).last) candidates.push(tsToYmd(lastLog.get(s.id).last));
    const lastActive = candidates.filter(Boolean).sort().pop() || null;

    const a = answers.get(s.id);
    return {
      id: s.id,
      fullName: adminName(s),
      username: s.username || '',
      program: s.program || '',
      yearSection: s.year_section || '',
      studentId: s.student_id || '',
      profilePhoto: s.profile_photo || null,
      joinedAt: s.created_at,
      caseSolved: solved,
      decksMastered: decks,
      videosWatched: watched,
      overallPercent: totalActivities ? Math.round(((solved + decks + watched) / totalActivities) * 100) : 0,
      answers: a ? a.answers : 0,
      correct: a ? a.correct : 0,
      currentStreak: streak.current,
      longestStreak: streak.longest,
      badges: badges.get(s.id) ? badges.get(s.id).n : 0,
      lastActive,
      // Never active: counted from the day they joined, so a new student isn't "inactive 7+ days"
      inactive: (lastActive || tsToYmd(s.created_at)) < addDays(today, -INACTIVE_AFTER_DAYS),
      deactivated: !!s.disabled_at,
      canEmail: s.can_email,
      remindedAt: s.reminded_at,
    };
  });
}

// ---------- Routes ----------

// GET /api/admin/students — every student with progress numbers
router.get('/students', async (req, res, next) => {
  try {
    res.json({
      today: todayLocal(),
      inactiveAfterDays: INACTIVE_AFTER_DAYS,
      totals: { ...(await getContent()).totals, badges: getBadges((await getContent()).totals).length },
      students: await loadStudents(req.instructor),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/online — ids of students seen in the last 3 minutes (pages ping once a minute)
router.get('/online', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, program, year_section FROM users
       WHERE last_seen_at > NOW() - INTERVAL '3 minutes' AND disabled_at IS NULL`
    );
    res.json({ ids: rows.filter(r => canSee(req.instructor, r)).map(r => r.id) });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/insights — most-missed questions and least-watched videos
router.get('/insights', async (req, res, next) => {
  try {
    const students = await loadStudents(req.instructor);
    const ids = students.map(s => s.id);

    const content = await getContent();
    // Only questions still published, so deleted ones don't push real ones out of the top 10
    const live = (m) => m.source === 'case_study' ? content.caseByKey.has(Number(m.item_key)) : content.cardKeys.has(m.item_key);
    const { rows: allMissed } = await pool.query(
      `SELECT source, item_key, COUNT(*)::int AS students, SUM(wrong_count)::int AS wrong
       FROM mistakes WHERE user_id = ANY($1::int[])
       GROUP BY source, item_key
       ORDER BY students DESC, wrong DESC`,
      [ids]
    );
    const missed = allMissed.filter(live).slice(0, 10);

    const { rows: watchRows } = await pool.query(
      `SELECT video_id, COUNT(DISTINCT user_id)::int AS n FROM video_progress
       WHERE user_id = ANY($1::int[]) GROUP BY video_id`,
      [ids]
    );
    const watchCount = new Map(watchRows.map(r => [r.video_id, r.n]));
    const videos = [...content.videoTitles.entries()]
      .map(([id, title]) => ({ id, title, watchedBy: watchCount.get(id) || 0 }))
      .sort((a, b) => a.watchedBy - b.watchedBy);

    res.json({
      studentCount: ids.length,
      mostMissed: missed.map(m => ({ source: m.source, itemKey: m.item_key, students: m.students, wrong: m.wrong })),
      leastWatched: videos.slice(0, 6),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/students/:id — one student's details
router.get('/students/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid student.' });

    const student = (await loadStudents(req.instructor)).find(s => s.id === id);
    if (!student) return res.status(404).json({ error: 'Student not found.' });

    const content = await getContent();
    const cs = (await pool.query('SELECT unlocked_level, solved_ids FROM case_study_progress WHERE user_id = $1', [id])).rows[0];
    const sc = (await pool.query('SELECT unlocked_lesson, completed_ids FROM study_card_progress WHERE user_id = $1', [id])).rows[0];
    const { rows: watched } = await pool.query(
      'SELECT video_id, watched_at FROM video_progress WHERE user_id = $1 AND video_id = ANY($2) ORDER BY watched_at DESC',
      [id, [...content.videoTitles.keys()]]
    );
    const { rows: mistakes } = await pool.query(
      'SELECT source, item_key, wrong_count, last_wrong_at FROM mistakes WHERE user_id = $1 ORDER BY wrong_count DESC, last_wrong_at DESC',
      [id]
    );
    const { rows: earned } = await pool.query('SELECT badge_id, earned_at FROM user_badges WHERE user_id = $1', [id]);
    const { rows: activity } = await pool.query(
      'SELECT type, description, created_at FROM activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [id]
    );
    const { rows: quizzes } = await pool.query(
      `SELECT q.title, a.score, jsonb_array_length(q.questions) AS total, a.finished_at
       FROM quiz_attempts a JOIN quizzes q ON q.id = a.quiz_id
       WHERE a.user_id = $1 AND a.finished_at IS NOT NULL
       ORDER BY a.finished_at DESC`,
      [id]
    );
    const { rows: topicTime } = await pool.query('SELECT topic_key, seconds FROM topic_time WHERE user_id = $1', [id]);
    const { rows: topicReads } = await pool.query('SELECT topic_key FROM topic_reads WHERE user_id = $1', [id]);
    const secondsOn = new Map(topicTime.map(r => [r.topic_key, r.seconds]));
    const readSet = new Set(topicReads.map(r => r.topic_key));
    const today = todayLocal();
    const { rows: dayRows } = await pool.query(
      'SELECT day, answers, correct, videos, topics_read FROM daily_activity WHERE user_id = $1 AND day >= $2',
      [id, addDays(today, -13)]
    );
    const byDay = new Map(dayRows.map(r => [toYmd(r.day), r]));
    const last14 = [];
    for (let i = 13; i >= 0; i--) {
      const day = addDays(today, -i);
      const r = byDay.get(day);
      last14.push({ day, answers: r ? r.answers : 0, correct: r ? r.correct : 0, videos: r ? r.videos : 0, topicsRead: r ? r.topics_read : 0 });
    }

    const earnedAt = new Map(earned.map(b => [b.badge_id, b.earned_at]));
    await audit(req.instructor.id, 'view_student', id);

    res.json({
      student,
      caseStudies: {
        solvedIds: (cs ? JSON.parse(cs.solved_ids) : []).map(Number).filter(k => content.caseByKey.has(k)),
        total: content.totals.caseStudies,
      },
      studyCards: {
        completedIds: (sc ? JSON.parse(sc.completed_ids) : []).map(Number).filter(k => content.deckByKey.has(k)),
        decks: content.decks.map(d => ({ key: Number(d.key), number: d.number, title: d.title })),
      },
      videos: watched.map(v => ({ id: v.video_id, title: content.videoTitles.get(v.video_id), watchedAt: v.watched_at })),
      mistakes: mistakes.map(m => ({ source: m.source, itemKey: m.item_key, wrongCount: m.wrong_count, lastWrongAt: m.last_wrong_at })),
      badges: getBadges(content.totals).map(b => ({ id: b.id, name: b.name, icon: b.icon, color: b.color, earnedAt: earnedAt.get(b.id) || null })),
      recentActivity: activity,
      quizzes: quizzes.map(q => ({ title: q.title, score: q.score, total: q.total, finishedAt: q.finished_at })),
      // Lesson order; the teacher can spot topics that were read suspiciously fast
      reading: content.topics.map(t => ({ title: t.title, number: t.number, seconds: secondsOn.get(t.key) || 0, read: readSet.has(t.key) })),
      last14,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/export.csv — progress of every student, for grading/reports
router.get('/export.csv', async (req, res, next) => {
  try {
    const students = await loadStudents(req.instructor);
    const { totals } = await getContent();
    // Same overall as the student panel: points earned / points possible over finished quizzes
    const { rows: quizRows } = await pool.query(
      `SELECT a.user_id, SUM(a.score)::int AS got, SUM(jsonb_array_length(q.questions))::int AS max
       FROM quiz_attempts a JOIN quizzes q ON q.id = a.quiz_id
       WHERE a.user_id = ANY($1::int[]) AND a.finished_at IS NOT NULL GROUP BY a.user_id`,
      [students.map(s => s.id)]
    );
    const quizBy = new Map(quizRows.map(r => [r.user_id, r]));
    // Cells starting with = + - @ could run as formulas in Excel
    const cell = (value) => {
      let text = value === null || value === undefined ? '' : String(value);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const header = ['Name', 'Student ID', 'Program', 'Year & Section', 'Overall %',
      `Case studies solved (of ${totals.caseStudies})`, `Decks mastered (of ${totals.decks})`,
      `Videos watched (of ${totals.videos})`, 'Questions answered', 'Correct answers',
      'Current streak (days)', 'Longest streak (days)', `Badges (of ${getBadges(totals).length})`, 'Quiz points earned', 'Quiz points possible', 'Quiz score %', 'Last active', 'Joined'];
    const lines = [header.map(cell).join(',')];
    for (const s of students) {
      const qz = quizBy.get(s.id);
      lines.push([
        s.fullName, s.studentId, s.program, s.yearSection, s.overallPercent,
        s.caseSolved, s.decksMastered, s.videosWatched, s.answers, s.correct,
        s.currentStreak, s.longestStreak, s.badges,
        qz ? qz.got : '', qz ? qz.max : '', qz && qz.max ? Math.round((qz.got / qz.max) * 100) : '', s.lastActive || 'Never', tsToYmd(s.joinedAt),
      ].map(cell).join(','));
    }

    await audit(req.instructor.id, 'export_csv', null, `${students.length} students`);

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="hcilearn-progress-${todayLocal()}.csv"`);
    // BOM so Excel opens accented names correctly
    res.send('﻿' + lines.join('\r\n') + '\r\n');
  } catch (err) {
    next(err);
  }
});

// ---------- Student management ----------
// Each action is confirmed in the page and recorded in the audit log.
async function studentFor(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return null;
  const { rows } = await pool.query('SELECT id, full_name, first_name, last_name, program, year_section, disabled_at FROM users WHERE id = $1', [id]);
  return rows[0] && canSee(req.instructor, rows[0]) ? rows[0] : null;
}

const studentAction = (action, run) => async (req, res, next) => {
  try {
    const student = await studentFor(req);
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    await run(student);
    await audit(req.instructor.id, action, student.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

// Log the student out on every device
router.post('/students/:id/signout', studentAction('signout_student', (s) =>
  pool.query('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [s.id])));

// Block / unblock logging in (deactivating also logs them out)
router.post('/students/:id/deactivate', studentAction('deactivate_student', (s) =>
  pool.query('UPDATE users SET disabled_at = NOW(), session_version = session_version + 1 WHERE id = $1', [s.id])));
router.post('/students/:id/reactivate', studentAction('reactivate_student', (s) =>
  pool.query('UPDATE users SET disabled_at = NULL WHERE id = $1', [s.id])));

// Remove the account for good (progress, saved items, everything). Same as a
// student deleting their own account. The name is kept in the audit log.
router.post('/students/:id/remove', async (req, res, next) => {
  try {
    const student = await studentFor(req);
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    await audit(req.instructor.id, 'remove_student', null, adminName(student));
    await pool.query('DELETE FROM users WHERE id = $1', [student.id]);
    deletePhoto('hcilearn/profile_photos', `user${student.id}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Email an inactive student a nudge to come back. Once a day at most, so a
// student can't be spammed by repeated clicks.
const REMIND_COOLDOWN_HOURS = 24;
router.post('/students/:id/remind', async (req, res, next) => {
  try {
    const student = await studentFor(req);
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    if (student.disabled_at) return res.status(400).json({ error: 'This account is deactivated.' });
    const { rows: [u] } = await pool.query(
      `SELECT first_name, email_enc, reminded_at > NOW() - make_interval(hours => $2) AS recent
       FROM users WHERE id = $1`, [student.id, REMIND_COOLDOWN_HOURS]);
    if (!u.email_enc) return res.status(409).json({ error: 'No email on file for this student (accounts made with an LRN have none).' });
    if (u.recent) return res.status(429).json({ error: 'A reminder was already sent in the last 24 hours.' });

    const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const sent = await sendInactiveReminder(decryptEmail(u.email_enc), u.first_name, `${base}/login.html`);
    if (!sent) return res.status(502).json({ error: 'The email could not be sent. Check the email settings.' });

    await pool.query('UPDATE users SET reminded_at = NOW() WHERE id = $1', [student.id]);
    await audit(req.instructor.id, 'remind_student', student.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/students/:id/section  { yearSection } — students can't change their own.
// A regular instructor can only move a student between their own sections.
router.post('/students/:id/section', async (req, res, next) => {
  try {
    const student = await studentFor(req);
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    const yearSection = typeof (req.body || {}).yearSection === 'string' ? req.body.yearSection.trim() : '';
    if (!YEAR_SECTION_REGEX.test(yearSection)) return res.status(400).json({ error: 'Pick a section from the list.' });
    if (!canSee(req.instructor, { program: student.program, year_section: yearSection })) {
      return res.status(403).json({ error: 'You can only move students into your own sections.' });
    }
    if (yearSection !== student.year_section) {
      await pool.query('UPDATE users SET year_section = $1 WHERE id = $2', [yearSection, student.id]);
      await audit(req.instructor.id, 'change_section', student.id, `"${student.year_section || 'No section'}" to "${yearSection}"`);
    }
    res.json({ yearSection });
  } catch (err) {
    next(err);
  }
});

// Start over: clears learning progress (keeps the account, profile and saved items)
const PROGRESS_TABLES = ['case_study_progress', 'study_card_progress', 'lesson_progress', 'topic_reads', 'topic_time', 'daily_correct', 'video_progress',
  'video_positions', 'mistakes', 'daily_activity', 'user_badges', 'activity_log'];
router.post('/students/:id/reset', studentAction('reset_progress', async (s) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of PROGRESS_TABLES) {
      await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [s.id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));


// ---------- Allowed LRNs (who may sign up) ----------
// GET /api/admin/lrns — the list, with the account using each LRN (if any)
router.get('/lrns', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.lrn, a.added_at, u.full_name, u.first_name, u.last_name, u.program, u.year_section
       FROM allowed_lrns a LEFT JOIN users u ON u.student_id = a.lrn
       ORDER BY a.added_at DESC, a.lrn`
    );
    // Names only for students this instructor can see (main admin: everyone)
    const usedBy = (r) => !r.full_name ? null : canSee(req.instructor, r) ? adminName(r) : 'a student in another section';
    res.json({ lrns: rows.map(r => ({ lrn: r.lrn, addedAt: r.added_at, usedBy: usedBy(r) })) });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/lrns  { text } — pasted LRNs, any separator (one per line from a spreadsheet)
router.post('/lrns', async (req, res, next) => {
  try {
    const text = typeof (req.body && req.body.text) === 'string' ? req.body.text : '';
    const parts = text.split(/[\s,;]+/).filter(Boolean);
    const bad = parts.filter(p => !/^\d{12}$/.test(p));
    if (!parts.length) return res.status(400).json({ error: 'Paste at least one LRN.' });
    if (bad.length) return res.status(400).json({ error: `Each LRN must be exactly 12 digits. Check: ${bad.slice(0, 5).join(', ')}` });
    const { rowCount } = await pool.query(
      'INSERT INTO allowed_lrns (lrn) SELECT DISTINCT UNNEST($1::text[]) ON CONFLICT (lrn) DO NOTHING',
      [parts]
    );
    if (rowCount) await audit(req.instructor.id, 'add_lrns', null, String(rowCount));
    res.json({ added: rowCount, skipped: new Set(parts).size - rowCount });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/lrns/:lrn — stops new signups with it (an existing account keeps working)
router.delete('/lrns/:lrn', async (req, res, next) => {
  try {
    const { rows: [owner] } = await pool.query('SELECT program, year_section FROM users WHERE student_id = $1', [req.params.lrn]);
    if (owner && !canSee(req.instructor, owner)) {
      return res.status(403).json({ error: 'A student in another section signed up with this LRN. Ask the main admin.' });
    }
    const { rowCount } = await pool.query('DELETE FROM allowed_lrns WHERE lrn = $1', [req.params.lrn]);
    if (rowCount) await audit(req.instructor.id, 'remove_lrn', null, req.params.lrn);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});


// ---------- Announcements ----------
// The admin sees all announcements; other instructors only their own.
// GET /api/admin/announcements
router.get('/announcements', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.instructor_id, a.title, a.body, a.ends_on, a.created_at, a.target_sections, i.full_name AS instructor_name
       FROM announcements a LEFT JOIN instructors i ON i.id = a.instructor_id
       ORDER BY a.created_at DESC, a.id DESC`
    );
    res.json({
      today: todayLocal(),
      canPostToEveryone: req.instructor.isAdmin,
      sections: req.instructor.sections,
      announcements: rows
        .filter(r => req.instructor.isAdmin || r.instructor_id === req.instructor.id)
        .map(r => ({
          id: r.id, title: r.title, body: r.body, endsOn: r.ends_on ? toYmd(r.ends_on) : null,
          createdAt: r.created_at, by: r.instructor_name || '(removed instructor)',
          audience: r.target_sections || null,
        })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/announcements  { title, body, endsOn?, sections? }
// sections = [{ program, yearSection }]; null/empty = everyone (admin only).
// Other instructors can only post to their own sections.
router.post('/announcements', async (req, res, next) => {
  try {
    const { title, body, endsOn } = req.body || {};
    const t = typeof title === 'string' ? title.trim() : '';
    const b = typeof body === 'string' ? body.trim() : '';
    if (!t || t.length > 120) return res.status(400).json({ error: 'Give a title (up to 120 characters).' });
    if (b.length > 1000) return res.status(400).json({ error: 'The message can be up to 1000 characters.' });
    let ends = null;
    if (endsOn) {
      if (typeof endsOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(endsOn) || Number.isNaN(Date.parse(endsOn))) {
        return res.status(400).json({ error: 'Pick a valid end date.' });
      }
      if (endsOn < todayLocal()) return res.status(400).json({ error: 'The end date is already in the past.' });
      ends = endsOn;
    }

    const mine = req.instructor.sections;
    const wanted = Array.isArray(req.body.sections) ? req.body.sections : [];
    let audience = wanted
      .filter(x => x && typeof x.program === 'string' && typeof x.yearSection === 'string')
      .map(x => ({ program: x.program, yearSection: x.yearSection }));
    if (!req.instructor.isAdmin) {
      if (!mine.length) return res.status(400).json({ error: 'You have no sections yet. Ask the main admin to assign them.' });
      if (!audience.length) audience = mine; // default: all of my sections
      const ok = audience.every(a => mine.some(m => m.program === a.program && m.yearSection === a.yearSection));
      if (!ok) return res.status(403).json({ error: 'You can only post to your own sections.' });
    }

    const { rows } = await pool.query(
      'INSERT INTO announcements (instructor_id, title, body, ends_on, target_sections) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id',
      [req.instructor.id, t, b, ends, audience.length ? JSON.stringify(audience) : null]
    );
    await audit(req.instructor.id, 'post_announcement', null, t);
    markUpdated();
    res.json({ id: rows[0].id });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/announcements/:id
router.delete('/announcements/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid announcement.' });
    const owner = req.instructor.isAdmin ? '' : ' AND instructor_id = $2';
    const params = req.instructor.isAdmin ? [id] : [id, req.instructor.id];
    const { rows } = await pool.query(`DELETE FROM announcements WHERE id = $1${owner} RETURNING title`, params);
    if (rows[0]) { await audit(req.instructor.id, 'delete_announcement', null, rows[0].title); markUpdated(); }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});


// GET /api/admin/audit — latest admin actions
router.get('/audit', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.action, l.details, l.created_at,
              i.full_name AS instructor_name, i.instructor_id AS instructor_code,
              t.full_name, t.first_name, t.last_name
       FROM instructor_audit_log l
       LEFT JOIN instructors i ON i.id = l.instructor_id
       LEFT JOIN users t ON t.id = l.target_user_id
       WHERE $1::boolean OR l.instructor_id = $2
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT 200`,
      [req.instructor.isAdmin, req.instructor.id]
    );
    res.json({
      entries: rows.map(r => ({
        id: r.id, action: r.action, details: r.details, createdAt: r.created_at,
        adminName: r.instructor_name ? `${r.instructor_name} (ID ${r.instructor_code})` : '(removed instructor)',
        targetName: r.full_name ? adminName(r) : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/audit — clear the whole log (main admin only); the
// clear itself is recorded so a wiped log never looks untouched
router.delete('/audit', requireAdminRole, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM instructor_audit_log');
    await audit(req.instructor.id, 'clear_audit');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/audit/:id — remove an entry (main admin only, so the
// log stays trustworthy; regular instructors can't erase what they did)
router.delete('/audit/:id', requireAdminRole, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid entry.' });
    await pool.query('DELETE FROM instructor_audit_log WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.canSee = canSee; // used by the quiz results
