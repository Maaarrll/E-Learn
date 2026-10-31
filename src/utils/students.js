// src/utils/students.js
// Students log in with their full name, so names must be unique
// (ignoring case and extra spaces), and each LRN may have one account.

const { pool } = require('../db');

const LRN_REGEX = /^\d{12}$/;

// "  juan   DELA cruz " -> "juan dela cruz"
function normalizeName(name) {
    return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Same normalizing in SQL, for comparing against users.full_name
const NAME_SQL = "LOWER(REGEXP_REPLACE(BTRIM(full_name), '\\s+', ' ', 'g'))";

// Every account with this name (old accounts may share one)
async function findByName(name, columns = '*') {
    const { rows } = await pool.query(
        `SELECT ${columns} FROM users WHERE ${NAME_SQL} = $1 ORDER BY id`,
        [normalizeName(name)]
    );
    return rows;
}

async function nameTaken(name, exceptUserId = 0) {
    const rows = await findByName(name, 'id');
    return rows.some(r => r.id !== exceptUserId);
}

// Error message when this LRN can't be used for a new account, else null
async function lrnProblem(lrn) {
    if (!LRN_REGEX.test(lrn)) return 'LRN must contain exactly 12 digits.';
    const { rows } = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM allowed_lrns WHERE lrn = $1) AS allowed,
                EXISTS (SELECT 1 FROM users WHERE student_id = $1) AS used`,
        [lrn]
    );
    if (!rows[0].allowed) return 'That LRN is not on the class list. Please check it or ask your teacher.';
    if (rows[0].used) return 'An account with that LRN already exists.';
    return null;
}

module.exports = { LRN_REGEX, normalizeName, findByName, nameTaken, lrnProblem };
