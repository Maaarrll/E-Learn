// public/js/quiz-import.js
// "Import from file" in the Admin Quizzes tab: reads a teacher's quiz from a
// Word (.docx), PDF or text file in the browser (nothing is uploaded) and
// turns it into questions for the quiz editor. parse() also runs in Node
// (scripts/quiz-import-check.js).
//
// The file just needs this simple pattern:
//   1. Question text            (or Word's automatic 1. 2. 3. numbering)
//   A. choice   B. choice ...   (or Word's automatic A. B. C. lettering)
//   Answer: B                   (or a * before/after the right choice)
//   Time: 30                    (optional, seconds; default 30)

const HCIQuizImport = (function () {
  'use strict';

  const DEFAULT_SECONDS = 30;
  const MAX_CHOICES = 6;
  const MAX_QUESTIONS = 50;
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';

  const SAMPLE = `Quiz: Pagtitipid ng Tubig at Enerhiya

1. Ano ang ibig sabihin ng pagtitipid?
A. Paggamit ng lahat ng tubig
B. Paggamit lamang ng kung ano ang kailangan
C. Pagbili ng maraming gamit
Answer: B
Time: 20

2. Alin ang tamang paraan ng pagtitipid ng tubig?
*A. Patayin ang gripo habang nagsisipilyo
B. Hayaang bukas ang gripo
C. Maligo nang matagal
Time: 15

3. Ano ang SDG #6?
A. Quality Education   B. Clean Water and Sanitation   C. Zero Hunger
Answer: B
`;

  // ---------- Reading the file ----------
  const QUESTION_RE = /^\s*(?:q(?:uestion)?\s*)?(\d{1,3})\s*[.):-]\s*(.*)$/i;
  const CHOICE_RE = /^\s*(\*)?\s*\(?([a-f])\s*[.)]\s*(.*?)\s*(\*)?\s*$/i;
  const ANSWER_RE = /^\s*(?:correct\s+answer|answer|ans|key|sagot|tamang\s+sagot)\s*[:=-]\s*\(?([a-f])\b/i;
  const TIME_RE = /^\s*(?:time|timer|oras|seconds|segundo)\s*[:=-]\s*(\d{1,4})/i;
  const TITLE_RE = /^\s*(?:title|quiz|pamagat)\s*[:-]\s*(.+)$/i;

  // "A. one   B. two   C. three" on a single line -> separate choices
  function splitInlineChoices(line) {
    if (!/^\s*\*?\s*\(?a\s*[.)]/i.test(line)) return [line];
    const parts = line.split(/\s+(?=\*?\s*\(?[b-f]\s*[.)]\s)/i);
    return parts.length > 1 ? parts : [line];
  }

  // Text -> { title, questions: [{ text, choices, answer, seconds }], warnings }
  function parse(text) {
    const questions = [];
    const warnings = [];
    let title = '';
    let q = null;
    let lastChoice = false;   // where a wrapped line belongs
    const intro = [];

    const lines = String(text).replace(/\r/g, '').split('\n').flatMap(splitInlineChoices);
    for (const raw of lines) {
      const line = raw.replace(/\s+/g, ' ').trim();
      if (!line) continue;

      // Word's automatic numbering is marked by readDocx() as "#Q " / "#C "
      const autoQ = line.startsWith('#Q ');
      const autoC = line.startsWith('#C ');
      let m;
      if (autoQ || (!autoC && (m = QUESTION_RE.exec(line)))) {
        q = { text: autoQ ? line.slice(3).trim() : m[2].trim(), choices: [], answer: -1, seconds: DEFAULT_SECONDS };
        questions.push(q);
        lastChoice = false;
        continue;
      }
      if (!q) {
        const t = TITLE_RE.exec(line);
        if (t) title = t[1].trim();
        else intro.push(line);
        continue;
      }
      if ((m = ANSWER_RE.exec(line))) {
        q.answer = m[1].toLowerCase().charCodeAt(0) - 97;
        continue;
      }
      if ((m = TIME_RE.exec(line))) {
        q.seconds = Number(m[1]);
        continue;
      }
      if (autoC) {
        const c = /^(\*)?\s*(.*?)\s*(\*)?$/.exec(line.slice(3).trim());
        if (c[1] || c[3]) q.answer = q.choices.length;
        q.choices.push(c[2]);
        lastChoice = true;
        continue;
      }
      if ((m = CHOICE_RE.exec(line)) && m[3]) {
        const index = m[2].toLowerCase().charCodeAt(0) - 97;
        if (index === q.choices.length) {
          if (m[1] || m[4]) q.answer = index;
          q.choices.push(m[3]);
          lastChoice = true;
          continue;
        }
      }
      // A line that wrapped: glue it to the question or the last choice
      if (lastChoice) q.choices[q.choices.length - 1] += ` ${line}`;
      else q.text += ` ${line}`;
    }

    if (!title && intro.length) title = intro[0];

    questions.forEach((x, i) => {
      const n = `Question ${i + 1}`;
      x.text = x.text.trim();
      if (!x.text) warnings.push(`${n} has no question text.`);
      if (x.choices.length > MAX_CHOICES) {
        warnings.push(`${n} had ${x.choices.length} choices; only the first ${MAX_CHOICES} were kept.`);
        x.choices = x.choices.slice(0, MAX_CHOICES);
        if (x.answer >= MAX_CHOICES) x.answer = -1;
      }
      if (x.choices.length < 2) warnings.push(`${n} has fewer than 2 choices.`);
      if (x.answer < 0 || x.answer >= x.choices.length) {
        x.answer = -1;
        warnings.push(`${n} has no correct answer marked.`);
      }
      x.seconds = Math.min(600, Math.max(5, x.seconds));
    });
    if (questions.length > MAX_QUESTIONS) {
      warnings.push(`The file has ${questions.length} questions; only the first ${MAX_QUESTIONS} were kept.`);
      questions.length = MAX_QUESTIONS;
    }
    return { title: title.slice(0, 120), questions, warnings };
  }

  // ---------- Word (.docx) ----------
  // A .docx is a zip file; read the few parts we need with the browser's own unzip
  async function unzip(buffer, wanted) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error('This does not look like a Word (.docx) file.');
    const files = {};
    let p = view.getUint32(end + 16, true);
    for (let n = view.getUint16(end + 10, true); n > 0; n--) {
      const method = view.getUint16(p + 10, true);
      const size = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const skip = nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
      const local = view.getUint32(p + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      if (wanted.includes(name)) {
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const data = bytes.subarray(start, start + size);
        files[name] = method === 0
          ? new TextDecoder().decode(data)
          : await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
      }
      p += 46 + skip;
    }
    return files;
  }

  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const wAttr = (el, name) => (el ? el.getAttributeNS(W, name) || el.getAttribute(`w:${name}`) : null);
  const wFirst = (el, tag) => (el ? el.getElementsByTagNameNS(W, tag)[0] : null);

  async function readDocx(file) {
    const parts = await unzip(await file.arrayBuffer(), ['word/document.xml', 'word/numbering.xml']);
    if (!parts['word/document.xml']) throw new Error('Could not find the text inside this Word file.');
    const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');

    // Which automatic numbering is letters (choices) and which is numbers (questions)
    const formats = {};
    if (parts['word/numbering.xml']) {
      const numbering = xml(parts['word/numbering.xml']);
      const abstract = {};
      for (const a of numbering.getElementsByTagNameNS(W, 'abstractNum')) {
        abstract[wAttr(a, 'abstractNumId')] = [...a.getElementsByTagNameNS(W, 'lvl')]
          .reduce((map, lvl) => ({ ...map, [wAttr(lvl, 'ilvl')]: wAttr(wFirst(lvl, 'numFmt'), 'val') }), {});
      }
      for (const num of numbering.getElementsByTagNameNS(W, 'num')) {
        formats[wAttr(num, 'numId')] = abstract[wAttr(wFirst(num, 'abstractNumId'), 'val')] || {};
      }
    }

    const doc = xml(parts['word/document.xml']);
    return [...doc.getElementsByTagNameNS(W, 'p')].map(par => {
      let text = '';
      for (const el of par.getElementsByTagNameNS(W, '*')) {
        if (el.localName === 't') text += el.textContent;
        else if (el.localName === 'tab') text += ' ';
        else if (el.localName === 'br') text += '\n';
      }
      const numPr = wFirst(par, 'numPr');
      if (numPr && text.trim()) {
        const level = wAttr(wFirst(numPr, 'ilvl'), 'val') || '0';
        const fmt = (formats[wAttr(wFirst(numPr, 'numId'), 'val')] || {})[level] || '';
        if (/letter/i.test(fmt)) return `#C ${text}`;
        if (/decimal|roman/i.test(fmt) || level === '0') return `#Q ${text}`;
        return `#C ${text}`;
      }
      return text;
    }).join('\n');
  }

  // ---------- PDF (pdf.js is only loaded when a PDF is picked) ----------
  let pdfjsReady = null;
  function loadPdfJs() {
    if (!pdfjsReady) {
      pdfjsReady = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = `${PDFJS}pdf.min.js`;
        s.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.js`;
          resolve(window.pdfjsLib);
        };
        s.onerror = () => { pdfjsReady = null; reject(new Error('Could not load the PDF reader. Check your internet connection.')); };
        document.head.appendChild(s);
      });
    }
    return pdfjsReady;
  }

  async function readPdf(file) {
    const pdfjs = await loadPdfJs();
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const { items } = await (await pdf.getPage(i)).getTextContent();
      text += items.map(it => it.str + (it.hasEOL ? '\n' : '')).join('') + '\n';
    }
    if (!text.trim()) throw new Error('This PDF has no text to read (it may be a scanned picture). Try the Word or text version.');
    return text;
  }

  // File -> parse() result
  async function readFile(file) {
    const name = file.name.toLowerCase();
    let text;
    if (name.endsWith('.docx')) text = await readDocx(file);
    else if (name.endsWith('.pdf')) text = await readPdf(file);
    else if (name.endsWith('.txt')) text = await file.text();
    else if (name.endsWith('.doc')) throw new Error('Old .doc files can\'t be read. In Word, use "Save As" and pick .docx.');
    else throw new Error('Please choose a Word (.docx), PDF or text (.txt) file.');
    return parse(text);
  }

  function downloadSample() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([SAMPLE], { type: 'text/plain' }));
    a.download = 'quiz-sample.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return { parse, readFile, downloadSample, SAMPLE };
})();

if (typeof module !== 'undefined') module.exports = HCIQuizImport;
