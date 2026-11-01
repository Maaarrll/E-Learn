// src/utils/names.js

// { first, middle, last } of a student. full_name is "First Middle Last";
// first_name/last_name are saved at signup (and on the Account page), so the
// middle is what sits between. If they don't match (older accounts), the last
// word is the surname and there is no middle.
function splitName({ full_name, first_name, last_name }) {
    const clean = (v) => String(v || '').trim().replace(/\s+/g, ' ');
    const full = clean(full_name);
    const first = clean(first_name);
    const last = clean(last_name);
    const lower = full.toLowerCase();
    if (first && last && full.length > first.length + last.length
        && lower.startsWith(first.toLowerCase() + ' ') && lower.endsWith(' ' + last.toLowerCase())) {
        return {
            first: full.slice(0, first.length),
            middle: full.slice(first.length, full.length - last.length).trim(),
            last: full.slice(full.length - last.length),
        };
    }
    const parts = full.split(' ');
    if (parts.length < 2) return { first: full, middle: '', last: '' };
    return { last: parts.pop(), first: parts.join(' '), middle: '' };
}

// Admin lists and the leaderboard show "Ordonia, Marl June S."
function adminName(row) {
    const { first, middle, last } = splitName(row);
    if (!last) return first;
    return `${last}, ${first}${middle ? ` ${middle[0].toUpperCase()}.` : ''}`;
}

module.exports = { splitName, adminName };
