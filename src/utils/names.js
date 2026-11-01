// src/utils/names.js

// Admin lists show "Ordonia, Marl June S.". full_name is "First Middle Last";
// first_name/last_name are saved at signup, so the middle is what sits between.
// If a rename made them stop matching, fall back to the last word as the surname.
function adminName({ full_name, first_name, last_name }) {
    const clean = (v) => String(v || '').trim().replace(/\s+/g, ' ');
    const full = clean(full_name);
    let first = clean(first_name);
    let last = clean(last_name);
    let middle = '';
    const lower = full.toLowerCase();
    if (first && last && full.length > first.length + last.length
        && lower.startsWith(first.toLowerCase() + ' ') && lower.endsWith(' ' + last.toLowerCase())) {
        middle = full.slice(first.length, full.length - last.length).trim();
        first = full.slice(0, first.length);
        last = full.slice(full.length - last.length);
    } else {
        const parts = full.split(' ');
        if (parts.length < 2) return full;
        last = parts.pop();
        first = parts.join(' ');
    }
    return `${last}, ${first}${middle ? ` ${middle[0].toUpperCase()}.` : ''}`;
}

module.exports = { adminName };
