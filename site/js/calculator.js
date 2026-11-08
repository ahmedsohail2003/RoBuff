// "Can the arm lift it?" quick check.
// Mass = a measured hull scaled to the chosen size, times the material's density (data.js TABS).
// Friction needed for the object's weight = mass_kg * g / 50 N (the guardrail's weight check).
// Order follows the app (web/src/objects/guardrail.ts): step 4 first rescales on the narrowest side
// and the height, then step 5 weighs the rescaled object. The first verdict that matches wins.
// Labelled "Quick check".

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
    const mass = volume * m.density; // g, at the chosen size

    // guardrail.ts step 4: one uniform scale that brings the narrowest side and the height inside the hand band.
    const narrow = d * (t.refNarrowMm / t.refMm);
    const height = d * (t.refHeightMm / t.refMm);
    const lowW = LIMITS.handWMin / narrow;
    const lowH = LIMITS.hMin / height;
    const low = Math.max(lowW, lowH);
    const high = Math.min(LIMITS.handWMax / narrow, LIMITS.handHMax / height);
    let scale = 1;
    if (low > 1) scale = Math.min(high, low * (1 + LIMITS.insideMargin));
    else if (high < 1) scale = Math.max(low, high * (1 - LIMITS.insideMargin));
    // guardrail.ts MODEL_SCALE: once a request is shrunk below half size it is a model anyway, so the
    // app also sizes it to land just under the mass limit (if that still fits the jaw).
    let sizedForMass = false;
    if (scale < 0.5 && mass * scale ** 3 > LIMITS.handMMax) {
      const s = Math.cbrt((LIMITS.handMMax * 0.98) / mass);
      if (s >= low) { scale = s; sizedForMass = true; }
    }
    // guardrail.ts step 5: the app weighs the object after that rescale.
    const finalMass = mass * scale ** 3;
    const need = ((finalMass / 1000) * g.g) / LIMITS.squeezeN;

    oSize.textContent = `${d} mm`;
    oGrav.textContent = `${g.shown} m/s²`;
    size.setAttribute('aria-valuetext', `${d} millimetres`);
    setFill(size);
    animateMass(mass);
    oNeed.textContent = `To hold its weight${scale !== 1 ? ' after resizing' : ''}, the grip needs friction of at least ${fmtMu(need)}. This material has ${m.friction}${m.basis === 'design value' ? ', a set value, not a measurement' : ` (source: ${m.basis})`}. Some shapes need more, because the jaws close at an angle.`;
    if (oShape) oShape.textContent = t.shape;

    const by = `${scale.toFixed(2)}×`;
    let text;
    if (low > high) text = 'No size fits both the jaw and the height limit. The app refuses it.';
    else if (finalMass > LIMITS.handMMax) {
      text = scale < 1
        ? `Still over the 200 g limit after the app shrinks it to fit the jaw (${by}, ${fmtMass(finalMass)} g). The app refuses it.`
        : 'Too heavy. It is over the 200 g limit. The app refuses it.';
    } else if (sizedForMass) text = `Much bigger than the jaw. The app builds a ${by} model that stays under the 200 g limit. That model weighs ${fmtMass(finalMass)} g.`;
    else if (scale < 1) text = `Its narrowest side is over 55 mm or it is taller than 60 mm. Those are the limits for steering by hand. The app shrinks it to ${by} and tells you. That model weighs ${fmtMass(finalMass)} g.`;
    else if (scale > 1) text = lowW >= lowH
      ? 'Too small to hold well. The jaw needs at least 15 mm. The app scales it up and tells you by how much.'
      : 'Too thin for the fingertips to reach. The app scales it up and tells you by how much.';
    else if (mat.value === 'ice') text = 'Ice has friction 0.03, so the angle of the pads decides. The ice shard in the app needed 0.26, so it was refused.';
    else text = 'This fits the arm. Next the app runs a simulated lift test. It passes if the object is still 48 mm up after the hold.';
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
