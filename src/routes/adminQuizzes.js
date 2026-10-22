// src/routes/adminQuizzes.js
// "Quizzes" tab of the Admin Dashboard: teachers make timed multiple-choice
// quizzes (separate from the quiz cards) and see their students' scores.
// The main admin sees every quiz; other instructors only their own, and only
// the results of students in their sections.
const express = require('express');
const { pool } = require('../db');
const { requireInstructor } = require('../middleware/instructorGuard');
const { canSee } = require('./admin');
const { closeOverdue, windowOf } = require('./quizzes');

const router = express.Router();
router.use(requireInstructor);

const LIMITS = { title: 120, description: 1000, questions: 50, text: 500, choice: 200, minChoices: 2, maxChoices: 6, minSeconds: 5, maxSeconds: 600 };

async function audit(instructorRowId, action, details, targetUserId = null) {
  await pool.query(
    'INSERT INTO instructor_audit_log (instructor_id, action, target_user_id, details) VALUES ($1, $2, $3, $4)',
    [instructorRowId, action, targetUserId, details]
  );
}

// ?section=Grade 7 - Section A narrows the numbers to one section ('' = all)
const sectionOf = (req) => (typeof req.query.section === 'string' ? req.query.section : '');
const inSection = (section) => (u) => !section || u.year_section === section;

const parseId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// { opensAt, closesAt } (ISO strings or empty) -> { window } or { error }
function validateWindow(b) {
  const parse = (v, label) => {
    if (v === undefined || v === null || v === '') return { value: null };
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    return Number.isNaN(t) ? { error: `Pick a valid ${label}.` } : { value: new Date(t) };
  };
  const opens = parse(b.opensAt, 'opening time');
  const closes = parse(b.closesAt, 'deadline');
  if (opens.error || closes.error) return { error: opens.error || closes.error };
  if (opens.value && closes.value && closes.value <= opens.value) return { error: 'The deadline must be after the opening time.' };
  return { window: { opensAt: opens.value, closesAt: closes.value } };
}

// sections: null/[] = everyone (main admin only), otherwise year_section names.
// Other instructors can only pick their own sections.
function validateAudience(b, instructor) {
  const raw = Array.isArray(b.sections) ? b.sections : [];
  const picked = [...new Set(raw.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean))];
  if (picked.length > 100 || picked.some(x => x.length > 80)) return { error: 'Pick fewer sections.' };
  if (instructor.isAdmin) return { sections: picked.length ? picked : null };
  const mine = instructor.sections.map(sec => sec.yearSection);
  if (!mine.length) return { error: 'You have no sections yet. Ask the main admin to assign them.' };
  if (!picked.length) return { sections: mine };   // default: all of my sections
  if (!picked.every(x => mine.includes(x))) return { error: 'You can only give quizzes to your own sections.' };
  return { sections: picked };
}

// Returns { quiz } with cleaned values, or { error } for the teacher
function validate(body) {
  const b = body || {};
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const description = typeof b.description === 'string' ? b.description.trim() : '';
  if (!title || title.length > LIMITS.title) return { error: `Give the quiz a title (up to ${LIMITS.title} characters).` };
  if (description.length > LIMITS.description) return { error: `Instructions can be up to ${LIMITS.description} characters.` };
  if (!Array.isArray(b.questions) || !b.questions.length) return { error: 'Add at least one question.' };
  if (b.questions.length > LIMITS.questions) return { error: `A quiz can have up to ${LIMITS.questions} questions.` };

  const questions = [];
  for (const [i, q] of b.questions.entries()) {
    const n = `Question ${i + 1}`;
    const text = q && typeof q.text === 'string' ? q.text.trim() : '';
    if (!text || text.length > LIMITS.text) return { error: `${n}: write the question (up to ${LIMITS.text} characters).` };
    const choices = q && Array.isArray(q.choices) ? q.choices.map(c => (typeof c === 'string' ? c.trim() : '')) : [];
    if (choices.length < LIMITS.minChoices || choices.length > LIMITS.maxChoices || choices.some(c => !c || c.length > LIMITS.choice)) {
      return { error: `${n}: give ${LIMITS.minChoices} to ${LIMITS.maxChoices} choices, none empty (up to ${LIMITS.choice} characters each).` };
    }
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= choices.length) return { error: `${n}: mark the correct answer.` };
    if (!Number.isInteger(q.seconds) || q.seconds < LIMITS.minSeconds || q.seconds > LIMITS.maxSeconds) {
      return { error: `${n}: the time must be ${LIMITS.minSeconds} to ${LIMITS.maxSeconds} seconds.` };
    }
    questions.push({ text, choices, answer: q.answer, seconds: q.seconds });
  }
  const win = validateWindow(b);
  if (win.error) return { error: win.error };
  return { quiz: { title, description, questions, published: b.published === true, ...win.window } };
}

// The quiz if this instructor may manage it (main admin: any quiz)
async function findQuiz(req, id) {
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT q.*, (SELECT COUNT(*)::int FROM quiz_attempts a WHERE a.quiz_id = q.id) AS attempts
     FROM quizzes q WHERE q.id = $1`,
    [id]
  );
  const quiz = rows[0];
  if (!quiz || (!req.instructor.isAdmin && quiz.instructor_id !== req.instructor.id)) return null;
  return quiz;
}

// GET /api/admin/quizzes
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT q.id, q.instructor_id, q.title, q.description, q.questions, q.published, q.created_at, q.opens_at, q.closes_at,
              q.target_sections,
              i.full_name AS instructor_name,
              COUNT(a.id)::int AS attempts, COUNT(a.finished_at)::int AS finished
       FROM quizzes q
       LEFT JOIN instructors i ON i.id = q.instructor_id
       LEFT JOIN quiz_attempts a ON a.quiz_id = q.id
       GROUP BY q.id, i.full_name
       ORDER BY q.created_at DESC, q.id DESC`
    );
    // Card numbers only count students this instructor can see (main admin: everyone)
    await closeOverdue();
    const section = sectionOf(req);
    const everyone = (await pool.query('SELECT program, year_section FROM users WHERE disabled_at IS NULL')).rows
      .filter(u => canSee(req.instructor, u));
    const sections = [...new Set([
      ...everyone.map(u => u.year_section),
      ...req.instructor.sections.map(sec => sec.yearSection),
    ].filter(Boolean))].sort();
    const shown = everyone.filter(inSection(section));
    // Only students the quiz is for count as "not taken" / "missed"
    const studentsFor = (r) => shown.filter(u => !r.target_sections || r.target_sections.includes(u.year_section)).length;
    const seen = (await pool.query(
      `SELECT a.quiz_id, a.score, a.finished_at, u.program, u.year_section
       FROM quiz_attempts a JOIN users u ON u.id = a.user_id`
    )).rows.filter(a => canSee(req.instructor, a) && inSection(section)(a));
    const statsFor = (r) => {
      const mine = seen.filter(a => a.quiz_id === r.id);
      const done = mine.filter(a => a.finished_at);
      const notTaken = Math.max(0, studentsFor(r) - mine.filter(a => !r.target_sections || r.target_sections.includes(a.year_section)).length);
      return {
        finished: done.length,
        inProgress: mine.length - done.length,
        averagePct: done.length ? Math.round((done.reduce((sum, a) => sum + a.score, 0) / done.length / r.questions.length) * 100) : null,
        notTaken,
        missed: windowOf(r) === 'closed' ? notTaken : 0,
      };
    };
    res.json({
      limits: LIMITS,
      sections,
      canTargetEveryone: req.instructor.isAdmin,
      mySections: req.instructor.sections.map(sec => sec.yearSection),
      quizzes: rows
        .filter(r => req.instructor.isAdmin || r.instructor_id === req.instructor.id)
        .map(r => ({
          id: r.id,
          title: r.title,
          description: r.description,
          questionCount: r.questions.length,
          totalSeconds: r.questions.reduce((sum, q) => sum + q.seconds, 0),
          published: r.published,
          createdAt: r.created_at,
          opensAt: r.opens_at,
          closesAt: r.closes_at,
          window: windowOf(r),
          sections: r.target_sections,
          by: r.instructor_name || '(removed instructor)',
          attempts: r.attempts,   // any student at all: locks editing
          ...statsFor(r),
        })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/quizzes/:id — the full quiz, for editing
router.get('/:id', async (req, res, next) => {
  try {
    const quiz = await findQuiz(req, parseId(req.params.id));
    if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
    res.json({
      quiz: {
        id: quiz.id, title: quiz.title, description: quiz.description, questions: quiz.questions,
        published: quiz.published, attempts: quiz.attempts, opensAt: quiz.opens_at, closesAt: quiz.closes_at,
        sections: quiz.target_sections,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/quizzes  { title, description, questions, published }
router.post('/', async (req, res, next) => {
  try {
    const { quiz, error } = validate(req.body);
    const audience = validateAudience(req.body || {}, req.instructor);
    if (error || audience.error) return res.status(400).json({ error: error || audience.error });
    const { rows } = await pool.query(
      `INSERT INTO quizzes (instructor_id, title, description, questions, published, opens_at, closes_at, target_sections)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb) RETURNING id`,
      [req.instructor.id, quiz.title, quiz.description, JSON.stringify(quiz.questions), quiz.published, quiz.opensAt, quiz.closesAt,
        audience.sections ? JSON.stringify(audience.sections) : null]
    );
    await audit(req.instructor.id, 'create_quiz', quiz.title);
    res.json({ id: rows[0].id });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/quizzes/:id — replace the quiz. Not allowed once a student
// has started it, so everyone is scored on the same questions.
router.put('/:id', async (req, res, next) => {
  try {
    const existing = await findQuiz(req, parseId(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Quiz not found.' });
    if (existing.attempts > 0) {
      return res.status(409).json({ error: 'Students have already taken this quiz, so its questions can no longer change. Make a new quiz instead.' });
    }
    const { quiz, error } = validate(req.body);
    const audience = validateAudience(req.body || {}, req.instructor);
    if (error || audience.error) return res.status(400).json({ error: error || audience.error });
    await pool.query(
      `UPDATE quizzes SET title = $2, description = $3, questions = $4::jsonb, published = $5,
              opens_at = $6, closes_at = $7, target_sections = $8::jsonb, updated_at = NOW()
       WHERE id = $1`,
      [existing.id, quiz.title, quiz.description, JSON.stringify(quiz.questions), quiz.published, quiz.opensAt, quiz.closesAt,
        audience.sections ? JSON.stringify(audience.sections) : null]
    );
    await audit(req.instructor.id, 'update_quiz', quiz.title);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/quizzes/:id/publish  { published }
router.put('/:id/publish', async (req, res, next) => {
  try {
    const quiz = await findQuiz(req, parseId(req.params.id));
    if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
    const published = (req.body || {}).published === true;
    await pool.query('UPDATE quizzes SET published = $2, updated_at = NOW() WHERE id = $1', [quiz.id, published]);
    await audit(req.instructor.id, published ? 'publish_quiz' : 'unpublish_quiz', quiz.title);
    res.json({ published });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/quizzes/:id/schedule  { opensAt, closesAt, sections }
// Allowed even after students started, e.g. to give more time or add a section.
router.put('/:id/schedule', async (req, res, next) => {
  try {
    const quiz = await findQuiz(req, parseId(req.params.id));
    if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
    const { window, error } = validateWindow(req.body || {});
    const audience = validateAudience(req.body || {}, req.instructor);
    if (error || audience.error) return res.status(400).json({ error: error || audience.error });
    await pool.query(
      'UPDATE quizzes SET opens_at = $2, closes_at = $3, target_sections = $4::jsonb, updated_at = NOW() WHERE id = $1',
      [quiz.id, window.opensAt, window.closesAt, audience.sections ? JSON.stringify(audience.sections) : null]
    );
    await audit(req.instructor.id, 'schedule_quiz', quiz.title);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/quizzes/:id — also deletes its results
router.delete('/:id', async (req, res, next) => {
  try {
    const quiz = await findQuiz(req, parseId(req.params.id));
    if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
    await pool.query('DELETE FROM quizzes WHERE id = $1', [quiz.id]);
    await audit(req.instructor.id, 'delete_quiz', quiz.title);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/quizzes/:id/results — scores of the students this instructor can see
router.get('/:id/results', async (req, res, next) => {
  try {
    const quiz = await findQuiz(req, parseId(req.params.id));
    if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
    await closeOverdue();
    const { rows } = await pool.query(
      `SELECT a.user_id, a.score, a.current, a.answers, a.started_at, a.finished_at,
              u.full_name, u.program, u.year_section
       FROM quiz_attempts a JOIN users u ON u.id = a.user_id
       WHERE a.quiz_id = $1
       ORDER BY a.finished_at IS NULL, a.score DESC, u.full_name`,
      [quiz.id]
    );
    const section = sectionOf(req);
    const visible = rows.filter(r => canSee(req.instructor, r) && inSection(section)(r));
    // Students (that this instructor sees) who haven't started it
    const taken = new Set(rows.map(r => r.user_id));
    const notTaken = (await pool.query(
      'SELECT id, full_name, program, year_section FROM users WHERE disabled_at IS NULL ORDER BY full_name'
    )).rows.filter(u => !taken.has(u.id) && canSee(req.instructor, u) && inSection(section)(u)
      && (!quiz.target_sections || quiz.target_sections.includes(u.year_section)));
    const closed = windowOf(quiz) === 'closed';
    // How many students got each question right (finished attempts only)
    const done = visible.filter(r => r.finished_at);
    res.json({
      title: quiz.title,
      total: quiz.questions.length,
      questions: quiz.questions.map((q, i) => ({
        text: q.text,
        correct: done.filter(r => r.answers[i] && r.answers[i].correct).length,
        timedOut: done.filter(r => r.answers[i] && r.answers[i].timedOut).length,
      })),
      finishedCount: done.length,
      closed,
      closesAt: quiz.closes_at,
      notTakenCount: notTaken.length,
      // After the deadline, everyone who didn't take it is listed with 0
      missed: closed ? notTaken.map(u => ({
        userId: u.id,
        fullName: u.full_name,
        section: u.year_section || '',
      })) : [],
      results: visible.map(r => ({
        userId: r.user_id,
        fullName: r.full_name,
        section: r.year_section || '',
        score: r.score,
        answered: r.current,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/quizzes/:id/attempts/:userId — let a student take it again
router.delete('/:id/attempts/:userId', async (req, res, next) => {
  try {
    const quiz = await findQuiz(req, parseId(req.params.id));
    const userId = parseId(req.params.userId);
    if (!quiz || !userId) return res.status(404).json({ error: 'Quiz not found.' });
    const student = (await pool.query('SELECT id, program, year_section FROM users WHERE id = $1', [userId])).rows[0];
    if (!student || !canSee(req.instructor, student)) return res.status(404).json({ error: 'Student not found.' });
    await pool.query('DELETE FROM quiz_attempts WHERE quiz_id = $1 AND user_id = $2', [quiz.id, userId]);
    await audit(req.instructor.id, 'allow_quiz_retake', quiz.title, userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.validate = validate; // for tests
