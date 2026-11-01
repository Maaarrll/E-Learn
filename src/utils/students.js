// src/utils/students.js
// Students log in with their username, or their full name (older accounts
// have no username), so names must be unique (ignoring case and extra
// spaces), and each LRN may have one account.

const { pool } = require('../db');

const LRN_REGEX = /^\d{12}$/;

// No spaces, so a username can never look like a full name ("First Last")
const USERNAME_REGEX = /^[a-z0-9._]{3,20}$/i;
const USERNAME_RULES_MESSAGE =
    'Username must be 3 to 20 characters: letters, numbers, dots or underscores (no spaces).';

// "  juan   DELA cruz " -> "juan dela cruz"
function normalizeName(name) {
    return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Same normalizing in SQL, for comparing against users.full_name
const NAME_SQL = "LOWER(REGEXP_REPLACE(BTRIM(full_name), '\\s+', ' ', 'g'))";

// Every account with this username or name (old accounts may share a name)
async function findByName(name, columns = '*') {
    const { rows } = await pool.query(
        `SELECT ${columns} FROM users WHERE LOWER(username) = $1 OR ${NAME_SQL} = $1 ORDER BY id`,
        [normalizeName(name)]
    );
    return rows;
}

async function nameTaken(name, exceptUserId = 0) {
    const rows = await findByName(name, 'id');
    return rows.some(r => r.id !== exceptUserId);
}

async function usernameTaken(username) {
    const { rows } = await pool.query(
        'SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)',
        [username]
    );
    return rows.length > 0;
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

module.exports = {
    LRN_REGEX, USERNAME_REGEX, USERNAME_RULES_MESSAGE,
    normalizeName, findByName, nameTaken, usernameTaken, lrnProblem
};
