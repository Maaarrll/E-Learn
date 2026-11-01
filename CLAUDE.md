# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — server with `node --watch`. Needs `DATABASE_URL`; the server only listens after `db.ready` resolves.
- `npm test` — NOT a test suite. `scripts/check.js` only checks that every `.js` file and every inline `<script>` in the HTML pages parses, and that `public/dark.css` is up to date. There are no unit tests; verify behavior by running the app.
- `node scripts/quiz-import-check.js` — assert-based self-check for the quiz file importer (`public/js/quiz-import.js`).
- `npm run lint` — ESLint on `.js` files (not inline HTML scripts). `public/js` globals are shared across files, so `no-undef` is off there.
- `npm run build:dark` — regenerate `public/dark.css` from `public/style.css`. Run after any `style.css` change (a hook does this automatically). Never edit `dark.css` by hand; manual dark-mode fixes go in `scripts/dark-manual.css`.
- `npm run instructor -- <add|set-role|reset-password|rename|remove|list> ...` — manage instructor accounts.

## Architecture

- Express (CommonJS, plain JS, no build step) serves the static frontend from `public/`. Pages are plain HTML with inline scripts; `public/js/*.js` are global scripts (not ES modules), e.g. `api.js` defines the global `api` and `requireAuth()`.
- PostgreSQL via `pg`, no ORM, no migrations folder: `src/db.js` creates tables and runs in-place migrations on startup. New schema changes go there and must be idempotent.
- Two separate auth systems: students (`users`, 7-day JWT cookie with session version `sv`) and instructors (`instructors` table, 8-hour cookie, `instructorGuard`). A student cookie must never reach the admin API. Instructor `role` is `admin` (main admin) or `instructor`; plain instructors only see their `instructor_sections`. At least one main admin must always exist.
- Course content lives in the DB (`content_items`: permanent `key`, `draft`, `published`). Edits stay drafts until Publish; each publish snapshots to `content_versions` (last 60). `src/seed/content.json` is only loaded into an empty DB — editing it later does nothing.
- Progress, mistakes and bookmarks reference content `key`s — never rename or reuse keys.
- Lesson text uses a custom markup (`- `, `> `, `**bold**`, `*italic*`) rendered by `public/js/richtext.js` as text, never as HTML. Keep it that way (XSS).
- Streaks and daily goals count days in Philippine time (`src/utils/dates.js`).

- Class open/close: `src/middleware/classOpen.js` blocks student APIs (mounted in `server.js`) until an instructor opens the class (`PUT /api/instructor/class`). `/api/content`, `/api/instructor` and `/api/admin` are never blocked.
- E-certificates are drawn in the browser by `public/Certificate.html` from the student's quiz card and situation quiz progress.

## Gotchas

- Students sign up with an LRN from `allowed_lrns` (Admin page → Allowed LRNs), one account per LRN, and log in with their full name, so names are unique (case/space-insensitive, `src/utils/students.js`). Forgot password = name + LRN.
- `EMAIL_HASH_SECRET` must not change: older accounts still have an `email_hash` and an AES-GCM `email_enc` (used for inactive reminders) keyed from it. New accounts have no email.
- Rate limiting is in-memory and resets on restart.
- Request bodies are capped at 20kb.

## Workflow

- Work on a feature branch named after the feature (e.g. `Study-Cards`), then open a PR into `main` (`/ship`).
- Comments are short plain-English "why" notes; match the indentation style of the file you're editing.
