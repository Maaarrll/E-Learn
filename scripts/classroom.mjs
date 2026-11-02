// scripts/classroom.mjs
// Runs ALLEARN on the classroom laptop with no internet ("Start ALLEARN.bat" runs this).
// Starts the built-in database and the website together, makes a daily backup,
// asks for the first teacher account once, and opens the join page.
// Everything is kept in classroom-data/ (database, videos, backups, secrets).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { spawn, spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import EmbeddedPostgres from 'embedded-postgres';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'classroom-data');
const dbDir = path.join(dataDir, 'db');
const backupDir = path.join(dataDir, 'backups');
const PORT = 3000;
const DB_PORT = 5434; // not 5433, so it never clashes with `npm run db`
const KEEP_BACKUPS = 7;

fs.mkdirSync(backupDir, { recursive: true });
const firstRun = !fs.existsSync(dbDir);

// Secrets are made once and kept, so logins and old data keep working
const secretsFile = path.join(dataDir, 'secrets.json');
if (!fs.existsSync(secretsFile)) {
  const s = () => crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretsFile, JSON.stringify({ JWT_SECRET: s(), EMAIL_HASH_SECRET: s() }, null, 2));
}
const secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));

// A database left running by a crash or power cut would block the start
if (fs.existsSync(path.join(dbDir, 'postmaster.pid'))) {
  const { pg_ctl: pgCtl } = await import('@embedded-postgres/windows-x64');
  spawnSync(pgCtl, ['stop', '-D', dbDir, '-m', 'fast'], { stdio: 'ignore' });
}

// Daily backup: a copy of the (stopped) database folder, newest 7 kept
if (!firstRun) {
  const today = new Date().toISOString().slice(0, 10);
  const target = path.join(backupDir, today);
  if (!fs.existsSync(target)) {
    console.log('Making today\'s backup...');
    fs.cpSync(dbDir, target, { recursive: true, filter: (src) => !src.endsWith('postmaster.pid') });
  }
  const old = fs.readdirSync(backupDir).sort().slice(0, -KEEP_BACKUPS);
  old.forEach(d => fs.rmSync(path.join(backupDir, d), { recursive: true, force: true }));
}

const pg = new EmbeddedPostgres({ databaseDir: dbDir, user: 'postgres', password: 'postgres', port: DB_PORT, persistent: true, onLog: () => {} });
if (firstRun) await pg.initialise();
await pg.start();
if (firstRun) await pg.createDatabase('valueslearn');

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  console.log('Stopping ALLEARN...');
  await pg.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('SIGHUP', stop); // the window's X button on Windows

Object.assign(process.env, {
  DATABASE_URL: `postgresql://postgres:postgres@localhost:${DB_PORT}/valueslearn`,
  PORT: String(PORT),
  VIDEO_DIR: path.join(dataDir, 'videos'),
  PHOTO_DIR: path.join(dataDir, 'photos'),
  ...secrets,
});

const { pool, ready } = require('../src/db');
await ready;

// First start: make the main admin (teacher) account
const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM instructors');
if (!rows[0].n) {
  console.log('\nWelcome! Let\'s make the teacher (main admin) account.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q) => { process.stdout.write(q); return String((await lines.next()).value || '').trim(); };
  const name = await ask('Teacher full name: ');
  const id = await ask('Login ID (letters/numbers, e.g. teacher1): ');
  rl.close();
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'instructor.js'), 'add', '--id', id, '--name', name, '--role', 'admin'],
    { stdio: 'inherit', env: process.env });
  if (r.status !== 0) {
    console.log('\nThe account was not made. Close this window and open ALLEARN again to retry.');
    await new Promise(() => {}); // keep the window open so the message can be read
  }
}

require('../server.js');

const join = `http://localhost:${PORT}/join.html`;
console.log(`\n  ALLEARN is running. Keep this window open during class.`);
console.log(`  Students' address and QR code: ${join}`);
console.log('  To stop: close this window.\n');
if (!process.env.ALLEARN_NO_BROWSER) spawn('cmd', ['/c', 'start', '', join], { stdio: 'ignore', detached: true }).unref();
