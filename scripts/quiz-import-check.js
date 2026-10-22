// scripts/quiz-import-check.js
// Self-check for the quiz file reader (public/js/quiz-import.js):
//   node scripts/quiz-import-check.js
const assert = require('assert');
const { parse, SAMPLE } = require('../public/js/quiz-import');

// The sample teachers download must import cleanly
let r = parse(SAMPLE);
assert.strictEqual(r.title, 'Pagtitipid ng Tubig at Enerhiya');
assert.strictEqual(r.questions.length, 3);
assert.deepStrictEqual(r.warnings, []);
assert.deepStrictEqual(r.questions[0], {
  text: 'Ano ang ibig sabihin ng pagtitipid?',
  choices: ['Paggamit ng lahat ng tubig', 'Paggamit lamang ng kung ano ang kailangan', 'Pagbili ng maraming gamit'],
  answer: 1,
  seconds: 20,
});
assert.strictEqual(r.questions[1].answer, 0, '* before a choice marks it correct');
assert.deepStrictEqual(r.questions[2].choices, ['Quality Education', 'Clean Water and Sanitation', 'Zero Hunger'], 'choices on one line');
assert.strictEqual(r.questions[2].seconds, 30, 'default time');

// Wrapped lines, "a)" choices, * after the choice, Filipino answer key
r = parse(`1) Which of these
is a value?
a) Honesty *
b) Laziness
2. Pick one
A. One
B. Two
Sagot: b`);
assert.strictEqual(r.questions[0].text, 'Which of these is a value?');
assert.strictEqual(r.questions[0].answer, 0);
assert.strictEqual(r.questions[1].answer, 1);

// Missing answer and too few choices are reported, not guessed
r = parse('1. Lonely question\nA. Only choice');
assert.strictEqual(r.questions[0].answer, -1);
assert.deepStrictEqual(r.warnings, ['Question 1 has fewer than 2 choices.', 'Question 1 has no correct answer marked.']);

// Word's automatic numbering (marked by readDocx as #Q / #C)
r = parse('#Q Ano ang pamilya?\n#C Isang grupo *\n#C Isang lugar\nTime: 999');
assert.deepStrictEqual(r.questions[0], { text: 'Ano ang pamilya?', choices: ['Isang grupo', 'Isang lugar'], answer: 0, seconds: 600 });

console.log('quiz-import: all checks passed');
