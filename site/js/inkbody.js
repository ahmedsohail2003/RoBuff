// Ink asteroid. A small Bennu-like rock drawn as ink dots on the light paper, for the empty margin
// beside the object grid. The dots come from dotbody.js. This file shapes, lights and draws them.
// Shadow is ink, as in a stipple drawing. A dot is drawn when its shade (1 minus its light) passes its
// fixed rnd value, so the side away from the sun gets denser. The lit side keeps a thin scatter and the
// edge keeps a faint dotted outline, so the shape still reads there.
// A few craters are carved here rather than in makeBody, because a crater only reads at this size when
// its sun-side wall casts a shadow across its floor, and that needs each crater's centre and depth.
// The sun follows the pointer (pointer.js). It shines from wherever the mouse or finger is, relative to
// the rock on screen, and eases there, so the shading and the crater shadows swing smoothly. The rock
// turns slowly about a tilted axis and leans a little toward the pointer. Under prefers-reduced-motion
// it is drawn once, lit from the upper left, and redrawn only on resize.
// The shape is illustrative (a spinning top with an equator ridge and craters), not a model of Bennu.
// The label names it the way the page names its made-up shapes, BENNU-LIKE ROCK, with no number, so the
// drawing is never read as a model of the real Bennu.

import { makeBody, rng } from './dotbody.js';
import { pointer, trackPointer } from './pointer.js';

const INK = '#0b0c0e';
const REF_SIDE = 240; // css px. opts.n is the dot count for a frame this size. Other sizes scale by area.
const LABEL_H = 26; // css px kept under the frame for the label
const LABEL_FONT = '500 10.5px "Geist Mono", ui-monospace, monospace';

// Passed to makeBody: broad lumps and a mild equator ridge. Its own craters are off by default,
// the craters below replace them.
const SHAPE = {
  craters: 0,
  lumps: 5,
  lumpAmp: 0.05,
  ridge: 0.05,
  squash: 0.9,
  grain: 0.05,
  base: 0.8,
};

// Carved craters: count, radius range in radians of arc, bowl depth in crater radii, rim height
const CRATERS = { count: 9, rMax: 0.4, rMin: 0.15, depth: 0.45, rim: 0.06 };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// 3 by 3 rotations, row major
function rx(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
function ry(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
function rz(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}
function mul(A, B) {
  const o = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) o[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  }
  return o;
}

// Pull the rock toward a rounded diamond in side view (a superellipse with exponent p below 2), the
// spinning top outline of Bennu, and tilt each normal by the same slope. Lumps and ridge stay.
function spinTop(b, p) {
  const { n, pos, nrm } = b;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const x = pos[j];
    const y = pos[j + 1];
    const z = pos[j + 2];
    const r = Math.hypot(x, y, z) || 1;
    const ux = x / r;
    const uy = y / r;
    const uz = z / r;
    const s = Math.max(1e-3, Math.sqrt(Math.max(0, 1 - uz * uz)));
    const az = Math.max(1e-3, Math.abs(uz));
    const u = Math.pow(s, p) + Math.pow(az, p);
    const f = Math.pow(u, -1 / p); // radius factor in this direction
    const g = (uz * Math.pow(s, p - 2) - Math.sign(uz) * Math.pow(az, p - 1)) / u; // slope of ln f along uz
    pos[j] = x * f;
    pos[j + 1] = y * f;
    pos[j + 2] = z * f;
    const nx = nrm[j] + g * uz * ux;
    const ny = nrm[j + 1] + g * uz * uy;
    const nz = nrm[j + 2] - g * (1 - uz * uz);
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm[j] = nx / l;
    nrm[j + 1] = ny / l;
    nrm[j + 2] = nz / l;
  }
}

// Crater centres on the unit sphere, largest first, kept apart so none overlap.
function placeCraters(seed, cfg) {
  const r = rng((seed * 131 + 7) >>> 0);
  const list = [];
  for (let k = 0, guard = 0; k < cfg.count && guard < cfg.count * 60; guard++) {
    const rad = cfg.rMax * Math.pow(cfg.rMin / cfg.rMax, cfg.count > 1 ? k / (cfg.count - 1) : 0);
    const z = r() * 1.7 - 0.85; // keep off the poles, where the dashed axis stands
    const a = r() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    const c = [s * Math.cos(a), s * Math.sin(a), z];
    const far = list.every((C) => Math.acos(clamp(C.c[0] * c[0] + C.c[1] * c[1] + C.c[2] * c[2], -1, 1)) > (C.rad + rad) * 1.35);
    if (!far) continue;
    // a tangent basis at the centre
    const t = Math.abs(c[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let e1 = [t[1] * c[2] - t[2] * c[1], t[2] * c[0] - t[0] * c[2], t[0] * c[1] - t[1] * c[0]];
    const l = Math.hypot(e1[0], e1[1], e1[2]);
    e1 = [e1[0] / l, e1[1] / l, e1[2] / l];
    const e2 = [c[1] * e1[2] - c[2] * e1[1], c[2] * e1[0] - c[0] * e1[2], c[0] * e1[1] - c[1] * e1[0]];
    list.push({ c, rad, e1, e2 });
    k++;
  }
  return list;
}

// Carve the craters into the dots: a bowl h = depth (x^2 - 1) inside (x is distance in crater radii)
// and a low rim outside, as slopes on the normals. Dots inside a bowl remember their crater and their
// position in its plane, for the cast shadow test while drawing.
function carve(b, craters, cfg) {
  const { n, pos, nrm, alb } = b;
  const cIdx = new Int8Array(n).fill(-1);
  const cq = new Float32Array(n * 2);
  const W = 0.22; // rim width in crater radii
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const r = Math.hypot(pos[j], pos[j + 1], pos[j + 2]) || 1;
    const px = pos[j] / r;
    const py = pos[j + 1] / r;
    const pz = pos[j + 2] / r;
    let best = -1;
    let bx = 1.6;
    for (let k = 0; k < craters.length; k++) {
      const C = craters[k];
      const x = Math.acos(clamp(px * C.c[0] + py * C.c[1] + pz * C.c[2], -1, 1)) / C.rad;
      if (x < bx) {
        bx = x;
        best = k;
      }
    }
    if (best < 0) continue;
    const C = craters[best];
    const lx = (px * C.e1[0] + py * C.e1[1] + pz * C.e1[2]) / C.rad;
    const ly = (px * C.e2[0] + py * C.e2[1] + pz * C.e2[2]) / C.rad;
    const ll = Math.hypot(lx, ly);
    if (ll < 1e-4) continue;
    const x = bx;
    const rimE = Math.exp(-(((x - 1) / W) ** 2));
    const slope = (x < 1 ? 2 * cfg.depth * x : 0) + cfg.rim * rimE * ((-2 * (x - 1)) / (W * W));
    // toward the crater centre, along the surface
    const ix = -(lx * C.e1[0] + ly * C.e2[0]) / ll;
    const iy = -(lx * C.e1[1] + ly * C.e2[1]) / ll;
    const iz = -(lx * C.e1[2] + ly * C.e2[2]) / ll;
    const nx = nrm[j] + slope * ix;
    const ny = nrm[j + 1] + slope * iy;
    const nz = nrm[j + 2] + slope * iz;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nrm[j] = nx / nl;
    nrm[j + 1] = ny / nl;
    nrm[j + 2] = nz / nl;
    alb[i] = clamp(alb[i] + 0.08 * rimE - (x < 1 ? 0.06 * (1 - x * x) : 0), 0.05, 1);
    if (x < 1) {
      cIdx[i] = best;
      cq[i * 2] = lx;
      cq[i * 2 + 1] = ly;
    }
  }
  b.cIdx = cIdx;
  b.cq = cq;
}

/**
 * mountInkBody(canvas, opts) draws the rock and keeps it turning while the canvas is on screen.
 *   seed    the rock (same seed, same rock). Default 7.
 *   n       dots for a 240 px frame. Default 4000. The count scales with the canvas area.
 *   shape   options passed to makeBody, merged over SHAPE above
 *   craters carved craters, merged over CRATERS above ({ count: 0 } for none)
 *   top     spinning top amount, 0 round to 1 strongly diamond shaped. Default 0.85.
 *   size    rock width as a fraction of the frame. Default 0.74.
 *   label   text under the frame, or false for none. Dropped if it is wider than the frame.
 *   ticks   four corner ticks around the frame. Default true.
 *   axis    a faint dashed spin axis off each pole. Default true.
 *   turn    seconds per turn. Default 70.
 *   phase   starting spin angle in radians, also the still pose under reduced motion. Default 0.9.
 *   onFrame called after each draw with its cost in ms, for measuring
 * The frame is the largest square at the top of the canvas, with room for the label under it.
 */
export function mountInkBody(canvas, opts = {}) {
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  trackPointer();
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const seed = opts.seed ?? 7;
  const nRef = opts.n ?? 4000;
  const shape = { ...SHAPE, ...(opts.shape || {}) };
  const crCfg = { ...CRATERS, ...(opts.craters || {}) };
  const topP = 2 - 0.6 * clamp(opts.top ?? 0.85, 0, 1);
  const size = opts.size ?? 0.74;
  const labelText = opts.label === undefined ? 'BENNU-LIKE ROCK' : opts.label || '';
  const ticks = opts.ticks !== false;
  const axis = opts.axis !== false;
  const turn = Math.max(5, opts.turn ?? 70);
  const onFrame = typeof opts.onFrame === 'function' ? opts.onFrame : null;

  // spin axis: up the screen, tipped a little toward the viewer and leaning right, so the spinning top
  // outline and the equator ridge show from the side
  const BASE = mul(rz(-0.2), mul(rx(0.16), rx(-Math.PI / 2)));
  // before the first pointer move the sun is up and to the left, 57 degrees off the view axis
  const DEF_SUN = [-0.595, 0.595, 0.54];
  const sun = DEF_SUN.slice();
  let spin = opts.phase ?? 0.9;
  let yaw = 0;
  let pitch = 0;

  const craters = placeCraters(seed, crCfg);
  // per crater, per frame: the sun's direction along the crater floor and the tangent of its elevation
  const crHx = new Float32Array(craters.length);
  const crHy = new Float32Array(craters.length);
  const crTan = new Float32Array(craters.length);

  let body = null;
  let rnd2 = null;
  let maxR = 1;
  let zTop = 1;
  let zBot = -1;
  let w = 0;
  let h = 0;
  let dpr = 1;
  let side = 0;
  let x0 = 0;
  let cx = 0;
  let cy = 0;
  let radiusPx = 1;
  let scale = 1;
  let stat = null;
  let running = false;
  let visible = false;
  let raf = 0;
  let last = 0;

  function build(n) {
    body = makeBody({ ...shape, n, seed });
    if (topP < 2) spinTop(body, topP);
    carve(body, craters, crCfg);
    // a second fixed value per dot picks the thin scatter on the lit side
    const r2 = rng((seed * 7919 + 13) >>> 0);
    rnd2 = new Float32Array(body.n);
    maxR = 0;
    zTop = 0;
    zBot = 0;
    for (let i = 0; i < body.n; i++) {
      rnd2[i] = r2();
      const z = body.pos[i * 3 + 2];
      maxR = Math.max(maxR, Math.hypot(body.pos[i * 3], body.pos[i * 3 + 1], z));
      zTop = Math.max(zTop, z);
      zBot = Math.min(zBot, z);
    }
    maxR = maxR || 1;
  }

  function layout() {
    const r = canvas.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = r.width;
    h = r.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    side = Math.max(8, Math.min(w, h - (labelText ? LABEL_H : 0)));
    x0 = (w - side) / 2;
    cx = x0 + side / 2;
    cy = side / 2;
    const want = Math.round(nRef * clamp((side * side) / (REF_SIDE * REF_SIDE), 0.4, 1.15));
    if (!body || Math.abs(want - body.n) > body.n * 0.12) build(want);
    radiusPx = (side * size) / 2;
    scale = radiusPx / maxR;
    renderStatic();
    return true;
  }

  // Ticks and label do not move, so they are drawn once into a second canvas and copied each frame.
  function renderStatic() {
    if (!ticks && !labelText) {
      stat = null;
      return;
    }
    stat = stat || document.createElement('canvas');
    stat.width = canvas.width;
    stat.height = canvas.height;
    const g = stat.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const a = x0 + 0.5;
    const b = 0.5;
    const c = x0 + side - 0.5;
    const d = side - 0.5;
    if (ticks) {
      const L = 9;
      g.strokeStyle = INK;
      g.globalAlpha = 0.32;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(a, b + L);
      g.lineTo(a, b);
      g.lineTo(a + L, b);
      g.moveTo(c - L, b);
      g.lineTo(c, b);
      g.lineTo(c, b + L);
      g.moveTo(c, d - L);
      g.lineTo(c, d);
      g.lineTo(c - L, d);
      g.moveTo(a + L, d);
      g.lineTo(a, d);
      g.lineTo(a, d - L);
      g.stroke();
    }
    if (labelText) {
      g.font = LABEL_FONT;
      g.textBaseline = 'alphabetic';
      const sp = 10.5 * 0.12; // letter spacing 0.12em, as the page's mono tags
      const chars = Array.from(labelText);
      const adv = chars.map((ch) => g.measureText(ch).width);
      const tw = adv.reduce((t, v) => t + v + sp, -sp);
      if (tw <= side) {
        g.globalAlpha = 0.5;
        g.fillStyle = INK;
        let x = x0;
        chars.forEach((ch, i) => {
          g.fillText(ch, x, side + 17);
          x += adv[i] + sp;
        });
      }
    }
    g.globalAlpha = 1;
  }

  function update(dt) {
    spin += (dt * 2 * Math.PI) / turn;
    let tx = DEF_SUN[0];
    let ty = DEF_SUN[1];
    let tz = DEF_SUN[2];
    let tyaw = 0;
    let tpitch = 0;
    if (pointer.active) {
      const r = canvas.getBoundingClientRect();
      const dx = pointer.cx - (r.left + cx);
      const dy = pointer.cy - (r.top + cy);
      const dist = Math.hypot(dx, dy);
      const az = Math.atan2(-dy, dx);
      // near the rock the sun is almost behind the viewer, far away it grazes from the pointer's side
      const th = 0.35 + 0.92 * (1 - Math.exp(-dist / (2.4 * radiusPx)));
      tx = Math.sin(th) * Math.cos(az);
      ty = Math.sin(th) * Math.sin(az);
      tz = Math.cos(th);
      tyaw = clamp(dx / 700, -1, 1) * 0.28;
      tpitch = clamp(dy / 700, -1, 1) * 0.2;
    }
    const e = 1 - Math.exp(-dt * 3);
    sun[0] += (tx - sun[0]) * e;
    sun[1] += (ty - sun[1]) * e;
    sun[2] += (tz - sun[2]) * e;
    const l = Math.hypot(sun[0], sun[1], sun[2]) || 1;
    sun[0] /= l;
    sun[1] /= l;
    sun[2] /= l;
    yaw += (tyaw - yaw) * e;
    pitch += (tpitch - pitch) * e;
  }

  function draw() {
    if (!body || !side) return;
    const t0 = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (stat) ctx.drawImage(stat, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = INK;

    const M = mul(ry(yaw), mul(rx(pitch), mul(BASE, rz(spin))));
    const m0 = M[0];
    const m1 = M[1];
    const m2 = M[2];
    const m3 = M[3];
    const m4 = M[4];
    const m5 = M[5];
    const m6 = M[6];
    const m7 = M[7];
    const m8 = M[8];
    const sx = sun[0];
    const sy = sun[1];
    const sz = sun[2];

    // the sun in the rock's own frame (M transposed), then along each crater's floor
    const bx = m0 * sx + m3 * sy + m6 * sz;
    const by = m1 * sx + m4 * sy + m7 * sz;
    const bz = m2 * sx + m5 * sy + m8 * sz;
    for (let k = 0; k < craters.length; k++) {
      const C = craters[k];
      const l1 = bx * C.e1[0] + by * C.e1[1] + bz * C.e1[2];
      const l2 = by * C.e2[1] + bx * C.e2[0] + bz * C.e2[2];
      const l3 = bx * C.c[0] + by * C.c[1] + bz * C.c[2];
      const hl = Math.hypot(l1, l2) || 1e-6;
      crHx[k] = l1 / hl;
      crHy[k] = l2 / hl;
      crTan[k] = l3 > 0 ? l3 / hl : -1; // below the crater's horizon: the whole bowl is dark anyway
    }

    const { n, pos, nrm, alb, rnd, cIdx, cq } = body;
    const depth = crCfg.depth;
    const k = scale;
    let lastA = -1;
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const px = pos[j];
      const py = pos[j + 1];
      const pz = pos[j + 2];
      if (m6 * px + m7 * py + m8 * pz < -0.3) continue; // far side
      const qx = nrm[j];
      const qy = nrm[j + 1];
      const qz = nrm[j + 2];
      const nz = m6 * qx + m7 * qy + m8 * qz;
      if (nz <= 0) continue; // faces away from the viewer
      const nx = m0 * qx + m1 * qy + m2 * qz;
      const ny = m3 * qx + m4 * qy + m5 * qz;
      const lam = nx * sx + ny * sy + nz * sz;
      let lit = lam > 0 ? lam * (0.5 + 0.62 * alb[i]) : 0;
      if (lit > 1) lit = 1;
      // shade is 1 minus light through a short smooth step, so the lit side clears to paper, the far side
      // fills evenly, and only a narrow band near the terminator is a random half tone
      let shade = (0.8 - lit) * 2;
      if (shade <= 0) shade = 0;
      else if (shade >= 1) shade = 1;
      else shade = shade * shade * (3 - 2 * shade);
      const ci = cIdx[i];
      if (ci >= 0 && shade < 0.95) {
        // cast shadow: walk from the dot toward the sun across the floor to the rim. If the floor is
        // still below the rim there, the rim hides the sun.
        const t = crTan[ci];
        const lx = cq[i * 2];
        const ly = cq[i * 2 + 1];
        const x2 = lx * lx + ly * ly;
        const qs = lx * crHx[ci] + ly * crHy[ci];
        const reach = -qs + Math.sqrt(Math.max(0, qs * qs - x2 + 1));
        if (t < 0 || depth * (1 - x2) > reach * t) shade = 0.95;
      }
      let a;
      let s;
      if (shade > rnd[i]) {
        a = 0.12 + 0.3 * shade;
        s = 1.1 + 0.45 * shade;
      } else if (nz < 0.2 && rnd2[i] < 0.6) {
        a = 0.15; // faint dotted outline at the lit edge
        s = 1.05;
      } else if (rnd2[i] < 0.15) {
        a = 0.08; // thin scatter on the lit side
        s = 1.1;
      } else continue;
      const x = m0 * px + m1 * py + m2 * pz;
      const y = m3 * px + m4 * py + m5 * pz;
      if (a !== lastA) {
        ctx.globalAlpha = a;
        lastA = a;
      }
      ctx.fillRect(cx + x * k - s * 0.5, cy - y * k - s * 0.5, s, s);
    }

    if (axis) {
      // the rock's z axis in view is M's third column. Short dashes stand off each pole.
      const a0 = zTop + 0.07;
      const a1 = zTop + 0.3;
      const b0 = zBot - 0.07;
      const b1 = zBot - 0.3;
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(cx + m2 * a0 * k, cy - m5 * a0 * k);
      ctx.lineTo(cx + m2 * a1 * k, cy - m5 * a1 * k);
      ctx.moveTo(cx + m2 * b0 * k, cy - m5 * b0 * k);
      ctx.lineTo(cx + m2 * b1 * k, cy - m5 * b1 * k);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
    if (onFrame) onFrame(performance.now() - t0);
  }

  function loop(now) {
    if (!running) return;
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    update(dt);
    draw();
    raf = requestAnimationFrame(loop);
  }
  function start() {
    if (running || !visible || !body) return;
    if (reduce.matches) {
      draw();
      return;
    }
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  layout();
  new ResizeObserver(() => {
    if (!layout()) return;
    if (visible) start();
    if (!running) draw();
  }).observe(canvas);
  new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1].isIntersecting;
    if (visible) start();
    else stop();
  }).observe(canvas);
  reduce.addEventListener('change', () => {
    stop();
    start();
    draw();
  });
  // the label is drawn into the canvas, so draw it again once the mono font has loaded
  if (labelText && document.fonts && document.fonts.load) {
    document.fonts
      .load(LABEL_FONT)
      .then(() => {
        if (!side) return;
        renderStatic();
        if (!running) draw();
      })
      .catch(() => {});
  }
  draw();
}
