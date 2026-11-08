// Lunar strip. A full-width band of cratered ground drawn in ink dots, seen from a low camera that looks
// toward the horizon, like a LiDAR scan of the lunar surface printed on paper. It sits between two light
// sections as a divider. Written new for this page. Illustrative ground only, not a map of any real place.
//
// How it is drawn
// - The ground is a height field: gentle rolls plus seeded bowl craters with raised rims (the bowl and rim
//   profile of dotbody.js, laid on a plane). One seeded tile of craters repeats, bucketed into cells, so each
//   dot only checks the few craters near it.
// - Dots sit on scan rows fixed to the ground, so each row reads as a dotted line that dips into bowls and
//   rises over rims. Rows and the dots along them thin out with distance in nested levels: far ground is
//   sparser and fainter, and new rows fade in as the camera glides forward. A row's ground is worked out
//   once and kept until the row needs finer dots, so each frame only relights and projects.
// - Stipple shading: a dot is inked when its shade (1 minus its lit amount) passes its fixed random value,
//   so shadow is ink and lit ground stays mostly paper, with a faint scatter so the rows still read.
// - The sun is low and follows the pointer, from where the pointer is relative to the strip on screen.
//   Rims cast shadows into the bowls (worked out per crater from the rim height, no ray marching). Ground the
//   camera cannot see behind a rim is left blank, like the gaps in a real scan.
// - Optional: a small ink-dot Earth above the horizon, lit by the same sun, and a dotted signal path down to
//   the ground. One dot travels it at the speed of light, 1.28 s each way.
//
// Engineering: 2D canvas, device pixel ratio capped at 2, the dot count follows the canvas area (the spacing
// is fixed in css px), dots are batched into one path per alpha level, frames run only while the canvas is
// on screen, and prefers-reduced-motion gets one still frame that is redrawn on resize.

import { makeBody, rng } from './dotbody.js';
import { pointer, trackPointer } from './pointer.js';

const LIGHT_ONE_WAY_S = 1.28; // s, light time from Earth to the Moon, one way  {light_oneway_s}
const LABEL = `EARTH · ${LIGHT_ONE_WAY_S} s EACH WAY`;
const INK = '#0b0c0e';

// Camera and dot spacing. World units: the camera is 1 unit above the ground.
const HORIZON = 0.3; // horizon height, as a fraction of the canvas height from the top
const ASPECT = 3; // distance to the ground at the bottom edge, in camera heights (sets the foreshortening)
const FAR = 8; // farthest row drawn, as a multiple of that distance
const ROW_PX = 7.5; // css px between scan rows at the bottom edge
const ROW_EXP = 0.45; // rows close up toward the horizon: spacing on screen falls as (near / distance)^0.45
const COL_PX = 3; // css px between dots along a row at the bottom edge
const COL_EXP = 0.25; // and dots spread out toward the horizon: spacing rises as (distance / near)^0.25
const ROW_LEV = 2 - ROW_EXP; // so the world spacing of rows grows as distance^ROW_LEV
const COL_LEV = 1 + COL_EXP; // and of dots along a row as distance^COL_LEV

// Stipple tone
const SH_FLAT = 0.1; // shade of flat ground in full sun
const SH_GAIN = 0.9; // extra shade from slopes turned away from the sun and from cast shadow
const FAINT = 0.1; // alpha of the faint, evenly spaced dots that keep lit rows readable (every other dot)

// Crater tile
const TILE_X = 128;
const TILE_Y = 160;
const CELL = 2;
const NCX = TILE_X / CELL;
const NCY = TILE_Y / CELL;
const REACH = 1.55; // a crater's rim bump has died out by this many radii
const RIM_W = 0.22; // rim width, in crater radii
const INV_W2 = 1 / (RIM_W * RIM_W);

// Gentle rolls of the plain (heights in camera heights)
const A1 = 0.05;
const K1 = 0.42;
const K2 = 0.31;
const A2 = 0.025;
const K3 = 0.95;
const K4 = 0.6;

// Sine table for the rolls
const LUT_N = 4096;
const LUT_M = LUT_N - 1;
const LUT_K = LUT_N / (Math.PI * 2);
const LUT_Q = LUT_N / 4;
const SIN = new Float32Array(LUT_N);
for (let i = 0; i < LUT_N; i++) SIN[i] = Math.sin((i / LUT_N) * Math.PI * 2);

// Dots are batched by alpha: one path per alpha level is much cheaper than one fillRect per dot
const LEVELS = 16;
const A_LO = 0.02;
const A_HI = 0.5;

// Per-dot record kept for each row: world x, height, normal, stipple value, and the one crater that can
// shade or hide the dot (local position in crater radii, distance from its centre, rim rise, radius, rim height)
const F_X = 0;
const F_Z = 1;
const F_NX = 2;
const F_NY = 3;
const F_NZ = 4;
const F_RND = 5;
const F_PX = 6;
const F_PY = 7;
const F_LX = 8;
const F_RISE = 9;
const F_R = 10;
const F_H = 11;
const STRIDE = 12;

function makeField(seed) {
  const r = rng(seed);
  const cx = [];
  const cy = [];
  const cr = [];
  const cd = [];
  const ch = [];
  const add = (x, y, R) => {
    cx.push(((x % TILE_X) + TILE_X) % TILE_X);
    cy.push(((y % TILE_Y) + TILE_Y) % TILE_Y);
    cr.push(R);
    cd.push((0.18 + 0.08 * r()) * R); // bowl depth
    ch.push((0.05 + 0.03 * r()) * R); // rim height
  };
  // a few placed craters so the first view has a clear composition (the camera starts at x 0, y 0
  // looking along +y), then a seeded scatter: many small craters, fewer medium ones, a few large ones
  add(-1.6, 6.4, 1.0);
  add(2.2, 5.2, 0.42);
  add(7, 10.5, 1.3);
  add(-6.5, 8.5, 0.6);
  add(0.6, 4.6, 0.18);
  add(9, 6, 0.5);
  add(-9.5, 7.5, 0.9);
  const scatter = (count, rMin, rMax, pw) => {
    for (let k = 0; k < count; k++) {
      const R = rMin * Math.pow(rMax / rMin, Math.pow(r(), pw));
      add(r() * TILE_X, r() * TILE_Y, R);
    }
  };
  scatter(200, 0.8, 1.6, 1.5);
  scatter(520, 0.3, 0.7, 1.7);
  scatter(1700, 0.06, 0.22, 2);

  const n = cx.length;
  const cells = NCX * NCY;
  const counts = new Uint32Array(cells);
  const each = (k, fn) => {
    const reach = cr[k] * REACH;
    const i0 = Math.floor((cx[k] - reach) / CELL);
    const i1 = Math.floor((cx[k] + reach) / CELL);
    const j0 = Math.floor((cy[k] - reach) / CELL);
    const j1 = Math.floor((cy[k] + reach) / CELL);
    for (let j = j0; j <= j1; j++) {
      const jj = ((j % NCY) + NCY) % NCY;
      for (let i = i0; i <= i1; i++) fn(((i % NCX) + NCX) % NCX + jj * NCX);
    }
  };
  for (let k = 0; k < n; k++) each(k, (c) => counts[c]++);
  const start = new Uint32Array(cells + 1);
  for (let c = 0; c < cells; c++) start[c + 1] = start[c] + counts[c];
  const items = new Uint16Array(start[cells]);
  const fill = start.slice(0, cells);
  for (let k = 0; k < n; k++) each(k, (c) => { items[fill[c]++] = k; });
  return {
    CX: Float32Array.from(cx),
    CY: Float32Array.from(cy),
    CR: Float32Array.from(cr),
    CD: Float32Array.from(cd),
    CH: Float32Array.from(ch),
    REACH2: Float32Array.from(cr, (R) => (R * REACH) ** 2),
    start,
    items,
  };
}

const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const tz = (k) => (k === 0 ? 30 : 31 - Math.clz32(k & -k)); // trailing zero bits: the nesting level of row or dot k

function hash2(n, m) {
  let h = Math.imul(n ^ 0x2545f491, 0x9e3779b1) ^ Math.imul(m ^ 0x6a09e667, 0x85ebca77);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * Mount the lunar strip on a canvas. Starts everything and returns nothing.
 * opts.seed     crater layout seed (default 11)
 * opts.earth    draw the small Earth and the signal path (default true)
 * opts.label    draw the light-time label next to the Earth (default true, needs earth)
 * opts.side     'right' (default) or 'left': where the Earth sits
 * opts.speed    ground drift at the bottom edge, css px per second (default 6)
 * opts.density  dot density multiplier, 0.5 to 2 (default 1)
 * opts.timings  an array: if given, the ms of every draw call is pushed to it (for measuring)
 */
export function mountLunarStrip(canvas, opts = {}) {
  const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return;
  trackPointer();
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const { CX, CY, CR, CD, CH, REACH2, start: CSTART, items: CITEMS } = makeField(opts.seed != null ? opts.seed : 11);
  const showEarth = opts.earth !== false;
  const showLabel = showEarth && opts.label !== false;
  const side = opts.side === 'left' ? -1 : 1;
  const speedPx = opts.speed != null ? opts.speed : 6;
  const density = clamp(opts.density || 1, 0.5, 2);
  const timings = Array.isArray(opts.timings) ? opts.timings : null;

  // sun: azimuth from straight ahead (+ is to the right) and elevation, both in radians
  const AZ0 = -0.75 * 1.25; // before the first pointer move: from the upper left
  const EL0 = 0.3 + 0.12 * 0.6;
  let az = AZ0;
  let el = EL0;
  let azT = AZ0;
  let elT = EL0;

  let w = 1;
  let h = 1;
  let dpr = 1;
  let yh = 0;
  let G = 1;
  let f = 1;
  let dNear = ASPECT;
  let dMin = ASPECT;
  let dFar = ASPECT * FAR;
  let DY0 = 0.1;
  let DX0 = 0.1;
  let speedWorld = 0;
  let camY = 0;
  const camX = 0;
  let clock = 0;
  let last = 0;
  let earth = null;
  let earthR = 0;
  let ex = 0;
  let ey = 0;
  let rows = new Map();
  let frameNo = 0;

  // alpha buckets: x, y, size per dot
  const bucketN = new Uint32Array(LEVELS);
  const bucket = Array.from({ length: LEVELS }, () => new Float32Array(3 * 1024));
  const LSCALE = (LEVELS - 1) / (A_HI - A_LO);
  function grow(b) {
    const grown = new Float32Array(bucket[b].length * 2);
    grown.set(bucket[b]);
    bucket[b] = grown;
    return grown;
  }
  function flush() {
    for (let b = 0; b < LEVELS; b++) {
      const cnt = bucketN[b];
      if (!cnt) continue;
      const arr = bucket[b];
      ctx.globalAlpha = A_LO + ((A_HI - A_LO) * b) / (LEVELS - 1);
      ctx.beginPath();
      for (let i = 0; i < cnt * 3; i += 3) {
        const s = arr[i + 2];
        ctx.rect(arr[i] - s / 2, arr[i + 1] - s / 2, s, s);
      }
      ctx.fill();
      bucketN[b] = 0;
    }
  }

  function layout() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = Math.max(1, Math.round(r.width));
    h = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    yh = Math.round(h * HORIZON);
    G = Math.max(1, h - yh);
    f = ASPECT * G; // focal length in css px, so the bottom edge is ASPECT camera heights away
    dNear = ASPECT;
    dMin = dNear * 0.97;
    dFar = dNear * FAR;
    // finest spacings, needed at the bottom edge. Farther rows use every 2nd, 4th, 8th... of them
    DY0 = ((ROW_PX / density) * dMin * dMin) / f;
    DX0 = ((COL_PX / density) * dMin) / f;
    speedWorld = (speedPx * dNear * dNear) / f;
    rows = new Map();
    // Earth: a small disc in the sky on one side, sized to the strip
    const re = clamp(Math.round(h * 0.18) / 2, 9, 16);
    if (re !== earthR) {
      earthR = re;
      earth = makeBody({ n: Math.round(clamp(re * re * 2.2, 160, 560)), seed: 4, craters: 0, grain: 0 });
    }
    ex = w / 2 + side * w * (w < 700 ? 0.3 : 0.29);
    ey = Math.round(yh * 0.5);
  }

  function aimSun() {
    let u = -0.75;
    let v = 0.6;
    if (pointer.active) {
      const r = canvas.getBoundingClientRect();
      u = (pointer.cx - (r.left + r.width / 2)) / Math.max(1, r.width / 2);
      v = (r.top + r.height / 2 - pointer.cy) / Math.max(1, window.innerHeight * 0.5);
    }
    azT = clamp(u, -1.15, 1.15) * 1.25;
    elT = 0.3 + 0.12 * clamp(v, -1, 1);
  }

  // Work out one row's ground: every dot from mA to mB in steps of 2^L
  function buildRow(n, L, mA, mB, phase) {
    const yw = n * DY0;
    const step = 1 << L;
    const count = mB >= mA ? Math.floor((mB - mA) / step) + 1 : 0;
    const F = new Float32Array(count * STRIDE);
    const lev = new Int8Array(count);
    const flag = new Uint8Array(count); // 2: has a crater that can shade or hide it
    const rowS = Math.sin(K2 * yw + 0.4);
    const rowC = Math.cos(K2 * yw + 0.4);
    const ph2 = -K4 * yw + 2.1;
    let yt = yw % TILE_Y;
    if (yt < 0) yt += TILE_Y;
    const cellRow = ((yt / CELL) | 0) * NCX;
    const HX = TILE_X / 2;
    const HY = TILE_Y / 2;
    for (let i = 0; i < count; i++) {
      const m = mA + i * step;
      const lv = tz(m);
      const hs = hash2(n, m);
      const xw = (m + phase + ((hs & 1023) / 1024 - 0.5) * 0.3) * DX0;
      const a1 = (K1 * xw + 1.3) * LUT_K;
      const a2 = (K3 * xw + ph2) * LUT_K;
      const s1 = SIN[a1 & LUT_M];
      const c1 = SIN[(a1 + LUT_Q) & LUT_M];
      const s2 = SIN[a2 & LUT_M];
      const c2 = SIN[(a2 + LUT_Q) & LUT_M];
      let z = A1 * s1 * rowS + A2 * s2;
      let gx = A1 * K1 * c1 * rowS + A2 * K3 * c2;
      let gy = A1 * K2 * s1 * rowC - A2 * K4 * c2;
      let best = 0;
      let bpx = 0;
      let bpy = 0;
      let blx = 0;
      let bR = 0;
      let bH = 0;
      let xt = xw % TILE_X;
      if (xt < 0) xt += TILE_X;
      const cell = ((xt / CELL) | 0) + cellRow;
      const qB = CSTART[cell + 1];
      for (let q = CSTART[cell]; q < qB; q++) {
        const k = CITEMS[q];
        let dx = xt - CX[k];
        if (dx > HX) dx -= TILE_X;
        else if (dx < -HX) dx += TILE_X;
        let dy = yt - CY[k];
        if (dy > HY) dy -= TILE_Y;
        else if (dy < -HY) dy += TILE_Y;
        const r2 = dx * dx + dy * dy;
        if (r2 >= REACH2[k]) continue;
        const R = CR[k];
        const rr = Math.sqrt(r2) + 1e-9;
        const x = rr / R;
        const xm = x - 1;
        const rimE = Math.exp(-xm * xm * INV_W2);
        const Dk = CD[k];
        const Hk = CH[k];
        const inside = x < 1;
        const hp = (inside ? Dk * (x * x - 1) : 0) + Hk * rimE;
        z += hp;
        const slope = ((inside ? 2 * Dk * x : 0) - 2 * Hk * rimE * xm * INV_W2) / R; // dh/dr
        gx += (slope * dx) / rr;
        gy += (slope * dy) / rr;
        const rise = Hk - hp; // how far the rim crest stands above this point
        if (x < 1.5 && rise > best) {
          best = rise;
          bpx = dx / R;
          bpy = dy / R;
          blx = x;
          bR = R;
          bH = Hk;
        }
      }
      const nl = 1 / Math.sqrt(gx * gx + gy * gy + 1);
      const o = i * STRIDE;
      F[o + F_X] = xw;
      F[o + F_Z] = z;
      F[o + F_NX] = -gx * nl;
      F[o + F_NY] = -gy * nl;
      F[o + F_NZ] = nl;
      F[o + F_RND] = ((hs >>> 10) & 1023) / 1024;
      F[o + F_PX] = bpx;
      F[o + F_PY] = bpy;
      F[o + F_LX] = blx;
      F[o + F_RISE] = best;
      F[o + F_R] = bR;
      F[o + F_H] = bH;
      lev[i] = lv > 100 ? 100 : lv;
      flag[i] = best > 0 ? 2 : 0;
    }
    return { L, mA, mB, step, count, F, lev, flag };
  }

  function drawGround() {
    const ce = Math.cos(el);
    const se = Math.sin(el);
    const sa = Math.sin(az);
    const ca = Math.cos(az);
    const Lx = sa * ce;
    const Ly = ca * ce;
    const Lz = se;
    const tanE = se / ce;
    const invLz = 1 / Lz;
    const halfW = w / 2;
    const nA = Math.ceil((camY + dMin) / DY0);
    const nB = Math.floor((camY + dFar) / DY0);
    const bottomFade = h * 0.16;
    let drawn = 0;

    for (let n = nA; n <= nB; n++) {
      const lr = Math.log2((n * DY0 - camY) / dMin);
      const wr = (tz(n) + 1 - ROW_LEV * lr - 0.1) / 0.9; // nested levels: this row fades in as it nears
      if (wr <= 0) continue;
      const yw = n * DY0;
      const d = yw - camY;
      const fd = f / d;
      const gyFlat = yh + fd;
      const u = (gyFlat - yh) / G; // 0 at the horizon, 1 at the bottom edge
      const rowA = (wr > 1 ? 1 : wr) * smooth01((u - 0.02) / 0.26) * smooth01((h - gyFlat) / bottomFade);
      if (rowA < 0.03) continue;
      const size = 1 + 0.5 * u;
      const mu = COL_LEV * lr;
      const L = mu > 0 ? Math.floor(mu) : 0;
      const step = 1 << L;
      const reachX = ((halfW + 4) * d) / f;
      const phase = (hash2(n, 0x51ed) / 4294967296) * 16; // shifts the whole row the same at every level, so dots do not line up in columns
      const mA = Math.ceil(((camX - reachX) / DX0 - phase) / step) * step;
      const mB = Math.floor(((camX + reachX) / DX0 - phase) / step) * step;
      let row = rows.get(n);
      if (!row || row.L !== L || row.mA > mA || row.mB < mB) {
        row = buildRow(n, L, mA, mB, phase);
        rows.set(n, row);
      }
      const { F, lev, flag } = row;
      const i0 = Math.max(0, Math.ceil((mA - row.mA) / step));
      const i1 = Math.min(row.count - 1, Math.floor((mB - row.mA) / step));
      const vyRow = camY - yw;
      for (let i = i0; i <= i1; i++) {
        const lv = lev[i];
        let wc = (lv + 1 - mu - 0.1) / 0.9;
        if (wc > 1) wc = 1;
        const fade = rowA * wc;
        if (fade < 0.04) continue; // too faint to ever pass the cut below
        const o = i * STRIDE;
        const xw = F[o + F_X];
        const z = F[o + F_Z];
        const nx = F[o + F_NX];
        const ny = F[o + F_NY];
        const nz = F[o + F_NZ];
        // faces turned away from the camera are not seen
        if (nx * (camX - xw) - ny * d + nz * (1 - z) <= 0) continue;
        let lit = (nx * Lx + ny * Ly + nz * Lz) * invLz;
        if (lit < 0) lit = 0;
        let vis = 1;
        const fl = flag[i];
        if (fl & 2) {
          const px = F[o + F_PX];
          const py = F[o + F_PY];
          const x = F[o + F_LX];
          const rise = F[o + F_RISE];
          const R = F[o + F_R];
          const inside = x < 1;
          const x2 = 1 - x * x;
          // toward the sun: is the rim crest in the way?
          const ps = px * sa + py * ca;
          const disc = ps * ps + x2;
          if (disc > 0) {
            const sq = Math.sqrt(disc);
            const tc = inside ? sq - ps : -ps - sq;
            if (tc > 0) {
              let sh = (rise - tc * R * tanE) / (0.08 * R) + 0.5;
              if (sh > 0) lit *= sh >= 1 ? 0 : 1 - sh;
            }
          }
          // toward the camera: the same test, so the ground behind a rim is left blank
          const vx = camX - xw + px * R;
          const vy = vyRow + py * R;
          const vl = Math.sqrt(vx * vx + vy * vy);
          const pv = (px * vx + py * vy) / vl;
          const disc2 = pv * pv + x2;
          if (disc2 > 0) {
            const sq2 = Math.sqrt(disc2);
            const tv = inside ? sq2 - pv : -pv - sq2;
            if (tv > 0) {
              const hv = (rise - (tv * R * (1 - F[o + F_H])) / vl) / (0.04 * R) + 0.5;
              if (hv >= 1) continue;
              if (hv > 0) vis = 1 - hv;
            }
          }
        }
        let shade = SH_FLAT + (1 - lit) * SH_GAIN;
        if (shade < 0) shade = 0;
        else if (shade > 1) shade = 1;
        // stipple: ink where the shade passes the dot's value (with a soft edge), a faint scatter elsewhere
        const over = (shade - F[o + F_RND]) * 12;
        let a = over > 0 ? (0.18 + 0.34 * shade) * (over > 1 ? 1 : over) : 0;
        // the coarser half of the dots carry an even faint tone, so every row reads as a clean dotted line
        const fw = lv - mu;
        if (fw > 0) {
          const base = FAINT * (fw > 1 ? 1 : fw) * (lit > 1 ? 2 - (lit > 1.6 ? 1.6 : lit) : 1);
          if (a < base) a = base;
        }
        a *= fade * vis;
        if (a < 0.02) continue;
        let b = ((a - A_LO) * LSCALE + 0.5) | 0;
        if (b >= LEVELS) b = LEVELS - 1;
        let arr = bucket[b];
        const k = bucketN[b] * 3;
        if (k + 3 > arr.length) arr = grow(b);
        arr[k] = halfW + (xw - camX) * fd;
        arr[k + 1] = yh + (1 - z) * fd;
        arr[k + 2] = shade > 0.7 && over > 1 ? size * 1.2 : size;
        bucketN[b]++;
        drawn++;
      }
    }
    // forget rows the camera has passed
    if (++frameNo % 90 === 0) for (const k of rows.keys()) if (k < nA) rows.delete(k);
    flush();
    return drawn;
  }

  function drawEarth() {
    const sa = Math.sin(az);
    const ca = Math.cos(az);
    const ce = Math.cos(el);
    const Lx = sa * ce;
    const Ly = ca * ce;
    const Lz = Math.sin(el);
    // view direction to the Earth (it is far away, so only its direction matters) and a screen frame for it
    let Ex = (ex - w / 2) / f;
    let Ey = 1;
    let Ez = (yh - ey) / f;
    const el2 = Math.hypot(Ex, Ey, Ez);
    Ex /= el2;
    Ey /= el2;
    Ez /= el2;
    const rl = Math.hypot(Ey, Ex);
    const Rx = Ey / rl;
    const Ry = -Ex / rl;
    const Ux = Ry * Ez;
    const Uy = -Rx * Ez;
    const Uz = Rx * Ey - Ry * Ex;
    const { n, nrm, rnd } = earth;
    const re = earthR;
    for (let i = 0; i < n; i++) {
      const nx = nrm[i * 3];
      const ny = nrm[i * 3 + 1];
      const nz = nrm[i * 3 + 2];
      const fe = nx * Ex + ny * Ey + nz * Ez;
      if (fe > 0) continue; // far side
      const lit = nx * Lx + ny * Ly + nz * Lz;
      const shade = lit > 0 ? 1 - Math.min(1, lit * 1.6) : 1;
      const over = (shade - rnd[i]) * 10;
      let a = over > 0 ? (0.1 + 0.22 * shade) * (over > 1 ? 1 : over) : 0;
      if (a < 0.08 && (i * 0.618034) % 1 < 0.15) a = 0.08;
      if (a < 0.012) continue;
      ctx.globalAlpha = a;
      const sx = ex + re * (nx * Rx + ny * Ry);
      const sy = ey - re * (nx * Ux + ny * Uy + nz * Uz);
      ctx.fillRect(sx - 0.6, sy - 0.6, 1.2, 1.2);
    }
    // a fine dotted rim keeps the disc round whatever its phase
    const ringN = Math.round(re * 2.4);
    ctx.globalAlpha = 0.2;
    for (let i = 0; i < ringN; i++) {
      const t = (i / ringN) * Math.PI * 2;
      ctx.fillRect(ex + Math.cos(t) * (re + 0.6) - 0.5, ey + Math.sin(t) * (re + 0.6) - 0.5, 1, 1);
    }
  }

  function drawSignal(still) {
    // a receiver on the ground, ahead of the camera and toward the middle, and a dotted path up to the Earth
    const tx = ex - side * Math.max(56, w * 0.07);
    const ty = yh + G * 0.42;
    let dx = tx - ex;
    let dy = ty - ey;
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
    const x0 = ex + dx * (earthR + 4);
    const y0 = ey + dy * (earthR + 4);
    const x1 = tx - dx * 3;
    const y1 = ty - dy * 3;
    const span = Math.hypot(x1 - x0, y1 - y0);
    const dots = Math.max(2, Math.floor(span / 4));
    ctx.globalAlpha = 0.26;
    for (let i = 0; i <= dots; i++) {
      const t = i / dots;
      ctx.fillRect(x0 + (x1 - x0) * t - 0.5, y0 + (y1 - y0) * t - 0.5, 1, 1);
    }
    ctx.globalAlpha = 0.5;
    ctx.fillRect(tx - 1, ty - 1, 2, 2);
    if (!still) {
      // one dot at the true speed: down in 1.28 s, back up in 1.28 s
      const ph = (clock % (2 * LIGHT_ONE_WAY_S)) / LIGHT_ONE_WAY_S;
      const t = ph < 1 ? ph : 2 - ph;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(x0 + (x1 - x0) * t - 1, y0 + (y1 - y0) * t - 1, 2, 2);
    }
    if (showLabel) {
      ctx.globalAlpha = 0.5;
      ctx.font = '500 10px "Geist Mono", ui-monospace, monospace';
      if ('letterSpacing' in ctx) ctx.letterSpacing = '1.2px';
      ctx.textBaseline = 'middle';
      ctx.textAlign = side > 0 ? 'right' : 'left';
      ctx.fillText(LABEL, Math.round(ex - side * (earthR + 12)), Math.round(ey) + 0.5);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }
  }

  function draw(now) {
    const t0 = performance.now();
    const still = reduce.matches;
    const dt = last ? clamp((now - last) / 1000, 0, 0.1) : 0;
    last = now;
    if (still) {
      az = AZ0;
      el = EL0;
    } else {
      clock += dt;
      camY += speedWorld * dt;
      aimSun();
      const k = 1 - Math.exp(-dt / 0.35);
      az += (azT - az) * k;
      el += (elT - el) * k;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    let drawn = 0;
    if (h >= 24 && w >= 24) {
      ctx.fillStyle = INK;
      drawn = drawGround();
      if (showEarth && earth) {
        drawEarth();
        drawSignal(still);
      }
      ctx.globalAlpha = 1;
    }
    if (timings) {
      timings.push(performance.now() - t0);
      timings.dots = drawn;
    }
  }

  let running = false;
  let visible = false;
  let raf = 0;
  function loop(now) {
    if (!running) return;
    draw(now);
    raf = requestAnimationFrame(loop);
  }
  function startLoop() {
    if (running || !visible) return;
    if (reduce.matches) {
      draw(performance.now());
      return;
    }
    running = true;
    last = 0;
    raf = requestAnimationFrame(loop);
  }
  function stopLoop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  layout();
  draw(performance.now());
  new ResizeObserver(() => {
    layout();
    draw(performance.now());
  }).observe(canvas);
  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (visible) startLoop();
    else stopLoop();
  }).observe(canvas);
  reduce.addEventListener('change', () => {
    stopLoop();
    startLoop();
    draw(performance.now());
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => draw(performance.now()));
}
