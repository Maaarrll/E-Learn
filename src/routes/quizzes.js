// src/routes/quizzes.js
// Timed quizzes made by teachers, for the signed-in student. The server sends
// one question at a time (never the answers ahead) and checks the time itself,
// so changing the page or the clock can't buy extra time. One attempt each;
// a teacher can allow a retake from the Admin Dashboard.
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/authGuard');

const router = express.Router();
router.use(requireAuth);

// Extra seconds allowed for a slow connection before an answer counts as late
const GRACE_SECONDS = 3;

const parseId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const secondsSince = (ts) => (Date.now() - new Date(ts).getTime()) / 1000;

function isExpired(quiz, attempt) {
  return secondsSince(attempt.shown_at) > quiz.questions[attempt.current].seconds + GRACE_SECONDS;
}

// Unpublished quizzes are loaded too, so students can still see their finished results
async function load(quizId, userId) {
  const quiz = (await pool.query('SELECT id, questions, published FROM quizzes WHERE id = $1', [quizId])).rows[0];
  if (!quiz) return {};
  const attempt = (await pool.query('SELECT * FROM quiz_attempts WHERE quiz_id = $1 AND user_id = $2', [quizId, userId])).rows[0];
  return { quiz, attempt };
}

// What the student sees: the current question, or only the final score once
// finished. Correct answers and which questions were missed are never sent,
// so students can't pass the answers around (the teacher sees them).
function stateFor(quiz, attempt) {
  const qs = quiz.questions;
  if (attempt.finished_at) {
    return {
      done: true,
      score: attempt.score,
      total: qs.length,
    };
  }
  const q = qs[attempt.current];
  return {
    done: false,
    index: attempt.current,
    total: qs.length,
    question: { text: q.text, choices: q.choices, seconds: q.seconds },
    secondsLeft: Math.max(0, Math.ceil(q.seconds - secondsSince(attempt.shown_at))),
  };
}

// Saves the answer to the current question (choice null = time ran out) and
// shows the next one. Only works while that question is still current, so a
// double click or a second tab can't answer twice. Returns attempt null if
// something else got there first.
async function answer(quiz, attempt, choice) {
  const q = quiz.questions[attempt.current];
  const timedOut = choice === null || isExpired(quiz, attempt);
  const correct = !timedOut && choice === q.answer;
  const next = attempt.current + 1;
  const { rows } = await pool.query(
    `UPDATE quiz_attempts
     SET answers = answers || $3::jsonb, current = $4, score = score + $5, shown_at = NOW(),
         finished_at = CASE WHEN $6 THEN NOW() END
     WHERE id = $1 AND current = $2 AND finished_at IS NULL
     RETURNING *`,
    [attempt.id, attempt.current, JSON.stringify([{ choice: timedOut ? null : choice, correct, timedOut }]),
      next, correct ? 1 : 0, next >= quiz.questions.length]
  );
  return { attempt: rows[0] || null, timedOut };
}

// GET /api/quizzes — published quizzes, plus any this student finished
// (even if the teacher has since unpublished it), with their status
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT q.id, q.title, q.description, q.questions, a.id AS attempt_id, a.finished_at, a.score
       FROM quizzes q
       LEFT JOIN quiz_attempts a ON a.quiz_id = q.id AND a.user_id = $1
       WHERE q.published OR a.finished_at IS NOT NULL
       ORDER BY q.created_at DESC, q.id DESC`,
      [req.userId]
    );
    res.json({
      quizzes: rows.map(r => ({
        id: r.id,
        title: r.title,
        description: r.description,
        questionCount: r.questions.length,
        totalSeconds: r.questions.reduce((sum, q) => sum + q.seconds, 0),
        status: !r.attempt_id ? 'new' : r.finished_at ? 'done' : 'started',
        score: r.finished_at ? r.score : null,
        finishedAt: r.finished_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/quizzes/:id/start — start, or come back to, this quiz
router.post('/:id/start', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    let { quiz, attempt } = id ? await load(id, req.userId) : {};
    const canView = quiz && (quiz.published || (attempt && attempt.finished_at));
    if (!canView) return res.status(404).json({ error: 'This quiz is not available.' });
    if (!attempt) {
      await pool.query('INSERT INTO quiz_attempts (quiz_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, req.userId]);
      ({ attempt } = await load(id, req.userId));
    }
    // Left the page and came back after the time ran out: that question is missed
    if (!attempt.finished_at && isExpired(quiz, attempt)) {
      attempt = (await answer(quiz, attempt, null)).attempt || (await load(id, req.userId)).attempt;
    }
    res.json(stateFor(quiz, attempt));
  } catch (err) {
    next(err);
  }
});

// POST /api/quizzes/:id/answer  { index, choice }  (choice null = time ran out)
router.post('/:id/answer', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const { quiz, attempt } = id ? await load(id, req.userId) : {};
    if (!quiz || !quiz.published || !attempt) return res.status(404).json({ error: 'This quiz is not available.' });
    const { index, choice } = req.body || {};
    // Already answered (double click, other tab): just send where the quiz is now
    if (attempt.finished_at || index !== attempt.current) return res.json({ stale: true, ...stateFor(quiz, attempt) });

    const q = quiz.questions[attempt.current];
    if (choice !== null && !(Number.isInteger(choice) && choice >= 0 && choice < q.choices.length)) {
      return res.status(400).json({ error: 'Pick one of the choices.' });
    }
    const saved = await answer(quiz, attempt, choice);
    if (!saved.attempt) {
      const fresh = (await load(id, req.userId)).attempt;
      if (!fresh) return res.status(404).json({ error: 'This quiz is not available.' });
      return res.json({ stale: true, ...stateFor(quiz, fresh) });
    }
    res.json({ timedOut: saved.timedOut, ...stateFor(quiz, saved.attempt) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
