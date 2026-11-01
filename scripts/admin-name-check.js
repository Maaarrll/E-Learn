// node scripts/admin-name-check.js — self-check for adminName (src/utils/names.js)
const assert = require('assert');
const { adminName } = require('../src/utils/names');

const n = (full_name, first_name, last_name) => adminName({ full_name, first_name, last_name });

assert.strictEqual(n('Marl June Santos Ordonia', 'Marl June', 'Ordonia'), 'Ordonia, Marl June S.');
assert.strictEqual(n('Marl June S. Ordonia', 'Marl June', 'Ordonia'), 'Ordonia, Marl June S.');
assert.strictEqual(n('Marl June Ordonia', 'Marl June', 'Ordonia'), 'Ordonia, Marl June');
assert.strictEqual(n('Ana Dela Cruz', 'Ana', 'Dela Cruz'), 'Dela Cruz, Ana');
assert.strictEqual(n('marl  june ordonia', 'Marl June', 'Ordonia'), 'ordonia, marl june');
// Renamed after signup: first/last no longer match, last word is the surname
assert.strictEqual(n('Juan Carlos Reyes', 'Pedro', 'Santos'), 'Reyes, Juan Carlos');
assert.strictEqual(n('Juan Reyes', null, null), 'Reyes, Juan');
assert.strictEqual(n('Madonna', 'Madonna', ''), 'Madonna');
assert.strictEqual(n('', null, null), '');

console.log('adminName: all checks passed.');
