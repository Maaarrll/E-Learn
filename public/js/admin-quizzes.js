// public/js/admin-quizzes.js
// "Quizzes" tab of the Admin Dashboard: make timed multiple-choice quizzes
// (separate from the quiz cards) and see the scores. Needs js/api.js and
// js/richtext.js, plus formModal, adminToast and loadAudit from Admin.html.

const HCIQuizAdmin = (function () {
  'use strict';

  const esc = (t) => HCIRichText.escapeHtml(t == null ? '' : String(t));
  let root = null;
  let quizzes = [];
  let limits = { questions: 50, minChoices: 2, maxChoices: 6, minSeconds: 5, maxSeconds: 600 };
  let radioGroup = 0;   // unique radio names so each question has its own "correct" pick
  const openScores = new Set();   // quiz ids whose score list is expanded (kept across reloads)

  const timeText = (secs) => (secs < 60 ? `${secs} sec` : `${Math.floor(secs / 60)} min${secs % 60 ? ` ${secs % 60} sec` : ''}`);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // Time frame: <input type="datetime-local"> works in the teacher's own time zone
  const pad = (n) => String(n).padStart(2, '0');
  const toLocalInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
  const when = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const windowFields = (q) => `<div class="qz-window">
      <label class="ce-field"><span>Opens <small>(optional)</small></span><input type="datetime-local" name="opensAt" value="${toLocalInput(q && q.opensAt)}"></label>
      <label class="ce-field"><span>Deadline <small>(optional)</small></span><input type="datetime-local" name="closesAt" value="${toLocalInput(q && q.closesAt)}"></label>
    </div>
    <small class="qz-window-hint">Students can only take the quiz between these times. Anyone who hasn't taken it by the deadline gets 0. Leave empty for no limit.</small>`;
  // Who can take it: everyone, or only some sections
  let audience = { sections: [], canTargetEveryone: false, mySections: [] };
  function audienceFields(q) {
    const picked = q && q.sections;
    const choices = audience.canTargetEveryone ? audience.sections : audience.mySections;
    const checked = (sec) => (picked ? picked.includes(sec) : !audience.canTargetEveryone);
    return `<fieldset class="ce-field qz-audience">
      <legend>Who can take it</legend>
      ${audience.canTargetEveryone ? `
        <label class="ce-check"><input type="radio" name="audienceMode" value="all" ${picked ? '' : 'checked'}> Every section</label>
        <label class="ce-check"><input type="radio" name="audienceMode" value="some" ${picked ? 'checked' : ''}> Only these sections:</label>`
        : '<small>Your sections (untick one to leave it out):</small>'}
      <div class="ce-checks">${choices.map(sec => `
        <label class="ce-check"><input type="checkbox" name="audienceSection" value="${esc(sec)}" ${checked(sec) ? 'checked' : ''}> ${esc(sec)}</label>`).join('')
        || '<small>No sections yet. They appear when students sign up.</small>'}</div>
    </fieldset>`;
  }
  // -> null (every section) or a list of section names
  function pickedSections(form) {
    const mode = form.querySelector('input[name="audienceMode"]:checked');
    if (mode && mode.value === 'all') return null;
    const list = [...form.querySelectorAll('input[name="audienceSection"]:checked')].map(c => c.value);
    if (!list.length) throw new Error('Pick at least one section that can take the quiz.');
    return list;
  }
  // Ticking a section switches to "Only these sections"
  function wireAudience(form) {
    form.addEventListener('change', (e) => {
      if (e.target.name !== 'audienceSection' || !e.target.checked) return;
      const some = form.querySelector('input[name="audienceMode"][value="some"]');
      if (some) some.checked = true;
    });
  }
  const audienceText = (q) => (q.sections ? `For: ${q.sections.join(', ')}` : 'For: every section');

  const windowText = (q) => {
    if (q.window === 'upcoming') return `Opens ${when(q.opensAt)}${q.closesAt ? `, due ${when(q.closesAt)}` : ''}`;
    if (q.window === 'closed') return `Closed ${when(q.closesAt)}`;
    return q.closesAt ? `Due ${when(q.closesAt)}` : 'No deadline';
  };

  // ---------- Quiz cards ----------
  let filter = 'all';
  let section = '';     // '' = all sections
  const sectionQuery = () => (section ? `?section=${encodeURIComponent(section)}` : '');
  const statusOf = (q) => (q.published ? q.window : q.finished ? 'hidden' : 'draft');
  const STATUS = {
    draft:    { label: 'Draft', icon: 'fa-pen-ruler', tip: "Students can't see it yet" },
    hidden:   { label: 'Hidden', icon: 'fa-eye-slash', tip: 'Only students who finished see their score' },
    upcoming: { label: 'Upcoming', icon: 'fa-hourglass-start', tip: 'Published, not open yet' },
    open:     { label: 'Open', icon: 'fa-circle-play', tip: 'Students can take it now' },
    closed:   { label: 'Closed', icon: 'fa-lock', tip: 'The deadline has passed' },
  };
  const FILTERS = [['all', 'All'], ['open', 'Open'], ['upcoming', 'Upcoming'], ['closed', 'Closed'], ['draft', 'Drafts']];
  const inFilter = (q, f) => f === 'all' || (f === 'draft' ? !q.published : q.published && q.window === f);

  async function load() {
    try {
      const data = await api.get(`/admin/quizzes${sectionQuery()}`);
      limits = data.limits;
      quizzes = data.quizzes;
      audience = { sections: data.sections, canTargetEveryone: data.canTargetEveryone, mySections: data.mySections };
      const pick = root.querySelector('[data-section-filter]');
      if (section && !data.sections.includes(section)) data.sections.push(section);
      pick.innerHTML = `<option value="">All sections</option>${data.sections.map(sec =>
        `<option value="${esc(sec)}" ${sec === section ? 'selected' : ''}>${esc(sec)}</option>`).join('')}`;
      pick.closest('.qz-section').hidden = data.sections.length < 2 && !section;
      render();
    } catch (err) {
      root.querySelector('.qz-list').innerHTML = '<p class="admin-empty">Could not load quizzes.</p>';
    }
  }

  function card(q) {
    const st = statusOf(q);
    const closed = q.published && q.window === 'closed';
    const locked = q.attempts > 0;
    return `<article class="qz-card is-${st}">
      <div class="qz-card-top">
        <span class="qz-card-icon"><i class="fa-solid fa-stopwatch"></i></span>
        <div class="qz-card-title">
          <h4>${esc(q.title)}</h4>
          <small>${plural(q.questionCount, 'question')} · ${timeText(q.totalSeconds)} in all · by ${esc(q.by)}</small>
        </div>
        <span class="qz-chip is-${st}" title="${esc(STATUS[st].tip)}"><i class="fa-solid ${STATUS[st].icon}"></i> ${STATUS[st].label}</span>
      </div>
      <p class="qz-card-when is-${q.window}"><i class="fa-regular fa-calendar"></i> ${esc(windowText(q))}</p>
      <p class="qz-card-for"><i class="fa-solid fa-users"></i> ${esc(audienceText(q))}</p>
      <div class="qz-numbers">
        <span><b>${q.finished}</b><small>finished</small></span>
        <span><b>${q.averagePct === null ? '—' : `${q.averagePct}%`}</b><small>class average</small></span>
        ${closed
          ? `<span class="${q.missed ? 'is-bad' : ''}"><b>${q.missed}</b><small>missed</small></span>`
          : `<span><b>${q.notTaken}</b><small>not taken yet</small></span>`}
        ${q.inProgress ? `<span class="is-live"><b>${q.inProgress}</b><small>answering now</small></span>` : ''}
      </div>
      <div class="qz-card-actions">
        ${q.published ? '' : `<button type="button" class="tool-btn ce-publish" data-publish="${q.id}"><i class="fa-solid fa-upload"></i> Publish</button>`}
        <button type="button" class="tool-btn" data-scores="${q.id}" aria-expanded="${openScores.has(q.id)}" aria-controls="qz-scores-${q.id}">
          <i class="fa-solid fa-chevron-${openScores.has(q.id) ? 'up' : 'down'}"></i> Scores</button>
        <button type="button" class="tool-btn" data-results="${q.id}"><i class="fa-solid fa-chart-column"></i> Results</button>
        <details class="qz-more">
          <summary class="tool-btn" aria-label="More actions for ${esc(q.title)}"><i class="fa-solid fa-ellipsis"></i> More</summary>
          <div class="qz-menu">
            <button type="button" data-edit="${q.id}" ${locked ? 'disabled' : ''}><i class="fa-solid fa-pen"></i>
              <span>Edit questions${locked ? '<small>Locked: students have started it</small>' : ''}</span></button>
            <button type="button" data-schedule="${q.id}"><i class="fa-solid fa-calendar-days"></i> <span>Change time frame &amp; sections</span></button>
            ${q.published ? `<button type="button" data-publish="${q.id}"><i class="fa-solid fa-eye-slash"></i> <span>Unpublish (hide from students)</span></button>` : ''}
            <button type="button" class="is-danger" data-delete="${q.id}"><i class="fa-solid fa-trash-can"></i> <span>Delete quiz</span></button>
          </div>
        </details>
      </div>
      <div class="qz-scores" id="qz-scores-${q.id}" ${openScores.has(q.id) ? '' : 'hidden'}></div>
    </article>`;
  }

  function render() {
    root.querySelector('.qz-filters').innerHTML = FILTERS.map(([f, label]) => {
      const n = quizzes.filter(q => inFilter(q, f)).length;
      return `<button type="button" class="qz-filter ${filter === f ? 'is-on' : ''}" data-filter="${f}" aria-pressed="${filter === f}">${label} <span>${n}</span></button>`;
    }).join('');
    root.querySelector('.qz-filter-bar').hidden = !quizzes.length;

    const shown = quizzes.filter(q => inFilter(q, filter));
    root.querySelector('.qz-list').innerHTML = !quizzes.length
      ? `<div class="qz-empty">
          <div class="qz-empty-icon"><i class="fa-solid fa-stopwatch"></i></div>
          <h4>Make your first quiz</h4>
          <ol>
            <li><b>New quiz</b>: type the questions and pick the right answers.</li>
            <li><b>Import from file</b>: upload a Word, PDF or text file you already have.</li>
            <li>Set a deadline if you like, then <b>Publish</b> so students can take it.</li>
          </ol>
        </div>`
      : shown.length ? shown.map(card).join('') : '<p class="admin-empty">No quizzes here.</p>';
    openScores.forEach(id => { if (quizzes.some(q => q.id === id)) loadScores(id); else openScores.delete(id); });
  }

  // ---------- Editor ----------
  const blankQuestion = () => ({ text: '', choices: ['', '', '', ''], answer: 0, seconds: 30 });

  function choiceHtml(text, correct, group) {
    return `<div class="qz-choice">
      <label class="qz-correct" title="Mark as the correct answer"><input type="radio" name="${group}" ${correct ? 'checked' : ''} aria-label="Correct answer"></label>
      <input type="text" name="choice" maxlength="200" value="${esc(text)}" placeholder="Choice" aria-label="Choice">
      <button type="button" class="ce-icon-btn" data-remove-choice aria-label="Remove choice"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
  }

  function questionHtml(q) {
    const group = `qz-correct-${++radioGroup}`;
    return `<fieldset class="qz-question" data-q data-group="${group}">
      <div class="qz-question-head">
        <b>Question <span data-num></span></b>
        <label class="qz-seconds"><i class="fa-solid fa-stopwatch"></i>
          <input type="number" name="seconds" min="${limits.minSeconds}" max="${limits.maxSeconds}" value="${q.seconds}" aria-label="Seconds for this question"> sec</label>
        <button type="button" class="ce-icon-btn is-danger" data-remove-q aria-label="Remove question"><i class="fa-solid fa-trash-can"></i></button>
      </div>
      <textarea name="text" rows="2" maxlength="500" placeholder="Type the question" aria-label="Question">${esc(q.text)}</textarea>
      <small class="qz-hint">Tick the circle next to the correct answer.</small>
      <div class="qz-choices">${q.choices.map((c, i) => choiceHtml(c, i === q.answer, group)).join('')}</div>
      <button type="button" class="tool-btn qz-add-choice" data-add-choice><i class="fa-solid fa-plus"></i> Add choice</button>
    </fieldset>`;
  }

  function renumber(form) {
    form.querySelectorAll('[data-q]').forEach((q, i) => { q.querySelector('[data-num]').textContent = i + 1; });
  }

  function collect(form) {
    return [...form.querySelectorAll('[data-q]')].map(q => {
      const choices = [...q.querySelectorAll('.qz-choice')];
      return {
        text: q.querySelector('[name="text"]').value,
        seconds: Number(q.querySelector('[name="seconds"]').value),
        choices: choices.map(c => c.querySelector('[name="choice"]').value),
        answer: choices.findIndex(c => c.querySelector('input[type="radio"]').checked),
      };
    });
  }

  // imported = parsed file from js/quiz-import.js; it opens as a new quiz to check before saving
  async function openEditor(id, imported = null) {
    let quiz = null;
    if (id) {
      try {
        ({ quiz } = await api.get(`/admin/quizzes/${id}`));
      } catch (err) {
        adminToast(err.message, true);
        return;
      }
    }
    const start = quiz || imported;
    const report = imported ? `<div class="qz-import-report ${imported.warnings.length ? 'has-warnings' : ''}" role="status">
        <strong><i class="fa-solid fa-file-import"></i> Found ${plural(imported.questions.length, 'question')} in ${esc(imported.fileName)}.</strong>
        ${imported.warnings.length
          ? `<span>Please fix these before saving:</span><ul>${imported.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`
          : '<span>Check the questions, answers and timers below, then save.</span>'}
      </div>` : '';
    const form = formModal({
      title: quiz ? 'Edit quiz' : imported ? 'Check imported quiz' : 'New quiz',
      subtitle: 'Multiple choice. Each question has its own timer; students get one try.',
      submitLabel: 'Save quiz',
      body: `${report}<label class="ce-field"><span>Title</span><input type="text" name="title" maxlength="120" placeholder="Lesson 1 quiz" value="${esc(start ? start.title : '')}"></label>
        <label class="ce-field"><span>Instructions <small>(optional)</small></span>
          <textarea name="description" rows="2" maxlength="1000" placeholder="Read each question carefully.">${esc(quiz ? quiz.description : '')}</textarea></label>
        <div class="qz-questions">${(start ? start.questions : [blankQuestion()]).map(questionHtml).join('')}</div>
        <button type="button" class="tool-btn" data-add-q><i class="fa-solid fa-plus"></i> Add question</button>
        ${audienceFields(quiz)}
        ${windowFields(quiz)}
        <label class="ce-check qz-publish"><input type="checkbox" name="published" ${quiz && quiz.published ? 'checked' : ''}> Publish now (students can take it right away)</label>`,
      onSubmit: async (f) => {
        const body = {
          title: f.elements.title.value,
          description: f.elements.description.value,
          questions: collect(f),
          published: f.elements.published.checked,
          opensAt: fromLocalInput(f.elements.opensAt.value),
          closesAt: fromLocalInput(f.elements.closesAt.value),
          sections: pickedSections(f),
        };
        if (quiz) await api.put(`/admin/quizzes/${quiz.id}`, body);
        else await api.post('/admin/quizzes', body);
        adminToast(quiz ? 'Quiz saved' : 'Quiz created');
        load();
        loadAudit();
      },
    });
    form.classList.add('is-wide');
    wireAudience(form);
    renumber(form);

    form.addEventListener('click', (e) => {
      const list = form.querySelector('.qz-questions');
      if (e.target.closest('[data-add-q]')) {
        if (list.children.length >= limits.questions) return adminToast(`A quiz can have up to ${limits.questions} questions.`, true);
        list.insertAdjacentHTML('beforeend', questionHtml(blankQuestion()));
        renumber(form);
        list.lastElementChild.querySelector('textarea').focus();
      } else if (e.target.closest('[data-remove-q]')) {
        if (list.children.length === 1) return adminToast('A quiz needs at least one question.', true);
        e.target.closest('[data-q]').remove();
        renumber(form);
      } else if (e.target.closest('[data-add-choice]')) {
        const q = e.target.closest('[data-q]');
        const box = q.querySelector('.qz-choices');
        if (box.children.length >= limits.maxChoices) return adminToast(`Up to ${limits.maxChoices} choices per question.`, true);
        box.insertAdjacentHTML('beforeend', choiceHtml('', false, q.dataset.group));
        box.lastElementChild.querySelector('[name="choice"]').focus();
      } else if (e.target.closest('[data-remove-choice]')) {
        const box = e.target.closest('.qz-choices');
        if (box.children.length <= limits.minChoices) return adminToast(`A question needs at least ${limits.minChoices} choices.`, true);
        e.target.closest('.qz-choice').remove();
      }
    });
  }

  // ---------- Scores under each quiz (who took it, score, date and time) ----------
  const day = (d) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const clock = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  function takenText(s) {
    const start = new Date(s.startedAt);
    if (!s.finishedAt) return `${day(start)} · started ${clock(start)} (still answering)`;
    const end = new Date(s.finishedAt);
    return start.toDateString() === end.toDateString()
      ? `${day(start)} · ${clock(start)} – ${clock(end)}`
      : `${day(start)} ${clock(start)} – ${day(end)} ${clock(end)}`;
  }

  async function loadScores(id) {
    const box = root.querySelector(`#qz-scores-${id}`);
    if (!box) return;
    box.innerHTML = '<p class="admin-empty"><span class="btn-spinner"></span> Loading scores...</p>';
    try {
      const r = await api.get(`/admin/quizzes/${id}/results${sectionQuery()}`);
      const finished = r.results.filter(s => s.finishedAt);
      const avg = finished.length ? finished.reduce((sum, s) => sum + s.score, 0) / finished.length : 0;
      const rows = [
        ...r.results.map(s => `<tr>
          <td><strong>${esc(s.fullName)}</strong><small>${esc(s.section || '')}</small></td>
          <td>${s.finishedAt ? `<b class="qz-score ${s.score / r.total >= 0.75 ? 'is-high' : s.score / r.total >= 0.5 ? 'is-mid' : 'is-low'}">${s.score}/${r.total}</b>` : '<span class="qz-score">—</span>'}</td>
          <td>${esc(takenText(s))}</td>
        </tr>`),
        ...r.missed.map(s => `<tr class="qz-missed">
          <td><strong>${esc(s.fullName)}</strong><small>${esc(s.section || '')}</small></td>
          <td><b class="qz-score is-low">0/${r.total}</b></td>
          <td>Missed (deadline ${esc(day(new Date(r.closesAt)))} · ${esc(clock(new Date(r.closesAt)))})</td>
        </tr>`),
      ];
      box.innerHTML = rows.length ? `
        <p class="qz-scores-sum">${plural(finished.length, 'student')} finished${finished.length ? ` · class average <b>${avg.toFixed(1)}/${r.total}</b> (${Math.round((avg / r.total) * 100)}%)` : ''}${r.missed.length ? ` · ${r.missed.length} missed` : ''}${!r.closed && r.notTakenCount ? ` · ${r.notTakenCount} not taken yet` : ''}</p>
        <div class="admin-table-wrap"><table class="admin-table qz-scores-table">
          <thead><tr><th>Student</th><th>Score</th><th>Taken on</th></tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table></div>`
        : `<p class="admin-empty">No one has taken this quiz yet.${r.notTakenCount ? ` ${plural(r.notTakenCount, 'student')} still to take it.` : ''}</p>`;
    } catch (err) {
      box.innerHTML = `<p class="admin-empty">${esc(err.message)}</p>`;
    }
  }

  function toggleScores(btn) {
    const id = Number(btn.dataset.scores);
    const open = !openScores.has(id);
    if (open) openScores.add(id); else openScores.delete(id);
    btn.setAttribute('aria-expanded', String(open));
    btn.querySelector('i').className = `fa-solid fa-chevron-${open ? 'up' : 'down'}`;
    root.querySelector(`#qz-scores-${id}`).hidden = !open;
    if (open) loadScores(id);
  }

  // ---------- Results ----------
  async function openResults(id) {
    let r;
    try {
      r = await api.get(`/admin/quizzes/${id}/results${sectionQuery()}`);
    } catch (err) {
      adminToast(err.message, true);
      return;
    }
    const pct = (n) => (r.finishedCount ? Math.round((n / r.finishedCount) * 100) : 0);
    const form = formModal({
      title: r.title,
      subtitle: `${plural(r.finishedCount, 'student')} finished${r.closed ? ` · ${r.missed.length} missed the deadline` : r.notTakenCount ? ` · ${r.notTakenCount} not taken yet` : ''}`,
      submitLabel: 'Done',
      body: r.results.length || r.missed.length ? `
        <div class="admin-table-wrap"><table class="admin-table qz-results">
          <thead><tr><th>Student</th><th>Section</th><th>Score</th><th>Status</th><th></th></tr></thead>
          <tbody>${r.results.map(s => `<tr>
            <td><strong>${esc(s.fullName)}</strong></td>
            <td>${esc(s.section || '—')}</td>
            <td>${s.finishedAt ? `<b>${s.score}/${r.total}</b> (${Math.round((s.score / r.total) * 100)}%)` : '—'}</td>
            <td>${s.finishedAt ? `Finished ${esc(new Date(s.finishedAt).toLocaleString())}` : `In progress (question ${s.answered + 1} of ${r.total})`}</td>
            <td><button type="button" class="tool-btn" data-retake="${s.userId}" data-name="${esc(s.fullName)}"><i class="fa-solid fa-rotate-left"></i> Allow retake</button></td>
          </tr>`).join('')}${r.missed.map(s => `<tr class="qz-missed">
            <td><strong>${esc(s.fullName)}</strong></td>
            <td>${esc(s.section || '—')}</td>
            <td><b>0/${r.total}</b> (0%)</td>
            <td>Missed: didn't take it before the deadline</td>
            <td></td>
          </tr>`).join('')}</tbody>
        </table></div>
        <h4 class="qz-subhead">How each question went</h4>
        <ol class="qz-stats">${r.questions.map(q => `<li>
          <span>${esc(q.text)}</span>
          <span class="qz-bar" aria-hidden="true"><span style="width:${pct(q.correct)}%"></span></span>
          <small>${q.correct} of ${r.finishedCount} correct${q.timedOut ? ` · ${q.timedOut} ran out of time` : ''}</small>
        </li>`).join('')}</ol>`
        : `<p class="admin-empty">No one has taken this quiz yet.${r.closesAt ? ` Students who haven't taken it by ${esc(when(r.closesAt))} will get 0.` : ''}</p>`,
      onSubmit: async () => {},
    });
    form.classList.add('is-wide');
    form.querySelector('.ce-modal-foot .tool-btn[data-close]').hidden = true; // "Done" is enough here
    form.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-retake]');
      if (!btn) return;
      confirmDialog({
        title: 'Allow a retake?',
        message: `${btn.dataset.name}'s answers and score for this quiz will be deleted so they can take it again.`,
        confirmText: 'Allow retake', icon: 'fa-rotate-left', danger: true,
        onConfirm: async () => {
          try {
            await api.del(`/admin/quizzes/${id}/attempts/${btn.dataset.retake}`);
            btn.closest('tr').remove();
            adminToast(`${btn.dataset.name} can take the quiz again.`);
            load();
            loadAudit();
          } catch (err) {
            adminToast(err.message, true);
          }
        },
      });
    });
  }

  function mount(el) {
    root = el;
    root.innerHTML = `<div class="qz-toolbar">
        <div class="qz-create">
          <button type="button" class="tool-btn ce-publish" data-new><i class="fa-solid fa-plus"></i> New quiz</button>
          <button type="button" class="tool-btn" data-import><i class="fa-solid fa-file-import"></i> Import from file</button>
          <input type="file" accept=".docx,.pdf,.txt" hidden data-import-file>
        </div>
        <details class="qz-help">
          <summary><i class="fa-regular fa-circle-question"></i> How should an import file look?</summary>
          <p>Number the questions, letter the choices, and mark the right answer with <b>Answer: B</b> or a <b>*</b>.
            <b>Time: 20</b> sets the seconds for a question (30 if left out). Word, PDF or text files all work.</p>
          <pre>${esc(HCIQuizImport.SAMPLE)}</pre>
          <button type="button" class="tool-btn" data-sample><i class="fa-solid fa-download"></i> Download this sample</button>
        </details>
      </div>
      <p class="qz-rules"><i class="fa-solid fa-circle-info"></i> Separate from the quiz cards. Every question has its own timer, students get one try,
        and the questions can't change once a student has started.</p>
      <div class="qz-filter-bar" hidden>
        <div class="qz-filters" role="group" aria-label="Show quizzes"></div>
        <label class="qz-section" hidden><i class="fa-solid fa-users"></i>
          <select data-section-filter aria-label="Show scores for one section"></select></label>
      </div>
      <div class="qz-list"></div>`;

    document.addEventListener('click', (e) => {
      root.querySelectorAll('.qz-more[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; });
    });
    root.addEventListener('keydown', (e) => {
      const menu = e.target.closest('.qz-more[open]');
      if (e.key === 'Escape' && menu) { menu.open = false; menu.querySelector('summary').focus(); }
    });

    root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const menu = b.closest('.qz-more');
      if (menu) menu.open = false;
      if (b.dataset.filter) {
        filter = b.dataset.filter;
        return render();
      }
      if (b.hasAttribute('data-new')) openEditor(null);
      else if (b.hasAttribute('data-import')) root.querySelector('[data-import-file]').click();
      else if (b.hasAttribute('data-sample')) HCIQuizImport.downloadSample();
      else if (b.dataset.edit) openEditor(Number(b.dataset.edit));
      else if (b.dataset.scores) toggleScores(b);
      else if (b.dataset.results) openResults(Number(b.dataset.results));
      else if (b.dataset.schedule) openSchedule(quizzes.find(x => x.id === Number(b.dataset.schedule)));
      else if (b.dataset.publish) {
        const q = quizzes.find(x => x.id === Number(b.dataset.publish));
        api.put(`/admin/quizzes/${q.id}/publish`, { published: !q.published })
          .then(() => { adminToast(q.published ? 'Quiz hidden from students' : 'Quiz published'); load(); loadAudit(); })
          .catch(err => adminToast(err.message, true));
      } else if (b.dataset.delete) {
        const q = quizzes.find(x => x.id === Number(b.dataset.delete));
        confirmDialog({
          title: 'Delete this quiz?',
          message: `"${q.title}" and all of its scores will be deleted. This cannot be undone.`,
          confirmText: 'Delete', icon: 'fa-trash-can', danger: true,
          onConfirm: async () => {
            try { await api.del(`/admin/quizzes/${q.id}`); adminToast('Quiz deleted'); } catch (err) { adminToast(err.message, true); }
            load();
            loadAudit();
          },
        });
      }
    });
    // Section filter: the numbers, Scores and Results then count only that section
    root.querySelector('[data-section-filter]').addEventListener('change', (e) => {
      section = e.target.value;
      load();
    });

    root.querySelector('[data-import-file]').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';      // picking the same file again still works
      if (file) importFile(file);
    });
    load();
  }

  // Change the time frame and sections anytime, e.g. to give more time or add a section
  function openSchedule(q) {
    const form = formModal({
      title: 'Time frame & sections',
      subtitle: q.title,
      submitLabel: 'Save',
      body: audienceFields(q) + windowFields(q),
      onSubmit: async (f) => {
        await api.put(`/admin/quizzes/${q.id}/schedule`, {
          opensAt: fromLocalInput(f.elements.opensAt.value),
          closesAt: fromLocalInput(f.elements.closesAt.value),
          sections: pickedSections(f),
        });
        adminToast('Saved');
        load();
        loadAudit();
      },
    });
    wireAudience(form);
  }

  async function importFile(file) {
    const btn = root.querySelector('[data-import]');
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-spinner"></span> Reading file...';
    try {
      const result = await HCIQuizImport.readFile(file);
      if (!result.questions.length) {
        throw new Error('No questions were found. Make sure the file is written like the sample (1. question, A. choice, Answer: A).');
      }
      result.questions.forEach(q => {
        while (q.choices.length < 2) q.choices.push('');   // room to type the missing choices
      });
      openEditor(null, { ...result, fileName: file.name });
    } catch (err) {
      adminToast(err.message, true);
    }
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-file-import"></i> Import from file';
  }

  return { mount };
})();
