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

  const timeText = (secs) => (secs < 60 ? `${secs} sec` : `${Math.floor(secs / 60)} min${secs % 60 ? ` ${secs % 60} sec` : ''}`);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  async function load() {
    const list = root.querySelector('.qz-list');
    try {
      const data = await api.get('/admin/quizzes');
      limits = data.limits;
      quizzes = data.quizzes;
      list.innerHTML = quizzes.length ? quizzes.map(q => `
        <div class="admin-list-item is-static">
          <span class="admin-tag ${q.published ? 'is-video' : ''}"><i class="fa-solid fa-stopwatch"></i></span>
          <span class="admin-list-text"><strong>${esc(q.title)}</strong>
            <small>${plural(q.questionCount, 'question')} · ${timeText(q.totalSeconds)} in all · ${q.published ? 'Published' : q.finished ? 'Hidden, only students who finished see their score' : 'Draft, students can\'t see it'}
              · ${q.finished} finished${q.attempts > q.finished ? `, ${q.attempts - q.finished} in progress` : ''} · ${esc(q.by)}</small></span>
          <span class="qz-actions">
            <button type="button" class="tool-btn" data-results="${q.id}"><i class="fa-solid fa-chart-column"></i> Results</button>
            <button type="button" class="tool-btn" data-publish="${q.id}">${q.published ? '<i class="fa-solid fa-eye-slash"></i> Unpublish' : '<i class="fa-solid fa-upload"></i> Publish'}</button>
            <button type="button" class="ce-icon-btn" data-edit="${q.id}" ${q.attempts ? 'disabled title="Students have taken it, so it can\'t be edited"' : 'title="Edit"'} aria-label="Edit quiz"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="ce-icon-btn is-danger" data-delete="${q.id}" title="Delete" aria-label="Delete quiz"><i class="fa-solid fa-trash-can"></i></button>
          </span>
        </div>`).join('') : '<p class="admin-empty">No quizzes yet. Click "New quiz" to make your first one.</p>';
    } catch (err) {
      list.innerHTML = '<p class="admin-empty">Could not load quizzes.</p>';
    }
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

  async function openEditor(id) {
    let quiz = null;
    if (id) {
      try {
        ({ quiz } = await api.get(`/admin/quizzes/${id}`));
      } catch (err) {
        adminToast(err.message, true);
        return;
      }
    }
    const form = formModal({
      title: quiz ? 'Edit quiz' : 'New quiz',
      subtitle: 'Multiple choice. Each question has its own timer; students get one try.',
      submitLabel: 'Save quiz',
      body: `<label class="ce-field"><span>Title</span><input type="text" name="title" maxlength="120" placeholder="Lesson 1 quiz" value="${esc(quiz ? quiz.title : '')}"></label>
        <label class="ce-field"><span>Instructions <small>(optional)</small></span>
          <textarea name="description" rows="2" maxlength="1000" placeholder="Read each question carefully.">${esc(quiz ? quiz.description : '')}</textarea></label>
        <div class="qz-questions">${(quiz ? quiz.questions : [blankQuestion()]).map(questionHtml).join('')}</div>
        <button type="button" class="tool-btn" data-add-q><i class="fa-solid fa-plus"></i> Add question</button>
        <label class="ce-check qz-publish"><input type="checkbox" name="published" ${quiz && quiz.published ? 'checked' : ''}> Publish now (students can take it right away)</label>`,
      onSubmit: async (f) => {
        const body = {
          title: f.elements.title.value,
          description: f.elements.description.value,
          questions: collect(f),
          published: f.elements.published.checked,
        };
        if (quiz) await api.put(`/admin/quizzes/${quiz.id}`, body);
        else await api.post('/admin/quizzes', body);
        adminToast(quiz ? 'Quiz saved' : 'Quiz created');
        load();
        loadAudit();
      },
    });
    form.classList.add('is-wide');
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

  // ---------- Results ----------
  async function openResults(id) {
    let r;
    try {
      r = await api.get(`/admin/quizzes/${id}/results`);
    } catch (err) {
      adminToast(err.message, true);
      return;
    }
    const pct = (n) => (r.finishedCount ? Math.round((n / r.finishedCount) * 100) : 0);
    const form = formModal({
      title: r.title,
      subtitle: `${plural(r.finishedCount, 'student')} finished`,
      submitLabel: 'Done',
      body: r.results.length ? `
        <div class="admin-table-wrap"><table class="admin-table qz-results">
          <thead><tr><th>Student</th><th>Section</th><th>Score</th><th>Status</th><th></th></tr></thead>
          <tbody>${r.results.map(s => `<tr>
            <td><strong>${esc(s.fullName)}</strong></td>
            <td>${esc(s.section || '—')}</td>
            <td>${s.finishedAt ? `<b>${s.score}/${r.total}</b> (${Math.round((s.score / r.total) * 100)}%)` : '—'}</td>
            <td>${s.finishedAt ? `Finished ${esc(new Date(s.finishedAt).toLocaleString())}` : `In progress (question ${s.answered + 1} of ${r.total})`}</td>
            <td><button type="button" class="tool-btn" data-retake="${s.userId}" data-name="${esc(s.fullName)}"><i class="fa-solid fa-rotate-left"></i> Allow retake</button></td>
          </tr>`).join('')}</tbody>
        </table></div>
        <h4 class="qz-subhead">How each question went</h4>
        <ol class="qz-stats">${r.questions.map(q => `<li>
          <span>${esc(q.text)}</span>
          <span class="qz-bar" aria-hidden="true"><span style="width:${pct(q.correct)}%"></span></span>
          <small>${q.correct} of ${r.finishedCount} correct${q.timedOut ? ` · ${q.timedOut} ran out of time` : ''}</small>
        </li>`).join('')}</ol>`
        : '<p class="admin-empty">No one has taken this quiz yet.</p>',
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
    root.innerHTML = `<div class="admin-card">
        <h3><i class="fa-solid fa-stopwatch"></i> Timed quizzes</h3>
        <p class="admin-card-note">Separate from the quiz cards. Each question has its own timer, and every student gets one try. You can't change a quiz's questions after a student has started it.</p>
        <button type="button" class="tool-btn ce-publish" data-new><i class="fa-solid fa-plus"></i> New quiz</button>
        <div class="admin-list qz-list"></div>
      </div>`;

    root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-new')) openEditor(null);
      else if (b.dataset.edit) openEditor(Number(b.dataset.edit));
      else if (b.dataset.results) openResults(Number(b.dataset.results));
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
    load();
  }

  return { mount };
})();
