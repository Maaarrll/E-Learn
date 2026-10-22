// scripts/local-db.mjs
// Local PostgreSQL for running the site on this computer (npm run db).
// Data is kept in .localdb/ so accounts and progress survive restarts.
// Matches DATABASE_URL=postgresql://postgres:postgres@localhost:5433/valueslearn
import fs from 'fs';
import EmbeddedPostgres from 'embedded-postgres';

const dir = new URL('../.localdb', import.meta.url);
const firstRun = !fs.existsSync(dir);
const pg = new EmbeddedPostgres({ databaseDir: dir.pathname.replace(/^\/(\w:)/, '$1'), user: 'postgres', password: 'postgres', port: 5433, persistent: true });

if (firstRun) await pg.initialise();
await pg.start();
if (firstRun) await pg.createDatabase('valueslearn');
console.log('Local database ready on port 5433. Keep this window open.');

const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
