// public/js/admin-tour.js
// Guided tour of the Admin Dashboard: highlights each part of the page with a
// short explanation (Back / Next / Skip). Starts by itself on a teacher's first
// visit and from the "Tour" button. Steps on tabs the teacher can't open
// (Content and Instructors for plain instructors) are left out.

const HCIAdminTour = (function () {
  'use strict';

  const SEEN_KEY = 'allearn-admin-tour-seen';
  // The whole card around a list, not just the list
  const cardOf = (sel) => () => { const el = document.querySelector(sel); return el && el.closest('.admin-card'); };

  const STEPS = [
    { title: 'Welcome to your admin panel',
      text: 'This short tour shows what each part of the page does. It takes about 2 minutes. Use Next and Back, or Skip tour anytime. You can replay it later with the Tour button at the top.' },
    { section: 'overview', target: '.sidebar-nav', title: 'The menu',
      text: 'Each item opens a different part of the panel. On a phone, open the menu with the button at the top left.' },
    { section: 'overview', target: '#classToggle', title: 'Open or close the class',
      text: 'Students can only log in and study while the class is open. Tap here to switch it. This opens or closes ALLEARN for every section, not only yours, so agree on it with the other teachers.' },
    { section: 'overview', target: '.admin-quick', title: 'Shortcuts',
      text: 'Quick buttons for common jobs: post an announcement, see who needs attention, edit content, and download everyone\'s progress as a spreadsheet (CSV).' },
    { section: 'overview', target: '.admin-stats', title: 'Your class in numbers',
      text: 'How many students you have, who studied today and this week, who has been away for 7 days or more, and the average progress.' },
    { section: 'overview', target: cardOf('#inactiveList'), title: 'At-risk students',
      text: 'Students who have been away 7+ days, are under 50% correct, or are far behind the class. Tap the bell beside a name to email that student a reminder.' },
    { section: 'overview', target: cardOf('#missedList'), title: 'Most-missed questions',
      text: 'Questions students got wrong and haven\'t fixed yet. These are good topics to review together in class.' },
    { section: 'overview', target: cardOf('#sectionBars'), title: 'Progress by section',
      text: 'One bar per section, so you can compare how each class is doing.' },
    { section: 'overview', target: cardOf('#videoList'), title: 'Least-watched videos',
      text: 'Videos that few students have opened. You may want to remind the class about them.' },
    { section: 'students', target: '.admin-toolbar', title: 'Find a student',
      text: 'Search by name or student ID. Filter by section or by Active, Inactive 7+ days or At risk, and change the order with Sort.' },
    { section: 'students', target: '.admin-table-wrap', title: 'The student list',
      text: 'Tap any student to see their activity, finished lessons, questions to review and quizzes. At the bottom, Manage account lets you send a reminder email, sign them out everywhere, reset their progress or remove the account. Each one asks you to confirm first.' },
    { section: 'content', target: '.ce-bar', title: 'Drafts and Publish',
      text: 'Every change you make here is a draft. Students only see it after you tap Publish. Discard changes throws all drafts away, and History lets you roll back to an earlier version if something goes wrong.' },
    { section: 'content', target: '.ce-tabs', title: 'What you can edit',
      text: 'Videos, Lessons, Case studies (the situation quizzes) and Study cards (the quiz cards). Each item has Edit, arrows to change the order, and a trash can to remove it.' },
    { section: 'quizzes', target: '.qz-create', title: 'Make a timed quiz',
      text: 'New quiz lets you type the questions and pick the right answers. Import from file reads a Word, PDF or text file you already have. A new quiz stays a draft until you tap Publish.' },
    { section: 'quizzes', target: '.qz-rules', title: 'How quizzes work',
      text: 'Every question has its own timer and students get one try. You can set when a quiz opens and its deadline; students who miss the deadline get 0. Questions lock once any student starts, so check them before publishing.' },
    { section: 'quizzes', target: '.qz-list', title: 'Your quizzes and scores',
      text: 'Each quiz shows its status (Draft, Upcoming, Open or Closed), how many finished and the class average. Scores lists each student; Results shows how each question went and has Allow retake. More lets you change the deadline or sections.' },
    { section: 'announcements', target: '#announceForm', title: 'Post an announcement',
      text: 'Write a title and an optional message, pick a "Show until" date if you like, and choose which sections see it. It appears at the top of their Dashboard right away.' },
    { section: 'announcements', target: cardOf('#announceList'), title: 'Posted announcements',
      text: 'Everything you have posted. Use the trash can to take one down.' },
    { section: 'instructors', target: cardOf('#instructorList'), title: 'Teachers',
      text: 'Add instructor creates a teacher account and picks their sections. Edit changes their role or sections, the key sets a new temporary password, and the trash can removes them. There must always be at least one main admin.' },
    { section: 'audit', target: cardOf('#auditList'), title: 'Activity log',
      text: 'A record of what teachers do here: opening and closing the class, viewing a student\'s details, exporting data and changes to student accounts. It shows who looked at what, to protect students\' privacy.' },
    { section: 'overview', target: '.sidebar-user', title: 'Your account',
      text: 'The key changes your password and the arrow logs you out. Always log out on a shared or school computer.' },
    { title: 'You\'re all set!',
      text: 'That\'s the whole panel. Replay this tour anytime with the Tour button at the top of the page.' },
  ];

  let steps = [];
  let index = 0;
  let current = null;   // highlighted element, or null for a centered card
  let layer = null;
  let startHash = '';
  let returnFocus = null;

  function canOpen(section) {
    if (!section) return true;
    const link = document.querySelector(`.sidebar-nav [data-section="${section}"]`);
    return !!link && !link.hidden;
  }

  // Only highlight what is really on screen (the sidebar is off-screen on phones)
  function findTarget(step) {
    if (!step.target) return null;
    const el = typeof step.target === 'function' ? step.target() : document.querySelector(step.target);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height && r.right > 0 && r.left < window.innerWidth ? el : null;
  }

  const $ = (sel) => layer.querySelector(sel);
  const narrow = () => window.innerWidth < 640;

  // On phones the sidebar becomes a sticky top bar that would cover a part scrolled to the top
  function topBarHeight() {
    const bar = document.querySelector('.sidebar');
    return bar && getComputedStyle(bar).position === 'sticky' ? bar.getBoundingClientRect().height : 0;
  }

  function position() {
    if (!layer) return;
    const card = $('.tour-card');
    const spot = $('.tour-spot');
    card.style.top = card.style.left = '';
    layer.classList.toggle('is-dim', !current);
    spot.hidden = !current;
    if (!current) { card.className = 'tour-card is-center'; return; }

    // style.css zooms the page out on laptops: measure in screen pixels, then
    // divide by the zoom when placing things inside the zoomed page
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const px = (n) => `${n / zoom}px`;
    const pad = 6;
    const r = current.getBoundingClientRect();
    Object.assign(spot.style, {
      top: px(r.top - pad), left: px(r.left - pad),
      width: px(r.width + pad * 2), height: px(r.height + pad * 2),
    });
    if (narrow()) {
      // Card at the top only when the highlight starts low (near the page end); tall parts keep their heading visible
      const lower = r.top > window.innerHeight / 2;
      card.className = `tour-card is-docked${lower ? ' is-top' : ''}`;
      return;
    }

    card.className = 'tour-card';
    const gap = 14;
    const h = card.offsetHeight * zoom;
    const w = card.offsetWidth * zoom;
    const below = r.bottom + pad + gap;
    const above = r.top - pad - gap - h;
    const top = below + h <= window.innerHeight - 8 ? below : above >= 8 ? above : window.innerHeight - h - 16;
    card.style.top = px(top);
    card.style.left = px(Math.min(Math.max(8, r.left), window.innerWidth - w - 8));
  }

  function show(i) {
    index = i;
    const step = steps[i];
    if (step.section && location.hash !== `#${step.section}`) location.hash = step.section;
    // Let the tab switch (hashchange) happen before measuring
    setTimeout(() => {
      if (!layer) return;
      current = findTarget(step);
      $('.tour-count').textContent = `${index + 1} of ${steps.length}`;
      $('#tourTitle').textContent = step.title;
      $('#tourText').textContent = step.text;
      $('[data-tour="back"]').disabled = index === 0;
      $('[data-tour="next"]').textContent = index === steps.length - 1 ? 'Finish' : 'Next';
      if (current) {
        // Tall parts (long lists) show their top, so their heading stays visible
        const fromTop = narrow() || current.getBoundingClientRect().height > window.innerHeight * 0.6;
        // 'instant': the page scrolls smoothly, and the highlight must be measured after the scroll
        current.scrollIntoView({ block: fromTop ? 'start' : 'center', behavior: 'instant' });
        if (fromTop) window.scrollBy({ top: -(topBarHeight() + 16), behavior: 'instant' });
      }
      position();
      $('[data-tour="next"]').focus();
    }, 80);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); end(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); next(); return; }
    if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); show(index - 1); return; }
    if (e.key === 'Tab') {
      // Keep keyboard focus inside the tour card
      const buttons = [...layer.querySelectorAll('button:not(:disabled)')];
      const at = buttons.indexOf(document.activeElement);
      e.preventDefault();
      buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
    }
  }

  function next() {
    if (index < steps.length - 1) show(index + 1); else end();
  }

  function start() {
    if (layer) return;
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* storage blocked */ }
    steps = STEPS.filter(s => canOpen(s.section));
    startHash = location.hash;
    returnFocus = document.activeElement;

    layer = document.createElement('div');
    layer.className = 'tour-layer';
    layer.innerHTML = `
      <div class="tour-spot" aria-hidden="true"></div>
      <div class="tour-card is-center" role="dialog" aria-modal="true" aria-labelledby="tourTitle" aria-describedby="tourText">
        <div class="tour-top">
          <span class="tour-count"></span>
          <button type="button" class="tour-skip" data-tour="skip">Skip tour</button>
        </div>
        <h3 id="tourTitle"></h3>
        <p id="tourText"></p>
        <div class="tour-actions">
          <button type="button" class="tool-btn" data-tour="back"><i class="fa-solid fa-arrow-left"></i> Back</button>
          <button type="button" class="tool-btn ce-publish" data-tour="next">Next</button>
        </div>
      </div>`;
    layer.addEventListener('click', (e) => {
      const act = e.target.closest('[data-tour]');
      if (!act) return;
      if (act.dataset.tour === 'next') next();
      else if (act.dataset.tour === 'back') show(index - 1);
      else end();
    });
    document.body.appendChild(layer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, { passive: true });
    show(0);
  }

  function end() {
    if (!layer) return;
    layer.remove();
    layer = null;
    current = null;
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', position);
    window.removeEventListener('scroll', position);
    location.hash = startHash || 'overview';
    if (returnFocus && returnFocus.focus) returnFocus.focus();
  }

  // First visit on this browser only
  function maybeStart() {
    let seen = false;
    try { seen = !!localStorage.getItem(SEEN_KEY); } catch (e) { /* storage blocked: still show once */ }
    if (!seen) start();
  }

  return { start, maybeStart };
})();
