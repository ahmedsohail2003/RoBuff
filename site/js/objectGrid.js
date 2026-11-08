// Object grid: one tile per request tested end to end in the browser. One tile is highlighted on a timer;
// hover or keyboard focus takes over, and a click pins it (the timer stops). The stats row shows that
// object's receipt and lift-test values.
// Shared selection with the step-2 mini panel: another script dispatches 'object-select' on document
// with detail { index } to select and pin a tile; every change is announced as 'object-selected' with
// detail { index, user } (user is false for the timer and the first paint).

import { OBJECTS } from './data.js';

const GLYPHS = {
  asteroid: '<svg viewBox="0 0 40 40"><path d="M9 24l3-11 10-5 9 4 3 10-5 9-11 2-7-4z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  fragment: '<svg viewBox="0 0 40 40"><path d="M8 30l9-21 15 9-6 14z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  shard: '<svg viewBox="0 0 40 40"><path d="M14 33l-3-14 8-13 9 10-3 15z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  panel: '<svg viewBox="0 0 40 40"><g fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6" y="13" width="28" height="14"/><path d="M15 13v14M25 13v14"/></g></svg>',
  dish: '<svg viewBox="0 0 40 40"><g fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 16a13 9 0 0 0 26 0z"/><path d="M20 25v8M14 33h12"/></g></svg>',
};

export function mountObjectGrid() {
  const host = document.getElementById('tiles');
  if (!host) return;
  const st = {
    name: document.getElementById('st-name'),
    note: document.getElementById('st-note'),
    width: document.getElementById('st-width'),
    mass: document.getElementById('st-mass'),
    lift: document.getElementById('st-lift'),
    verdict: document.getElementById('st-verdict'),
  };
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  const tiles = OBJECTS.map((o, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tile' + (o.verdict === 'REFUSED' ? ' refused' : '');
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', `${o.name}: width ${o.width}, mass ${o.mass}, lift test ${o.lift}, ${o.verdict}`);
    b.innerHTML =
      `<span class="no">${String(i + 1).padStart(2, '0')}</span>` +
      `<span class="glyph" aria-hidden="true" style="transform:translate(-50%,-50%) rotate(${(i * 47) % 360}deg)">${GLYPHS[o.kind] || GLYPHS.asteroid}</span>` +
      `<span class="name" aria-hidden="true">${o.name}</span><span class="st" aria-hidden="true"></span>`;
    host.appendChild(b);
    return b;
  });

  let active = -1;
  let timer = 0;
  let paused = false;
  let pinned = -1; // index of the clicked tile, or -1 while the timer runs

  function select(i, user = false) {
    if (active >= 0) {
      tiles[active].classList.remove('active');
      tiles[active].setAttribute('aria-pressed', 'false');
    }
    active = i;
    tiles[i].classList.add('active');
    tiles[i].setAttribute('aria-pressed', 'true');
    const o = OBJECTS[i];
    st.name.textContent = o.name;
    st.note.textContent = o.note;
    st.width.innerHTML = o.asked ? `${o.width}<small>${o.asked}</small>` : o.width;
    st.mass.textContent = o.mass;
    st.lift.textContent = o.lift;
    st.verdict.textContent = o.verdict;
    st.verdict.dataset.v = o.verdict.toLowerCase();
    document.dispatchEvent(new CustomEvent('object-selected', { detail: { index: i, user } }));
  }

  function pin(i) {
    pinned = i;
    clearInterval(timer);
    select(i, true);
  }

  function startTimer() {
    clearInterval(timer);
    if (reduce.matches || pinned >= 0) return;
    timer = setInterval(() => {
      if (!paused) select((active + 1) % tiles.length);
    }, 2200);
  }

  tiles.forEach((t, i) => {
    t.addEventListener('pointerenter', () => {
      paused = true;
      select(i);
    });
    t.addEventListener('focus', () => {
      paused = true;
      select(i);
    });
    t.addEventListener('click', () => pin(i));
  });
  document.addEventListener('object-select', (e) => {
    const i = e.detail && e.detail.index;
    if (Number.isInteger(i) && i >= 0 && i < tiles.length) pin(i);
  });
  // Hover previews another tile; leaving the grid goes back to the pinned one.
  host.addEventListener('pointerleave', () => {
    paused = false;
    if (pinned >= 0 && active !== pinned) select(pinned);
  });
  host.addEventListener('focusout', (e) => {
    if (host.contains(e.relatedTarget)) return;
    paused = false;
    if (pinned >= 0 && active !== pinned) select(pinned);
  });

  select(0);
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) startTimer();
    else clearInterval(timer);
  }).observe(host);
}
