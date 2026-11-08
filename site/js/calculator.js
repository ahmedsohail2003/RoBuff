// "Can the arm lift it?" quick check.
// Mass = a measured hull scaled to the chosen size, times the material's density (data.js TABS).
// Friction needed for the object's weight = mass_kg * g / 50 N (the guardrail's weight check).
// Verdicts follow COPY.md section 2: the first rule that matches wins. Labelled "Quick check".

import { LIMITS, GRAVITY, MATERIALS, TABS, IRON_SOLID_NOTE } from './data.js';

export function mountCalculator(form) {
  if (!form) return;
  const $ = (id) => form.querySelector('#' + id);
  const size = $('c-size');
  const mat = $('c-mat');
  const oSize = $('o-size');
  const oGrav = $('o-grav');
  const oMass = $('o-mass');
  const oNeed = $('o-need');
  const oVerdict = $('o-verdict');
  const oExtra = $('o-extra');
  const oShape = $('o-shape');
  const tabs = [...form.querySelectorAll('[role="tab"]')];
  const segs = [...form.querySelectorAll('.seg button')];
  const panel = $('calc-body');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let tab = 'rock';
  let gi = 0;
  let shownMass = null;
  let anim = 0;

  const setFill = (input) => {
    const min = Number(input.min);
    const max = Number(input.max);
    const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--fill', pct + '%');
  };

  // One decimal under 100 g, whole grams from 100 g up.
  const fmtMass = (g) => (g >= 99.95 ? Math.round(g).toLocaleString('en-US') : g.toFixed(1));

  // Two significant figures; very small values in powers of ten.
  function fmtMu(x) {
    if (x === 0) return '0';
    if (x >= 1e-4) return String(Number(x.toPrecision(2)));
    const [m, e] = x.toExponential(1).split('e');
    const sup = String(Number(e)).replace(/[-0-9]/g, (c) => '⁻⁰¹²³⁴⁵⁶⁷⁸⁹'['-0123456789'.indexOf(c)]);
    return `${m} × 10${sup}`;
  }

  function animateMass(target) {
    cancelAnimationFrame(anim);
    if (reduce.matches || shownMass === null) {
      shownMass = target;
      oMass.textContent = fmtMass(target);
      return;
    }
    const from = shownMass;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 380);
      const e = 1 - Math.pow(1 - p, 3);
      shownMass = from + (target - from) * e;
      oMass.textContent = fmtMass(shownMass);
      if (p < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  function fillMaterials() {
    const ids = TABS[tab].materials;
    mat.innerHTML = '';
    ids.forEach((id) => {
      const m = MATERIALS[id];
      const o = document.createElement('option');
      o.value = id;
      o.textContent = `${m.label}${TABS[tab].matSuffix || ''} · ${m.density} g/cm³`;
      mat.appendChild(o);
    });
    mat.value = ids[0];
  }

  function update() {
    const t = TABS[tab];
    const m = MATERIALS[mat.value] || MATERIALS[t.materials[0]];
    const g = GRAVITY[gi];
    const d = Number(size.value); // mm
    const volume = t.refHullCc * (d / t.refMm) ** 3; // cm^3
    const mass = volume * m.density; // g
    const need = ((mass / 1000) * g.g) / LIMITS.squeezeN;

    oSize.textContent = `${d} mm`;
    oGrav.textContent = `${g.shown} m/s²`;
    size.setAttribute('aria-valuetext', `${d} millimetres`);
    setFill(size);
    animateMass(mass);
    oNeed.textContent = `Weight alone needs friction ≥ ${fmtMu(need)} · has ${m.friction} (design value); the jaw angle adds more, per shape`;
    if (oShape) oShape.textContent = t.shape;

    let text;
    if (d > LIMITS.farTooBig) text = 'Far too big to grip. The app builds a 55 mm model instead and says so.';
    else if (mass > LIMITS.handMMax) text = 'Too heavy: over the 200 g hand-flying limit. The app refuses it.';
    else if (d > LIMITS.handWMax) text = 'Wider than the 55 mm hand-flying limit. The app scales it down and says by how much.';
    else if (d < LIMITS.handWMin) text = 'Too small to hold well (15 mm minimum). The app scales it up.';
    else if (mat.value === 'ice') text = 'Ice has friction 0.03, so the pad angle decides. The app’s ice shard needed 0.26: refused.';
    else text = 'Inside the arm’s limits. Next, a simulated lift test: a pass means still 48 mm up after the hold.';
    oVerdict.textContent = text;
    // One note line: the low-gravity warning and the solid-iron reminder share it, so the panel keeps its height.
    const notes = [];
    if (g.g < LIMITS.lowGravityWarnBelow) notes.push('Simulated contact is unreliable at this gravity.');
    if (tab === 'part' && mat.value === 'iron') notes.push(IRON_SOLID_NOTE);
    oExtra.hidden = notes.length === 0;
    // the note takes the shape line's place (the footnote below the button still explains the shape)
    if (oShape) oShape.hidden = notes.length > 0;
    oExtra.textContent = notes.join(' ');
  }

  function selectTab(next, focus) {
    tab = next.dataset.tab;
    tabs.forEach((x) => {
      const on = x === next;
      x.setAttribute('aria-selected', String(on));
      x.tabIndex = on ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', next.id);
    size.value = String(TABS[tab].defaultMm);
    fillMaterials();
    if (focus) next.focus();
    update();
  }

  function selectGravity(i, focus) {
    gi = i;
    segs.forEach((b, j) => {
      b.setAttribute('aria-checked', String(j === i));
      b.tabIndex = j === i ? 0 : -1;
    });
    if (focus) segs[i].focus();
    update();
  }

  tabs.forEach((x, i) => {
    x.addEventListener('click', () => selectTab(x, false));
    x.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        selectTab(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length], true);
      }
    });
  });
  segs.forEach((b, i) => {
    b.addEventListener('click', () => selectGravity(i, false));
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : segs.length - 1;
        selectGravity((i + dir) % segs.length, true);
      }
    });
  });
  size.addEventListener('input', update);
  mat.addEventListener('change', update);
  form.addEventListener('submit', (e) => e.preventDefault());
  fillMaterials();
  selectGravity(0, false);
}
