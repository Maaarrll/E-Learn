// src/routes/account.js

const express = require('express');
const bcrypt = require('bcryptjs');

const {
    pool
} = require('../db');

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

const cloudinary =
    require('cloudinary').v2;

const multer =
    require('multer');

const streamifier =
    require('streamifier');


const {
    normalizeName,
    nameTaken,
    usernameTaken,
    USERNAME_REGEX,
    USERNAME_RULES_MESSAGE,
    lrnProblem
} = require('../utils/students');
const { splitName } = require('../utils/names');

// Same sections as signup: Grade 7, Section A to Z
const YEAR_SECTION_REGEX = /^Grade 7 - Section [A-Z]$/;

// Maximum lengths for text fields
const MAX_FULL_NAME = 120;
const MAX_YEAR_SECTION = 40;
const MAX_PROGRAM = 80;

// Only common photo formats (no SVG/other files that could carry scripts)
const ALLOWED_IMAGE_TYPES =
    new Set([
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif'
    ]);

// Limits wrong "current password" guesses on the account page
const passwordChangeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Too many attempts. Please wait 15 minutes and try again.'
});

// Every photo upload goes to Cloudinary (uses up its quota)
const photoLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    keyFn: (req) => `photo:${req.userId}`,
    message: 'Too many photo uploads. Please try again in an hour.'
});


/*
    Cloudinary configuration.
*/
cloudinary.config({

    cloud_name:
        process.env.CLOUDINARY_CLOUD_NAME,

    api_key:
        process.env.CLOUDINARY_API_KEY,

    api_secret:
        process.env.CLOUDINARY_API_SECRET

});


const router =
    express.Router();


/*
    Image upload configuration.
*/
const upload =
    multer({

        storage:
            multer.memoryStorage(),

        limits: {
            fileSize:
                3 * 1024 * 1024
        },

        fileFilter:
            (req, file, cb) => {

                if (
                    !ALLOWED_IMAGE_TYPES.has(file.mimetype)
                ) {

                    const err =
                        new Error(
                            'Only JPG, PNG, WEBP or GIF images are allowed.'
                        );

                    err.status = 400;

                    return cb(err);
                }

                cb(null, true);
            }

    });


/*
    Upload profile photo to Cloudinary.
*/
function uploadToCloudinary(
    buffer,
    userId
) {

    return new Promise(
        (resolve, reject) => {

            const uploadStream =
                cloudinary
                    .uploader
                    .upload_stream(

                        {
                            folder:
                                'hcilearn/profile_photos',

                            public_id:
                                `user${userId}`,

                            overwrite:
                                true,

                            /*
                                Cloudinary checks the real file contents,
                                not just the type the browser claims.
                            */
                            resource_type:
                                'image',

                            allowed_formats:
                                ['jpg', 'jpeg', 'png', 'webp', 'gif']
                        },

                        (err, result) => {

                            if (err)
                                reject(err);
                            else
                                resolve(result);
                        }
                    );


            streamifier
                .createReadStream(buffer)
                .pipe(uploadStream);
        }
    );
}


/*
    Only return information that is safe for the frontend.

    The plaintext email and email_hash are NOT returned.
*/
function publicUser(row) {

    return {

        id:
            row.id,

        fullName:
            row.full_name,

        // First / middle / last for the Account page form
        nameParts:
            splitName(row),

        username:
            row.username,

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
   GET ACCOUNT
   ========================================================= */

router.get(
    '/',
    requireAuth,
    async (req, res, next) => {

        try {

            const {
                rows
            } = await pool.query(

                `SELECT
                    id,
                    full_name,
                    first_name,
                    last_name,
                    username,
                    year_section,
                    program,
                    student_id,
                    profile_photo

                 FROM public.users

                 WHERE id = $1`,

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


/* =========================================================
   UPDATE ACCOUNT
   ========================================================= */

router.put(
    '/',
    requireAuth,
    async (req, res, next) => {

        try {

            const {

                fullName,

                firstName,

                middleName,

                lastName,

                username,

                yearSection,

                program,

                studentId,

                password,

                currentPassword

            } = req.body || {};


            /*
                Changing the email is no longer supported here (the
                Account page has no email field). Rejecting it stops a
                stolen session from moving the account to another email.
            */
            if (
                req.body &&
                req.body.email !== undefined &&
                String(req.body.email).trim() !== ''
            ) {

                return res.status(400).json({

                    error:
                        'Email address cannot be changed here.'

                });
            }


            /*
                Get current account.
            */
            const {
                rows
            } = await pool.query(

                `SELECT
                    id,
                    full_name,
                    first_name,
                    last_name,
                    username,
                    year_section,
                    program,
                    student_id,
                    password_hash,
                    session_version,
                    profile_photo

                 FROM public.users

                 WHERE id = $1`,

                [req.userId]
            );


            const user =
                rows[0];


            if (!user) {

                return res.status(404).json({

                    error:
                        'User not found.'

                });
            }


            /* =====================================================
               TEXT FIELDS
               ===================================================== */

            // The Account page sends first / middle / last (like signup), so
            // first_name and last_name stay right for "Ordonia, Marl June S."
            const clean = (v) => String(v || '').trim().replace(/\s+/g, ' ');
            const splitSent = firstName !== undefined || lastName !== undefined;
            if (splitSent && (!clean(firstName) || !clean(lastName))) {
                return res.status(400).json({ error: 'Please enter your first name and last name.' });
            }

            const newFirstName = splitSent ? clean(firstName) : user.first_name;
            const newLastName = splitSent ? clean(lastName) : user.last_name;

            const newFullName =
                splitSent
                    ? [clean(firstName), clean(middleName), clean(lastName)].filter(Boolean).join(' ')
                    : fullName !== undefined && clean(fullName) !== ''
                        ? clean(fullName)
                        : user.full_name;

            const newYearSection =
                yearSection !== undefined
                    ? String(yearSection).trim()
                    : user.year_section;

            const newProgram =
                program !== undefined
                    ? String(program).trim()
                    : user.program;


            if (
                (newFullName || '').length > MAX_FULL_NAME ||
                (newYearSection || '').length > MAX_YEAR_SECTION ||
                (newProgram || '').length > MAX_PROGRAM
            ) {

                return res.status(400).json({

                    error:
                        'One of the fields is too long.'

                });
            }


            // Unchanged keeps older free-typed sections; a new one must be from the list
            if (newYearSection !== user.year_section && !YEAR_SECTION_REGEX.test(newYearSection)) {
                return res.status(400).json({ error: 'Please pick your section from the list.' });
            }

            /*
                The name is the login, so it must stay unique.
            */
            if (
                normalizeName(newFullName) !== normalizeName(user.full_name) &&
                await nameTaken(newFullName, user.id)
            ) {

                return res.status(409).json({

                    error:
                        'Another account already uses that name. Add your middle initial to tell them apart.'

                });
            }


            /*
                Username: blank keeps the current one (older accounts may have none).
            */
            const newUsername =
                username !== undefined &&
                String(username).trim() !== ''
                    ? String(username).trim()
                    : user.username;

            if (newUsername !== user.username) {

                if (!USERNAME_REGEX.test(newUsername)) {

                    return res.status(400).json({

                        error:
                            USERNAME_RULES_MESSAGE

                    });
                }

                // Changing only the letter case of your own username is fine
                if (
                    String(user.username || '').toLowerCase() !== newUsername.toLowerCase() &&
                    await usernameTaken(newUsername)
                ) {

                    return res.status(409).json({

                        error:
                            'That username is already taken. Please choose another one.'

                    });
                }
            }


            /* =====================================================
               STUDENT ID VALIDATION

               Once set, the LRN is locked (one account per LRN).
               Older accounts without one may add an LRN from the
               instructors' list that nobody else has used.
               ===================================================== */

            const newStudentId =
                user.student_id ||
                (studentId ? String(studentId).trim() : null);


            if (
                studentId &&
                user.student_id &&
                String(studentId).trim() !== user.student_id
            ) {

                return res.status(400).json({

                    error:
                        'Your LRN cannot be changed. Please ask your teacher if it is wrong.'

                });
            }


            if (
                newStudentId &&
                !user.student_id
            ) {

                const lrnError =
                    await lrnProblem(newStudentId);

                if (lrnError) {

                    return res.status(400).json({

                        error:
                            lrnError

                    });
                }
            }


            /* =====================================================
               PASSWORD CHANGE

               Requires the current password, so someone using a
               stolen or unattended session can't lock the owner out.
               ===================================================== */

            const changingPassword =
                password !== undefined &&
                password !== null &&
                String(password).length > 0;

            let newPasswordHash =
                user.password_hash;

            let newSessionVersion =
                user.session_version;


            if (changingPassword) {

                if (
                    !isValidPassword(password)
                ) {

                    return res.status(400).json({

                        error:
                            PASSWORD_RULES_MESSAGE

                    });
                }


                // Count attempts only when a password change is tried
                const attempt =
                    passwordChangeLimiter.hit(
                        `account-pw:${req.userId}`
                    );

                if (attempt.limited) {

                    return passwordChangeLimiter.reject(
                        res,
                        attempt.retryAfter
                    );
                }


                const currentOk =
                    typeof currentPassword === 'string' &&
                    currentPassword.length > 0 &&
                    await bcrypt.compare(
                        currentPassword,
                        user.password_hash
                    );

                if (!currentOk) {

                    return res.status(400).json({

                        error:
                            'Your current password is incorrect.'

                    });
                }


                newPasswordHash =
                    await bcrypt.hash(
                        password,
                        10
                    );

                // Logs out every other device
                newSessionVersion =
                    user.session_version + 1;
            }


            /* =====================================================
               UPDATE ACCOUNT
               ===================================================== */

            const {
                rows: updatedRows
            } = await pool.query(

                `UPDATE public.users SET

                    full_name = $1,

                    year_section = $2,

                    program = $3,

                    student_id = $4,

                    password_hash = $5,

                    session_version = $6,

                    username = $8,

                    first_name = $9,

                    last_name = $10

                 WHERE id = $7

                 RETURNING
                    id,
                    full_name,
                    first_name,
                    last_name,
                    username,
                    year_section,
                    program,
                    student_id,
                    profile_photo`,

                [

                    newFullName,

                    newYearSection,

                    newProgram,

                    newStudentId || null,

                    newPasswordHash,

                    newSessionVersion,

                    req.userId,

                    newUsername,

                    newFirstName,

                    newLastName

                ]
            );


            /*
                Keep this device logged in with the new session version.
            */
            if (changingPassword) {

                issueSession(
                    res,
                    req.userId,
                    newSessionVersion
                );
            }


            res.json({

                user:
                    publicUser(
                        updatedRows[0]
                    )

            });

        } catch (err) {

            next(err);
        }
    }
);


/* =========================================================
   UPLOAD PROFILE PHOTO
   ========================================================= */

router.post(
    '/photo',
    requireAuth,
    photoLimiter,
    upload.single('photo'),
    async (req, res, next) => {

        try {

            if (!req.file) {

                return res.status(400).json({

                    error:
                        'No file uploaded.'

                });
            }


            const result =
                await uploadToCloudinary(

                    req.file.buffer,

                    req.userId
                );


            const url =
                result.secure_url;


            await pool.query(

                `UPDATE public.users

                 SET profile_photo = $1

                 WHERE id = $2`,

                [
                    url,
                    req.userId
                ]
            );


            res.json({

                profilePhoto:
                    url

            });

        } catch (err) {

            next(err);
        }
    }
);


/* =========================================================
   DELETE ACCOUNT
   ========================================================= */

router.delete(
    '/',
    requireAuth,
    async (req, res, next) => {

        try {

            /*
                Requires the password, so someone at an unattended,
                logged-in computer can't wipe the account for good.
            */
            const attempt =
                passwordChangeLimiter.hit(
                    `account-pw:${req.userId}`
                );

            if (attempt.limited) {

                return passwordChangeLimiter.reject(
                    res,
                    attempt.retryAfter
                );
            }

            const { password } = req.body || {};

            const { rows } = await pool.query(
                'SELECT password_hash FROM public.users WHERE id = $1',
                [req.userId]
            );

            if (
                !rows[0] ||
                typeof password !== 'string' ||
                !(await bcrypt.compare(password, rows[0].password_hash))
            ) {

                return res.status(400).json({

                    error:
                        'Your password is incorrect.'

                });
            }

            await pool.query(

                'DELETE FROM public.users WHERE id = $1',

                [req.userId]
            );


            /*
                Also remove the profile photo from Cloudinary.
                (Best effort: a failure here shouldn't block deletion.)
            */
            try {
                cloudinary.uploader
                    .destroy(`hcilearn/profile_photos/user${req.userId}`, { resource_type: 'image' })
                    .catch(err => console.error('Could not delete profile photo:', err.message));
            } catch (err) { /* Cloudinary not set up */ }


            clearSession(res);


            res.json({

                ok: true

            });

        } catch (err) {

            next(err);
        }
    }
);


module.exports = router;