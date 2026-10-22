// src/routes/adminQuizzes.js
// "Quizzes" tab of the Admin Dashboard: teachers make timed multiple-choice
// quizzes (separate from the quiz cards) and see their students' scores.
// The main admin sees every quiz; other instructors only their own, and only
// the results of students in their sections.
const express = require('express');
const { pool } = require('../db');
const { requireInstructor } = require('../middleware/instructorGuard');
const { canSee } = require('./admin');

const router = express.Router();
router.use(requireInstructor);

const LIMITS = { title: 120, description: 1000, questions: 50, text: 500, choice: 200, minChoices: 2, maxChoices: 6, minSeconds: 5, maxSeconds: 600 };

async function audit(instructorRowId, action, details, targetUserId = null) {
  await pool.query(
    'INSERT INTO instructor_audit_log (instructor_id, action, target_user_id, details) VALUES ($1, $2, $3, $4)',
    [instructorRowId, action, targetUserId, details]
  );
}

const parseId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

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
  return { quiz: { title, description, questions, published: b.published === true } };
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
      `SELECT q.id, q.instructor_id, q.title, q.description, q.questions, q.published, q.created_at,
              i.full_name AS instructor_name,
              COUNT(a.id)::int AS attempts, COUNT(a.finished_at)::int AS finished
       FROM quizzes q
       LEFT JOIN instructors i ON i.id = q.instructor_id
       LEFT JOIN quiz_attempts a ON a.quiz_id = q.id
       GROUP BY q.id, i.full_name
       ORDER BY q.created_at DESC, q.id DESC`
    );
    res.json({
      limits: LIMITS,
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
          by: r.instructor_name || '(removed instructor)',
          attempts: r.attempts,
          finished: r.finished,
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
      quiz: { id: quiz.id, title: quiz.title, description: quiz.description, questions: quiz.questions, published: quiz.published, attempts: quiz.attempts },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/quizzes  { title, description, questions, published }
router.post('/', async (req, res, next) => {
  try {
    const { quiz, error } = validate(req.body);
    if (error) return res.status(400).json({ error });
    const { rows } = await pool.query(
      'INSERT INTO quizzes (instructor_id, title, description, questions, published) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id',
      [req.instructor.id, quiz.title, quiz.description, JSON.stringify(quiz.questions), quiz.published]
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
    if (error) return res.status(400).json({ error });
    await pool.query(
      'UPDATE quizzes SET title = $2, description = $3, questions = $4::jsonb, published = $5, updated_at = NOW() WHERE id = $1',
      [existing.id, quiz.title, quiz.description, JSON.stringify(quiz.questions), quiz.published]
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
    const { rows } = await pool.query(
      `SELECT a.user_id, a.score, a.current, a.answers, a.started_at, a.finished_at,
              u.full_name, u.program, u.year_section
       FROM quiz_attempts a JOIN users u ON u.id = a.user_id
       WHERE a.quiz_id = $1
       ORDER BY a.finished_at IS NULL, a.score DESC, u.full_name`,
      [quiz.id]
    );
    const visible = rows.filter(r => canSee(req.instructor, r));
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
      results: visible.map(r => ({
        userId: r.user_id,
        fullName: r.full_name,
        section: [r.program, r.year_section].filter(Boolean).join(' '),
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
