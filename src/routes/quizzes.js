// src/routes/quizzes.js
// Timed quizzes made by teachers, for the signed-in student. The server sends
// one question at a time (never the answers ahead) and checks the time itself,
// so changing the page or the clock can't buy extra time. One attempt each;
// a teacher can allow a retake from the Admin Dashboard.
//
// Time frame: a quiz can only be taken between opens_at and closes_at (both
// optional). After closes_at, unfinished attempts are closed with the score
// earned so far, and students who never started count as 0 ("missed").
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

// 'upcoming' (not open yet), 'open' or 'closed' (deadline passed)
function windowOf(quiz) {
  const now = Date.now();
  if (quiz.opens_at && now < new Date(quiz.opens_at).getTime()) return 'upcoming';
  if (quiz.closes_at && now > new Date(quiz.closes_at).getTime()) return 'closed';
  return 'open';
}

function isExpired(quiz, attempt) {
  const pastDeadline = quiz.closes_at && secondsSince(quiz.closes_at) > GRACE_SECONDS;
  return pastDeadline || secondsSince(attempt.shown_at) > quiz.questions[attempt.current].seconds + GRACE_SECONDS;
}

// Attempts still running when their quiz's deadline passed are closed with the
// score earned so far (unanswered questions count as wrong). Run before reading
// scores, so nobody needs a background job for it.
async function closeOverdue() {
  await pool.query(
    `UPDATE quiz_attempts a SET finished_at = q.closes_at
     FROM quizzes q
     WHERE a.quiz_id = q.id AND a.finished_at IS NULL AND q.closes_at < NOW() - make_interval(secs => $1)`,
    [GRACE_SECONDS]
  );
}

// Is this quiz for this student's section? (no list = every section)
const isFor = (quiz, yearSection) => !quiz.target_sections || quiz.target_sections.includes(yearSection || '');

async function sectionOfUser(userId) {
  const u = (await pool.query('SELECT year_section FROM users WHERE id = $1', [userId])).rows[0];
  return u ? u.year_section : '';
}

// Unpublished quizzes are loaded too, so students can still see their finished results
async function load(quizId, userId) {
  const quiz = (await pool.query(
    'SELECT id, questions, published, opens_at, closes_at, target_sections FROM quizzes WHERE id = $1',
    [quizId]
  )).rows[0];
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
  // The timer never runs past the deadline
  let left = q.seconds - secondsSince(attempt.shown_at);
  if (quiz.closes_at) left = Math.min(left, -secondsSince(quiz.closes_at));
  return {
    done: false,
    index: attempt.current,
    total: qs.length,
    question: { text: q.text, choices: q.choices, seconds: q.seconds },
    secondsLeft: Math.max(0, Math.ceil(left)),
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
    await closeOverdue();
    const { rows } = await pool.query(
      `SELECT q.id, q.title, q.description, q.questions, q.opens_at, q.closes_at, q.target_sections,
              a.id AS attempt_id, a.finished_at, a.score
       FROM quizzes q
       LEFT JOIN quiz_attempts a ON a.quiz_id = q.id AND a.user_id = $1
       WHERE q.published OR a.finished_at IS NOT NULL
       ORDER BY q.created_at DESC, q.id DESC`,
      [req.userId]
    );
    const mySection = await sectionOfUser(req.userId);
    res.json({
      // Quizzes for other sections are left out (unless this student already finished it)
      quizzes: rows.filter(r => r.finished_at || isFor(r, mySection)).map(r => {
        const win = windowOf(r);
        const missed = !r.attempt_id && win === 'closed';
        return {
          id: r.id,
          title: r.title,
          description: r.description,
          questionCount: r.questions.length,
          totalSeconds: r.questions.reduce((sum, q) => sum + q.seconds, 0),
          opensAt: r.opens_at,
          closesAt: r.closes_at,
          status: missed ? 'missed' : r.finished_at ? 'done' : win === 'upcoming' ? 'upcoming' : r.attempt_id ? 'started' : 'new',
          score: r.finished_at ? r.score : missed ? 0 : null,
          finishedAt: r.finished_at || (missed ? r.closes_at : null),
        };
      }),
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
    const finished = attempt && attempt.finished_at;
    const canView = quiz && (finished || (quiz.published && isFor(quiz, await sectionOfUser(req.userId))));
    if (!canView) return res.status(404).json({ error: 'This quiz is not available.' });
    const win = windowOf(quiz);
    if (win === 'upcoming' && !attempt) return res.status(403).json({ error: 'This quiz is not open yet.' });
    if (win === 'closed' && !(attempt && attempt.finished_at)) {
      await closeOverdue();
      attempt = (await load(id, req.userId)).attempt;
      // Never started before the deadline: it counts as 0
      if (!attempt || !attempt.finished_at) return res.json({ done: true, missed: true, score: 0, total: quiz.questions.length });
    }
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
    if (!quiz || !quiz.published || !attempt || !isFor(quiz, await sectionOfUser(req.userId))) {
      return res.status(404).json({ error: 'This quiz is not available.' });
    }
    const { index, choice } = req.body || {};
    // Deadline passed mid-quiz: close it with the score so far
    if (!attempt.finished_at && windowOf(quiz) === 'closed' && isExpired(quiz, attempt)) {
      await closeOverdue();
      return res.json({ stale: true, ...stateFor(quiz, (await load(id, req.userId)).attempt) });
    }
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
module.exports.closeOverdue = closeOverdue; // used by the admin quiz results
module.exports.windowOf = windowOf;
