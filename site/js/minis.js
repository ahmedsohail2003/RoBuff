// Small looping animations inside the three step cards' mini panels:
// the grip state toggling, the describe box typing, and the receipt ticking row by row.
// The step-2 describe box is also live: its preset chips and its text box select one of the tested
// objects (the same OBJECTS the object grid uses) and show that object's tested result in the panel.

import { OBJECTS } from './data.js';

// Typed words -> tested object, by the object's name in OBJECTS. Checked in order; Texas first so
// "an asteroid the size of Texas" lands on the Texas request, not the Bennu-like sample.
const WORDS = [
  [/\btexas\b/, 'Size of Texas'],
  [/\biron\b/, 'Solid iron, 60 mm'],
  [/\b(ice|icy|comet)\b/, 'Comet ice shard'],
  [/\b(panel|cubesat|cube ?sat)\b/, 'CubeSat panel'],
  [/\b(dish|antenna)\b/, 'Comms dish'],
  [/\b(chip|s-?type|stony)\b/, 'S-type chip'],
  [/\b(asteroid|bennu|rock|sample|c-?type)\b/, 'Bennu-like sample'],
];
const NO_MATCH = 'This page only shows the objects I tested. The app itself takes any request.';

function mountDescribe(stopTyping) {
  const panel = document.getElementById('mini-describe');
  if (!panel) return;
  const input = document.getElementById('mini-type');
  const out = document.getElementById('mini-result');
  const chips = [...panel.querySelectorAll('.chips button[data-object]')];
  const indexOf = (name) => OBJECTS.findIndex((o) => o.name === name);

  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function show(i) {
    chips.forEach((c) => {
      const on = indexOf(c.dataset.object) === i;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (!out) return;
    const o = OBJECTS[i];
    const test = o.verdict === 'REFUSED' ? `Refused before it was placed. ${o.note}` : `Lift test result: it rose ${o.lift}. ${o.note}`;
    out.innerHTML =
      `<div class="mr-head"><b>${esc(o.name)}</b><span class="mr-v" data-v="${o.verdict.toLowerCase()}">${o.verdict}</span></div>` +
      `<div class="mr-nums mono"><span>${esc(o.width)}${o.asked ? ` (${esc(o.asked)})` : ''}</span><span>${esc(o.mass)}</span></div>` +
      `<p class="mr-note">${esc(test)}</p>`;
    out.hidden = false;
  }

  function choose(i) {
    stopTyping();
    // The grid pins the tile and answers with 'object-selected', which calls show().
    document.dispatchEvent(new CustomEvent('object-select', { detail: { index: i } }));
    if (!document.getElementById('tiles')) show(i);
  }

  chips.forEach((c) => c.addEventListener('click', () => choose(indexOf(c.dataset.object))));

  document.addEventListener('object-selected', (e) => {
    if (e.detail && e.detail.user) show(e.detail.index);
  });

  if (input) {
    input.addEventListener('focus', stopTyping);
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const text = input.value.trim().toLowerCase();
      if (!text) return;
      const hit = WORDS.find(([re]) => re.test(text));
      const i = hit ? indexOf(hit[1]) : -1;
      if (i >= 0) {
        choose(i);
        return;
      }
      chips.forEach((c) => {
        c.classList.remove('on');
        c.setAttribute('aria-pressed', 'false');
      });
      if (out) {
        out.innerHTML = `<p class="mr-note">${NO_MATCH}</p>`;
        out.hidden = false;
      }
    });
  }
}

export function mountMinis() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const grip = document.getElementById('mini-grip');
  const typed = document.getElementById('mini-type');
  const ticks = document.getElementById('mini-ticks');
  const pass = document.getElementById('mini-pass');
  const items = ticks ? [...ticks.querySelectorAll('li')] : [];

  let typingStopped = false;
  let typingId = 0;
  const stopTyping = () => {
    typingStopped = true;
    clearInterval(typingId);
    typingId = 0;
    if (typed && typed.dataset.full) typed.placeholder = typed.dataset.full;
  };
  mountDescribe(stopTyping);

  if (reduce) {
    items.forEach((li) => li.classList.add('done'));
    if (pass) pass.classList.add('on');
    return;
  }

  const onScreen = (el, fn) => {
    if (!el) return;
    let id = 0;
    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !id) id = fn();
      else if (!entries[0].isIntersecting && id) {
        clearInterval(id);
        id = 0;
      }
    }).observe(el);
  };

  onScreen(grip, () => {
    let closed = false;
    return setInterval(() => {
      closed = !closed;
      grip.textContent = closed ? 'closed' : 'open';
    }, 1600);
  });

  // The describe box types its example into the input's placeholder until someone uses the box.
  if (typed) {
    const full = typed.dataset.full || typed.placeholder || '';
    typed.dataset.full = full;
    onScreen(typed, () => {
      if (typingStopped || typed.value) return 0;
      let n = 0;
      typingId = setInterval(() => {
        if (typed.value) return;
        n = n > full.length + 24 ? 0 : n + 1;
        typed.placeholder = full.slice(0, Math.min(n, full.length)) + (n <= full.length ? '|' : '');
      }, 70);
      return typingId;
    });
  }

  onScreen(ticks, () => {
    let n = 0;
    return setInterval(() => {
      n = (n + 1) % (items.length + 4);
      items.forEach((li, i) => li.classList.toggle('done', i < n));
      if (pass) pass.classList.toggle('on', n >= items.length);
    }, 500);
  });
}
