// Dot bodies. The Moon, the planets and the asteroids on this page are clouds of dots, like the robot.
// This file only makes the dots, it draws nothing: seeded points over a sphere or a lumpy rock, each with
// a surface normal and a brightness, so a renderer can light every dot from a sun direction.
// Craters bend the normals (a bowl whose inner walls face its centre, then a raised rim) and change the
// brightness (bright rims, slightly darker floors). Dark patches ("maria") and planet bands lower the
// brightness over broad areas. Everything is seeded, so a body looks the same on every visit.
// Illustrative shapes only: no real map of the Moon or any asteroid is used.

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randUnit(r) {
  const z = r() * 2 - 1;
  const a = r() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  return [s * Math.cos(a), s * Math.sin(a), z];
}

/**
 * makeBody(opts) returns { n, pos, nrm, alb, rnd }:
 *   pos  Float32Array(3n)  a dot on the surface (radius about 1)
 *   nrm  Float32Array(3n)  unit surface normal there, crater slopes included
 *   alb  Float32Array(n)   brightness 0..1 before lighting
 *   rnd  Float32Array(n)   a fixed 0..1 value per dot; renderers show a dot when its light passes it,
 *                          so dark areas have fewer dots (density changes, like a halftone)
 * opts: n (dots), seed, craters (count), rMin and rMax (crater radius in radians of arc), depth (slope scale),
 *   maria (dark patches), bands (planet bands, 0 for none), lumps and lumpAmp (big bumps for rocks),
 *   ridge (an equator ridge, like Bennu's spinning-top shape), squash (z scale), grain (brightness noise),
 *   base (mean brightness), layout ('even' spreads dots evenly; 'rings' lines them up along circles of
 *   latitude, like a scan, which reads as a 3D sphere at a glance)
 */
export function makeBody(opts = {}) {
  const {
    n = 6000,
    seed = 1,
    craters = 60,
    rMin = 0.03,
    rMax = 0.3,
    depth = 1,
    maria = 0,
    bands = 0,
    lumps = 0,
    lumpAmp = 0.12,
    ridge = 0,
    squash = 1,
    grain = 0.06,
    base = 0.82,
    layout = 'even',
  } = opts;
  const r = rng(seed);

  const cr = [];
  for (let k = 0; k < craters; k++) {
    const c = randUnit(r);
    const rad = rMin * Math.pow(rMax / rMin, Math.pow(r(), 2.4)); // many small craters, a few large ones
    cr.push({
      c,
      rad,
      cosOut: Math.cos(Math.min(Math.PI, rad * 1.7)),
      d: 0.24 * depth, // bowl depth, in crater radii
      rim: 0.075 * depth, // rim height, in crater radii
      fresh: r(),
    });
  }
  // index the craters by height band, so each dot only checks the craters that can reach it:
  // a dot within angle e of a crater centre is within e of it in y as well
  const BANDS = 64;
  const band = Array.from({ length: BANDS }, () => []);
  for (const C of cr) {
    const e = C.rad * 1.7;
    const lo = Math.max(0, Math.floor(((C.c[1] - e + 1) / 2) * BANDS));
    const hi = Math.min(BANDS - 1, Math.floor(((C.c[1] + e + 1) / 2) * BANDS));
    for (let k = lo; k <= hi; k++) band[k].push(C);
  }
  const mar = [];
  for (let k = 0; k < maria; k++) mar.push({ c: randUnit(r), rad: 0.22 + r() * 0.42, amt: 0.16 + r() * 0.2 });
  const lmp = [];
  for (let k = 0; k < lumps; k++) lmp.push({ c: randUnit(r), w: 0.12 + r() * 0.35, a: (r() * 2 - 1) * lumpAmp });
  const bandPhase = r() * 6.28;

  const dirs = layout === 'rings' ? ringDirs(n, r) : evenDirs(n, r);
  const count = dirs.length / 3;
  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  const alb = new Float32Array(count);
  const rnd = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const px = dirs[i * 3];
    const py = dirs[i * 3 + 1];
    const pz = dirs[i * 3 + 2];

    // shape: radius R(p) = 1 + bumps + ridge, and its slope along the surface for the normal
    let R = 1;
    let gx = 0;
    let gy = 0;
    let gz = 0;
    for (const L of lmp) {
      const cd = px * L.c[0] + py * L.c[1] + pz * L.c[2];
      const g = L.a * Math.exp(-(1 - cd) / L.w);
      R += g;
      const k = g / L.w;
      gx += k * L.c[0];
      gy += k * L.c[1];
      gz += k * L.c[2];
    }
    if (ridge) {
      const e = Math.exp(-(pz * pz) / 0.018);
      R += ridge * e;
      gz += ridge * e * ((-2 * pz) / 0.018);
    }
    const gd = gx * px + gy * py + gz * pz;
    gx -= px * gd;
    gy -= py * gd;
    gz -= pz * gd;
    let nx = px - gx / R;
    let ny = py - gy / R;
    let nz = pz - gz / R;

    let a = base + (r() - 0.5) * 2 * grain;
    if (bands) {
      const w = Math.sin(pz * bands * Math.PI + bandPhase + 0.7 * Math.sin(pz * 9 + bandPhase));
      a += 0.15 * w;
    }

    // craters: height h(x) = d (x^2 - 1) inside the bowl plus a rim bump, x = distance / crater radius.
    // The normal tilts by the slope dh/dx toward the crater centre (inner walls) or away (outer rim).
    const near = band[Math.min(BANDS - 1, Math.max(0, Math.floor(((py + 1) / 2) * BANDS)))];
    for (const C of near) {
      const cd = px * C.c[0] + py * C.c[1] + pz * C.c[2];
      if (cd < C.cosOut) continue;
      const x = Math.acos(Math.min(1, cd)) / C.rad;
      let ux = C.c[0] - px * cd;
      let uy = C.c[1] - py * cd;
      let uz = C.c[2] - pz * cd;
      const ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-6) continue;
      ux /= ul;
      uy /= ul;
      uz /= ul;
      const rimE = Math.exp(-(((x - 1) / 0.2) ** 2));
      const slope = (x < 1 ? 2 * C.d * x : 0) + C.rim * rimE * ((-2 * (x - 1)) / 0.04);
      nx += slope * ux;
      ny += slope * uy;
      nz += slope * uz;
      a += 0.14 * rimE * (0.4 + 0.6 * C.fresh);
      if (x < 1) a -= 0.05 * (1 - x * x);
      else if (C.fresh > 0.8) a += 0.06 * Math.exp(-(x - 1) / 0.35);
    }
    for (const M of mar) {
      const cd = px * M.c[0] + py * M.c[1] + pz * M.c[2];
      const ang = Math.acos(Math.max(-1, Math.min(1, cd)));
      if (ang > M.rad * 1.35) continue;
      const t = Math.min(1, Math.max(0, (M.rad * 1.35 - ang) / (M.rad * 0.65)));
      a -= M.amt * t * t * (3 - 2 * t);
    }

    pos[i * 3] = px * R;
    pos[i * 3 + 1] = py * R;
    pos[i * 3 + 2] = pz * R * squash;
    nz /= squash;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nrm[i * 3] = nx / nl;
    nrm[i * 3 + 1] = ny / nl;
    nrm[i * 3 + 2] = nz / nl;
    alb[i] = Math.max(0.05, Math.min(1, a));
    rnd[i] = r();
  }
  return { n: count, pos, nrm, alb, rnd };
}

// an even spread over the sphere (Fibonacci lattice) with a little jitter, so no rows or spirals show
function evenDirs(n, r) {
  const out = new Float32Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z0 = 1 - (2 * (i + 0.5)) / n;
    const pz = Math.max(-1, Math.min(1, z0 + (r() - 0.5) * (2 / n)));
    const ring = Math.sqrt(Math.max(0, 1 - pz * pz));
    const th = golden * i + (r() - 0.5) * 0.4;
    out[i * 3] = ring * Math.cos(th);
    out[i * 3 + 1] = ring * Math.sin(th);
    out[i * 3 + 2] = pz;
  }
  return out;
}

// about n dots on circles of latitude (poles on the y axis), evenly spaced along each circle
function ringDirs(n, r) {
  const rings = Math.max(8, Math.round(Math.sqrt((n * Math.PI) / 4)));
  const perEquator = Math.max(8, Math.round((n * Math.PI) / (2 * rings)));
  const out = [];
  for (let k = 0; k < rings; k++) {
    const lat = -Math.PI / 2 + (Math.PI * (k + 0.5)) / rings;
    const cl = Math.cos(lat);
    const m = Math.max(3, Math.round(perEquator * cl));
    const phase = r() * Math.PI * 2;
    for (let j = 0; j < m; j++) {
      const lon = phase + (Math.PI * 2 * j) / m;
      out.push(cl * Math.cos(lon), Math.sin(lat), cl * Math.sin(lon));
    }
  }
  return new Float32Array(out);
}

/**
 * makeRing(opts) returns the same shape as makeBody: dots on a flat ring in the z = 0 plane (normal +z),
 * between inner and outer radii, with denser and thinner bands and one clear gap.
 */
export function makeRing(opts = {}) {
  const { n = 3000, seed = 3, inner = 1.35, outer = 2.25, gap = 0.62 } = opts;
  const r = rng(seed);
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const alb = new Float32Array(n);
  const rnd = new Float32Array(n);
  let i = 0;
  let guard = 0;
  while (i < n && guard++ < n * 40) {
    const u = r();
    const rr = Math.sqrt(inner * inner + u * (outer * outer - inner * inner));
    const f = (rr - inner) / (outer - inner);
    let dens = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(f * 31 + Math.sin(f * 7) * 2));
    if (Math.abs(f - gap) < 0.035) dens = 0.03;
    if (r() > dens) continue;
    const ang = r() * Math.PI * 2;
    pos[i * 3] = rr * Math.cos(ang);
    pos[i * 3 + 1] = rr * Math.sin(ang);
    pos[i * 3 + 2] = (r() - 0.5) * 0.01;
    nrm[i * 3 + 2] = 1;
    alb[i] = 0.45 + 0.4 * dens;
    rnd[i] = r();
    i++;
  }
  return { n: i, pos: pos.subarray(0, i * 3), nrm: nrm.subarray(0, i * 3), alb: alb.subarray(0, i), rnd: rnd.subarray(0, i) };
}
