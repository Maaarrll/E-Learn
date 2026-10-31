// src/routes/auth.js

const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');

const { pool } = require('../db');

const {
    requireAuth,
    issueSession,
    clearSession
} = require('../middleware/authGuard');

const { rateLimit } = require('../middleware/rateLimit');

const {
    isValidPassword,
    PASSWORD_RULES_MESSAGE
} = require('../utils/passwords');

const {
    LRN_REGEX,
    findByName,
    nameTaken,
    lrnProblem
} = require('../utils/students');

const RESET_TOKEN_MINUTES = 30;

// Maximum lengths for text fields (stops huge values being stored)
const MAX_NAME = 60;
const MAX_PROGRAM = 80;

// Used when the name isn't registered so the login check takes about the
// same time either way (no timing hint that an account exists).
const DUMMY_PASSWORD_HASH =
    bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);


/* ---------------------------------------------------------
   Rate limits (per IP address, plus per name for login)
   --------------------------------------------------------- */

const MINUTE = 60 * 1000;

const loginLimiter = rateLimit({
    windowMs: 15 * MINUTE,
    max: 10,
    keyFn: (req) => `login:${req.ip}:${String((req.body && req.body.name) || '').trim().toLowerCase()}`,
    message: 'Too many login attempts. Please wait 15 minutes and try again.'
});

const loginIpLimiter = rateLimit({
    windowMs: 15 * MINUTE,
    max: 300, // a whole class on one school Wi-Fi shares an IP
    keyFn: (req) => `login-ip:${req.ip}`,
    message: 'Too many login attempts. Please wait 15 minutes and try again.'
});

const signupLimiter = rateLimit({
    windowMs: 60 * MINUTE,
    max: 100,
    keyFn: (req) => `signup:${req.ip}`,
    message: 'Too many sign-up attempts. Please try again later.'
});

// Also slows down guessing someone's LRN
const forgotLimiter = rateLimit({
    windowMs: 15 * MINUTE,
    max: 30,
    keyFn: (req) => `forgot:${req.ip}`,
    message: 'Too many reset requests. Please wait 15 minutes and try again.'
});

const resetLimiter = rateLimit({
    windowMs: 15 * MINUTE,
    max: 50,
    keyFn: (req) => `reset:${req.ip}`,
    message: 'Too many attempts. Please wait 15 minutes and try again.'
});


/*
    SHA-256 for password reset tokens.

    Only the hash of the token is stored in
    the database.
*/
function sha256(value) {

    return crypto
        .createHash('sha256')
        .update(value)
        .digest('hex');
}


/*
    Allowed year choices. Values Education 7 is for Grade 7 learners.

*/
const VALID_YEARS =
    new Set([
        'Grade 7'
    ]);


/*
    Allowed section choices: A to Z, so a big incoming
    batch never runs out of sections.
*/
const VALID_SECTIONS =
    new Set(
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
    );


const router =
    express.Router();


/*
    Controls what user information is
    returned to the frontend.
*/
function publicUser(row) {

    return {

        id: row.id,

        fullName:
            row.full_name,

        yearSection:
            row.year_section,

        program:
            row.program,


        studentId:
            row.student_id,

        profilePhoto:
            row.profile_photo
    };
}


/* =========================================================
   SIGN UP
   ========================================================= */

router.post(
    '/signup',
    signupLimiter,
    async (req, res, next) => {

        try {

            const {

                firstName,

                lastName,

                year,

                section,

                program,

                studentId,

                password

            } = req.body || {};


            /*
                Required fields.
            */
            if (
                !firstName ||
                !lastName ||
                !year ||
                !section ||
                !studentId ||
                !password
            ) {

                return res.status(400).json({

                    error:
                        'First name, last name, year, section, LRN and password are required.'

                });
            }


            /*
                Clean user input. Extra spaces are squeezed out because
                the full name is what the student logs in with.
            */
            const cleanFirstName =
                String(firstName).trim().replace(/\s+/g, ' ');

            const cleanLastName =
                String(lastName).trim().replace(/\s+/g, ' ');

            const cleanYear =
                String(year).trim();

            const cleanSection =
                String(section)
                    .trim()
                    .toUpperCase();

            const cleanStudentId =
                String(studentId).trim();


            /*
                Check names.
            */
            if (
                !cleanFirstName ||
                !cleanLastName
            ) {

                return res.status(400).json({

                    error:
                        'Please enter both your first name and last name.'

                });
            }


            /*
                Check lengths.
            */
            const cleanProgram =
                program ? String(program).trim() : '';

            if (
                cleanFirstName.length > MAX_NAME ||
                cleanLastName.length > MAX_NAME ||
                cleanProgram.length > MAX_PROGRAM
            ) {

                return res.status(400).json({

                    error:
                        'One of the fields is too long.'

                });
            }


            /*
                Check LRN format (exactly 12 digits).
            */
            if (
                !LRN_REGEX.test(cleanStudentId)
            ) {

                return res.status(400).json({

                    error:
                        'LRN must contain exactly 12 digits.'

                });
            }


            /*
                Check year.
            */
            if (
                !VALID_YEARS.has(cleanYear)
            ) {

                return res.status(400).json({

                    error:
                        'Please select a valid year.'

                });
            }


            /*
                Check section.
            */
            if (
                !VALID_SECTIONS.has(cleanSection)
            ) {

                return res.status(400).json({

                    error:
                        'Please select a valid section.'

                });
            }


            /*
                Check password.
            */
            if (
                !isValidPassword(password)
            ) {

                return res.status(400).json({

                    error:
                        PASSWORD_RULES_MESSAGE

                });
            }


            /*
                The LRN must be on the instructors' list
                and not used by another account yet.
            */
            const lrnError =
                await lrnProblem(cleanStudentId);

            if (lrnError) {

                return res.status(lrnError.includes('already') ? 409 : 400).json({

                    error:
                        lrnError

                });
            }


            /*
                Combine first and last name.
            */
            const fullName =
                `${cleanFirstName} ${cleanLastName}`;


            /*
                The name is the login, so it must be unique.
            */
            if (
                await nameTaken(fullName)
            ) {

                return res.status(409).json({

                    error:
                        'An account with that name already exists. Add your middle initial to your first name (e.g. "Juan M.").'

                });
            }


            /*
                Hash password with bcrypt.
            */
            const passwordHash =
                await bcrypt.hash(
                    password,
                    10
                );


            /*
                Combine year and section.
            */
            const yearSection =
                `${cleanYear} - Section ${cleanSection}`;


            /*
                Insert account.
            */
            let insert;

            try {

                insert =
                    await pool.query(

                        `INSERT INTO users
                        (
                            full_name,
                            first_name,
                            last_name,
                            year_section,
                            program,
                            student_id,
                            password_hash
                        )

                        VALUES
                        (
                            $1,
                            $2,
                            $3,
                            $4,
                            $5,
                            $6,
                            $7
                        )

                        RETURNING id`,

                        [

                            fullName,

                            cleanFirstName,

                            cleanLastName,

                            yearSection,

                            cleanProgram || null,

                            cleanStudentId,

                            passwordHash
                        ]
                    );

            } catch (err) {

                // Two signups with the same LRN at the same moment
                if (err.code === '23505') {

                    return res.status(409).json({

                        error:
                            'An account with that LRN already exists.'

                    });
                }

                throw err;
            }


            const userId =
                insert.rows[0].id;


            /*
                Create progress records.
            */
            await pool.query(
                'INSERT INTO case_study_progress (user_id) VALUES ($1)',
                [userId]
            );

            await pool.query(
                'INSERT INTO study_card_progress (user_id) VALUES ($1)',
                [userId]
            );

            await pool.query(
                'INSERT INTO lesson_progress (user_id) VALUES ($1)',
                [userId]
            );


            /*
                Log the user in immediately.
            */
            issueSession(
                res,
                userId,
                0
            );


            /*
                Get user information.
            */
            const {
                rows
            } = await pool.query(

                'SELECT * FROM users WHERE id = $1',

                [userId]
            );


            res.status(201).json({

                user:
                    publicUser(rows[0])

            });

        } catch (err) {

            next(err);
        }
    }
);


/* =========================================================
   LOGIN
   ========================================================= */

router.post(
    '/login',
    loginIpLimiter,
    loginLimiter,
    async (req, res, next) => {

        try {

            const {
                name,
                password
            } = req.body || {};


            if (
                !name ||
                typeof name !== 'string' ||
                !password ||
                typeof password !== 'string'
            ) {

                return res.status(400).json({

                    error:
                        'Name and password are required.'

                });
            }


            /*
                Find the account by full name. Accounts made before
                names had to be unique may share a name, so the
                password decides which one it is.
            */
            const candidates =
                await findByName(name);

            let user = null;

            for (const row of candidates) {

                if (await bcrypt.compare(password, row.password_hash)) {

                    user = row;

                    break;
                }
            }


            /*
                When the name isn't registered we still compare against a
                dummy hash, so the reply takes the same time either way.
            */
            if (!candidates.length) {

                await bcrypt.compare(
                    password,
                    DUMMY_PASSWORD_HASH
                );
            }


            if (!user) {

                return res.status(401).json({

                    error:
                        'Invalid name or password.'

                });
            }


            /*
                Deactivated by an instructor (checked after the password,
                so it does not reveal which accounts exist).
            */
            if (user.disabled_at) {
                return res.status(403).json({
                    error:
                        'This account has been deactivated. Please contact your instructor.'
                });
            }


            /*
                Login session.
            */
            issueSession(
                res,
                user.id,
                user.session_version
            );


            res.json({

                user:
                    publicUser(user)

            });

        } catch (err) {

            next(err);
        }
    }
);


/* =========================================================
   FORGOT PASSWORD

   The student proves who they are with their name and LRN,
   then gets a short-lived token to set a new password on
   update-password.html.
   ========================================================= */

router.post(
    '/forgot-password',
    forgotLimiter,
    async (req, res, next) => {

        try {

            const {
                name,
                lrn
            } = req.body || {};

            const cleanLrn =
                String(lrn || '').trim();


            if (
                !name ||
                typeof name !== 'string' ||
                !LRN_REGEX.test(cleanLrn)
            ) {

                return res.status(400).json({

                    error:
                        'Please enter your full name and your 12-digit LRN.'

                });
            }


            const user =
                (await findByName(name, 'id, student_id'))
                    .find(r => r.student_id === cleanLrn);


            if (!user) {

                return res.status(400).json({

                    error:
                        "That name and LRN don't match any account. Use the name you log in with, or ask your teacher."

                });
            }


            /*
                Generate random reset token.
            */
            const token =
                crypto
                    .randomBytes(32)
                    .toString('hex');


            /*
                Delete old reset tokens.
            */
            await pool.query(

                'DELETE FROM password_resets WHERE user_id = $1',

                [
                    user.id
                ]
            );


            /*
                Store only SHA-256 hash
                of reset token.
            */
            await pool.query(

                `INSERT INTO password_resets
                (
                    user_id,
                    token_hash,
                    expires_at
                )

                VALUES
                (
                    $1,
                    $2,
                    NOW() +
                    ($3 || ' minutes')::interval
                )`,

                [

                    user.id,

                    sha256(token),

                    String(
                        RESET_TOKEN_MINUTES
                    )

                ]
            );


            return res.json({

                ok: true,

                token

            });

        } catch (err) {

            next(err);
        }
    }
);


/* =========================================================
   RESET PASSWORD
   ========================================================= */

router.post(
    '/reset-password',
    resetLimiter,
    async (req, res, next) => {

        try {

            const {
                token,
                password
            } = req.body || {};


            if (
                !token ||
                typeof token !== 'string' ||
                !/^[a-f0-9]{64}$/.test(token)
            ) {

                return res.status(400).json({

                    error:
                        'Reset link is missing or invalid. Please request a new one.'

                });
            }


            if (
                !isValidPassword(password)
            ) {

                return res.status(400).json({

                    error:
                        PASSWORD_RULES_MESSAGE

                });
            }


            /*
                Search reset token using
                SHA-256 hash.
            */
            const {
                rows
            } = await pool.query(

                `SELECT
                    u.id AS user_id,
                    u.full_name

                 FROM password_resets pr

                 JOIN users u
                 ON u.id = pr.user_id

                 WHERE pr.token_hash = $1

                 AND pr.expires_at > NOW()`,

                [
                    sha256(token)
                ]
            );


            const match =
                rows[0];


            if (!match) {

                return res.status(400).json({

                    error:
                        'This reset link is invalid or has expired. Please request a new one.'

                });
            }


            /*
                Hash new password.
            */
            const newPasswordHash =
                await bcrypt.hash(
                    password,
                    10
                );


            /*
                Save the new password and bump the session version,
                which logs out every device still using the old password.
            */
            await pool.query(

                `UPDATE users
                 SET password_hash = $1,
                     session_version = session_version + 1
                 WHERE id = $2`,

                [
                    newPasswordHash,

                    match.user_id
                ]
            );


            /*
                Make reset link single-use.
            */
            await pool.query(

                `DELETE FROM password_resets
                 WHERE user_id = $1`,

                [
                    match.user_id
                ]
            );


            res.json({

                ok: true,

                message:
                    'Password updated. You can now log in.'

            });

        } catch (err) {

            next(err);
        }
    }
);


/* =========================================================
   LOGOUT
   ========================================================= */

router.post(
    '/logout',
    (req, res) => {

        clearSession(res);

        res.json({
            ok: true
        });
    }
);


/* =========================================================
   CURRENT USER
   ========================================================= */

router.get(
    '/me',
    requireAuth,
    async (req, res, next) => {

        try {

            const {
                rows
            } = await pool.query(

                'SELECT * FROM users WHERE id = $1',

                [req.userId]
            );


            if (!rows[0]) {

                return res.status(404).json({

                    error:
                        'User not found.'

                });
            }


            res.json({

                user:
                    publicUser(rows[0])

            });

        } catch (err) {

            next(err);
        }
    }
);


module.exports = router;