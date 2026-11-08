// Entry point: wires every module to its section. Each module is independent, so one failing
// (for example a missing motion file) does not stop the rest of the page.

import { mountHeader } from './header.js';
import { mountCloud } from './pointcloud.js';
import { mountHalftone } from './halftone.js';
import { mountScramble } from './scramble.js';
import { mountReveals, mountCounters, mountRings } from './reveal.js';
import { mountCalculator } from './calculator.js';
import { mountScroller } from './scroller.js';
import { mountObjectGrid } from './objectGrid.js';
import { mountMinis } from './minis.js';

function safe(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') r.catch((e) => console.warn(`[${name}]`, e));
  } catch (e) {
    console.warn(`[${name}]`, e);
  }
}

safe('space3d', () => import('./space3d.js').then((m) => m.mountSpace3D()));
safe('spacebg', () => import('./spacebg.js').then((m) => m.mountSpaceBg()));
safe('header', mountHeader);
safe('reveals', mountReveals);
safe('counters', mountCounters);
safe('rings', mountRings);
safe('calculator', () => mountCalculator(document.getElementById('calc')));
safe('scroller', mountScroller);
safe('grid', mountObjectGrid);
safe('minis', mountMinis);

safe('scramble', () => {
  const el = document.getElementById('hero-rotate');
  if (el) mountScramble(el, JSON.parse(el.dataset.phrases || '[]'));
});

safe('halftone', () => document.querySelectorAll('canvas.halftone').forEach((c) => mountHalftone(c)));

const narrow = () => window.innerWidth < 901;
// Rectangles of the hero's readable text, in the canvas's own pixels, re-read on resize and scroll-free
// (the canvas and the copy scroll together). The point cloud draws dots inside them at a low alpha.
function textMask(canvas, selectors) {
  let cache = null;
  let key = '';
  return (w, h) => {
    const k = `${w}x${h}x${Math.floor(performance.now() / 1000)}`; // re-read once a second (fonts, scramble)
    if (cache && key === k) return cache;
    const base = canvas.getBoundingClientRect();
    const rects = [];
    selectors.forEach((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      for (const r of el.getClientRects()) {
        if (r.width && r.height) rects.push([r.left - base.left, r.top - base.top, r.right - base.left, r.bottom - base.top]);
      }
    });
    cache = { rects, floor: 0.32, soft: 28 };
    key = k;
    return cache;
  };
}
safe('hero-cloud', () => {
  const c = document.getElementById('hero-cloud');
  if (!c) return undefined;
  return mountCloud(c, {
    // desktop: a large background scene behind and to the right of the headline, like the reference's
    // LiDAR scene; dots over the copy column fade to a low alpha so the text stays readable.
    // mobile: in its own band above the badge (the hero copy is padded down to make room).
    yaw: -1.05 + Math.PI,
    sway: 0.3,
    labelAlign: 'right',
    cornerTag: 'scene',
    minTagY: 78, // keep the SIMULATION tag below the 60 px header
    jawLabel: () => narrow(), // on desktop the jaw sits behind the copy, so only the rock is labelled
    // desktop: the rock (lower right of the scene, about 0.36 scene-heights right of its centre) lands in
    // the gap just left of the calculator card, whatever the window width
    anchor: (w, h) => {
      if (narrow()) return [0.5, 200 / h];
      // a large, faint silhouette centred between the copy and the calculator card, like the
      // reference's background scene; the rock stays just left of the card
      const card = document.getElementById('calc');
      const left = card ? card.getBoundingClientRect().left - c.getBoundingClientRect().left : w * 0.61;
      return [(left - 0.36 * 0.92 * h) / w, 0.5];
    },
    size: (w, h) => (narrow() ? 250 / h : 0.92),
    mask: textMask(c, ['.hero .badge', '#hero-title', '.hero .summary', '.hero .ctas', '.hero .credit']),
  });
});
safe('cta-cloud', () => {
  const c = document.getElementById('cta-cloud');
  if (!c) return undefined;
  return mountCloud(c, { anchor: [0.54, 0.52], size: 0.68, offset: 3 });
});
