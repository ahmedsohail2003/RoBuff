// Point-cloud robot. Reads a motion clip (contract in DESIGN_SPEC.md) and draws it as white dots
// with a depth scan band and corner-bracket labels. Label values come only from the clip's `measured` block.
// The clip is site/assets/motion/pick.json, recorded from the app's own lift test (see its README.md).
// If it cannot be loaded, the canvas stays empty (the grid background still shows) and nothing is claimed.

const MOTION_URLS = ['assets/motion/pick.json'];
let clipPromise = null;

export function loadClip() {
  if (!clipPromise) {
    clipPromise = (async () => {
      for (const url of MOTION_URLS) {
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const clip = await res.json();
          if (clip && Array.isArray(clip.bodies) && Array.isArray(clip.frames) && clip.frames.length) {
            return prepare(clip, url);
          }
        } catch {
          // try the next file
        }
      }
      return null;
    })();
  }
  return clipPromise;
}

function prepare(clip, url) {
  const yUp = clip.meta && clip.meta.up === 'y';
  const toZUp = (p) => (yUp ? [p[0], -p[2], p[1]] : p);
  const bodies = clip.bodies.map((b) => {
    const pts = new Float32Array(b.points.length * 3);
    b.points.forEach((p, i) => {
      const q = toZUp(p);
      pts[i * 3] = q[0];
      pts[i * 3 + 1] = q[1];
      pts[i * 3 + 2] = q[2];
    });
    return { name: b.name, pts };
  });
  const frames = clip.frames.map((f) => ({
    t: f.t,
    poses: f.poses.map((p) => {
      const pos = toZUp(p.slice(0, 3));
      let q = p.slice(3, 7);
      if (yUp) q = [q[0], q[1], -q[3], q[2]];
      return [pos[0], pos[1], pos[2], q[0], q[1], q[2], q[3]];
    }),
  }));
  const fps = (clip.meta && clip.meta.fps) || 30;
  const duration = frames[frames.length - 1].t || frames.length / fps;
  const rockIndex = bodies.length - 1;
  let jawIndex = bodies.findIndex((b) => /fixed_?jaw/i.test(b.name));
  if (jawIndex < 0) jawIndex = bodies.findIndex((b) => /jaw|grip/i.test(b.name));
  if (jawIndex < 0) jawIndex = Math.max(0, rockIndex - 1);

  // Fit: centre and size from every frame's world points (subsampled) so the whole clip stays in view.
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  const tmp = [0, 0, 0];
  const step = Math.max(1, Math.floor(frames.length / 12));
  for (let k = 0; k < frames.length; k += step) {
    bodies.forEach((b, i) => {
      const pose = frames[k].poses[i];
      for (let j = 0; j < b.pts.length; j += 9) {
        transform(pose, b.pts, j, tmp);
        for (let a = 0; a < 3; a++) {
          if (tmp[a] < min[a]) min[a] = tmp[a];
          if (tmp[a] > max[a]) max[a] = tmp[a];
        }
      }
    });
  }
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 1;
  const rockRestZ = frames[0].poses[rockIndex] ? frames[0].poses[rockIndex][2] : 0;
  const m = clip.measured || {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    url,
    bodies,
    frames,
    fps,
    duration,
    rockIndex,
    jawIndex,
    center,
    floorZ: min[2],
    radius,
    rockRestZ,
    measured: {
      mass: num(m.rock_mass_g),
      rise: num(m.rock_rise_mm),
      width: num(m.rock_width_mm),
      held: num(m.held_s),
    },
    holdTime: findHoldTime(clip, frames, rockIndex),
  };
}

function findHoldTime(clip, frames, rockIndex) {
  const ev = (clip.events || []).find((e) => /hold|lifted/i.test(e.label));
  if (ev) return ev.t;
  let best = 0;
  let bestZ = -Infinity;
  frames.forEach((f) => {
    const z = f.poses[rockIndex] ? f.poses[rockIndex][2] : 0;
    if (z > bestZ) {
      bestZ = z;
      best = f.t;
    }
  });
  return best;
}

// Rotate local point j of pts by pose quaternion (w, x, y, z) and add its position.
function transform(pose, pts, j, out) {
  const px = pts[j];
  const py = pts[j + 1];
  const pz = pts[j + 2];
  const w = pose[3];
  const x = pose[4];
  const y = pose[5];
  const z = pose[6];
  const tx = 2 * (y * pz - z * py);
  const ty = 2 * (z * px - x * pz);
  const tz = 2 * (x * py - y * px);
  out[0] = px + w * tx + (y * tz - z * ty) + pose[0];
  out[1] = py + w * ty + (z * tx - x * tz) + pose[1];
  out[2] = pz + w * tz + (x * ty - y * tx) + pose[2];
}

function lerpPose(a, b, u, out) {
  for (let i = 0; i < 3; i++) out[i] = a[i] + (b[i] - a[i]) * u;
  let dot = a[3] * b[3] + a[4] * b[4] + a[5] * b[5] + a[6] * b[6];
  const s = dot < 0 ? -1 : 1;
  let n = 0;
  for (let i = 3; i < 7; i++) {
    out[i] = a[i] + (s * b[i] - a[i]) * u;
    n += out[i] * out[i];
  }
  n = Math.sqrt(n) || 1;
  for (let i = 3; i < 7; i++) out[i] /= n;
  return out;
}

/**
 * Mount a point-cloud view on a canvas.
 * opts.anchor: [x, y] fraction of the canvas where the scene centre goes.
 * opts.size: scene height as a fraction of the canvas height.
 * opts.labels: draw corner-bracket labels.
 */
export async function mountCloud(canvas, opts = {}) {
  const clip = await loadClip();
  if (!clip) return;
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const anchorFn = typeof opts.anchor === 'function' ? opts.anchor : () => opts.anchor || [0.65, 0.55];
  const sizeFn = typeof opts.size === 'function' ? opts.size : () => opts.size || 0.7;
  const labels = opts.labels !== false;
  const density = opts.density || 1;
  const alphaFn = typeof opts.alpha === 'function' ? opts.alpha : () => opts.alpha || 1;
  const PAUSE = 1.4;
  const loopLen = clip.duration + PAUSE;
  const poses = clip.bodies.map(() => new Float64Array(7));
  const tmp = [0, 0, 0];
  const floor = makeFloor(clip);

  let w = 0;
  let h = 0;
  let dpr = 1;
  let running = false;
  let visible = true;
  let raf = 0;
  const start = performance.now() - (opts.offset || 0) * 1000;

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = Math.max(1, Math.round(r.width));
    h = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  function posesAt(t) {
    const f = clip.frames;
    const fi = Math.min(f.length - 1, Math.max(0, t * clip.fps));
    const i0 = Math.floor(fi);
    const i1 = Math.min(f.length - 1, i0 + 1);
    const u = fi - i0;
    for (let b = 0; b < poses.length; b++) {
      const a = f[i0].poses[b];
      const c = f[i1].poses[b] || a;
      if (a) lerpPose(a, c, u, poses[b]);
    }
  }

  function draw(now) {
    const time = (now - start) / 1000;
    const clipT = reduce.matches ? clip.holdTime : Math.min(clip.duration, time % loopLen);
    posesAt(clipT);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const fade = alphaFn(w, h);

    const [ax, ay] = anchorFn(w, h);
    // three-quarter view from the side of the reach, swaying gently
    const baseYaw = opts.yaw != null ? opts.yaw : -1.05;
    const yaw = reduce.matches ? baseYaw : baseYaw + Math.sin(time * 0.16) * (opts.sway != null ? opts.sway : 0.45);
    const pitch = 0.42;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const R = clip.radius;
    const camDist = R * 4.2;
    const focal = (sizeFn(w, h) * h) / (2 * R) * camDist / 1;
    const ox = ax * w;
    const oy = ay * h;
    const c = clip.center;
    // scan band: sweeps through depth from near to far
    const scanPos = reduce.matches ? 0.2 : ((time * 0.28) % 1.6) - 0.3;

    const project = (x, y, z, out) => {
      const X = x - c[0];
      const Y = y - c[1];
      const Z = z - c[2];
      const rx = X * cy - Y * sy;
      const ry = X * sy + Y * cy; // depth axis before tilt
      const dz = ry * cp + Z * sp;
      const uz = -ry * sp + Z * cp;
      const d = camDist + dz;
      out[0] = ox + (rx * focal) / d;
      out[1] = oy - (uz * focal) / d;
      out[2] = (dz / R + 1) / 2; // 0 near, 1 far
      out[3] = focal / d;
    };
    const p = [0, 0, 0, 0];
    // optional horizontal fade so dots behind body text stay faint: [from, to, floor] as fractions of width
    const xFade = opts.xFade ? opts.xFade(w, h) : null;
    const xFadeAt0 = (x) => {
      const u = (x / w - xFade[0]) / (xFade[1] - xFade[0]);
      return Math.max(xFade[2], Math.min(1, u));
    };
    // optional text mask: rectangles (canvas px) over readable text; dots inside drop to `floor` alpha,
    // with a soft edge, so the scene can sit behind the copy without hurting it
    const mask = opts.mask ? opts.mask(w, h) : null;
    const maskAt = (x, y) => {
      let m = 1;
      for (const r of mask.rects) {
        const dx = Math.max(r[0] - x, 0, x - r[2]);
        const dy = Math.max(r[1] - y, 0, y - r[3]);
        const dist = Math.hypot(dx, dy);
        if (dist < mask.soft) m = Math.min(m, mask.floor + (1 - mask.floor) * (dist / mask.soft));
      }
      return m;
    };
    const xFadeAt = (x, y) => (xFade ? xFadeAt0(x) : 1) * (mask ? maskAt(x, y) : 1);

    // floor dots
    ctx.fillStyle = '#fff';
    for (let i = 0; i < floor.length; i += 2) {
      project(floor[i], floor[i + 1], clip.floorZ, p);
      const a = 0.16 * (1 - p[2] * 0.7) * fade * (xFade || mask ? xFadeAt(p[0], p[1]) : 1);
      if (a <= 0.01) continue;
      ctx.globalAlpha = a;
      ctx.fillRect(p[0], p[1], 1, 1);
    }

    const boxes = [];
    for (let b = 0; b < clip.bodies.length; b++) {
      const body = clip.bodies[b];
      const pose = poses[b];
      const isRock = b === clip.rockIndex;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let j = 0; j < body.pts.length; j += 3) {
        if (density < 1 && ((j / 3) % Math.round(1 / density)) !== 0) continue;
        transform(pose, body.pts, j, tmp);
        project(tmp[0], tmp[1], tmp[2], p);
        const depth = p[2];
        const scan = Math.max(0, 1 - Math.abs(depth - scanPos) / 0.06);
        let a = 0.85 - depth * 0.6 + scan * 0.5;
        if (isRock) a += 0.15;
        a = Math.min(1, Math.max(0.08, a));
        const s = (scan > 0.3 ? 2 : depth < 0.45 ? 1.6 : 1.2);
        ctx.globalAlpha = a * fade * (xFade || mask ? xFadeAt(p[0], p[1]) : 1);
        ctx.fillRect(p[0] - s / 2, p[1] - s / 2, s, s);
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
      }
      boxes[b] = [minX, minY, maxX, maxY];
    }
    ctx.globalAlpha = Math.max(0.5, fade);

    if (labels) {
      const m = clip.measured;
      const rockBox = boxes[clip.rockIndex];
      // labels never sit over the masked text: if the rock's labels would, they are dimmed to the mask floor
      if (mask && rockBox && Number.isFinite(rockBox[0])) {
        const lx0 = rockBox[0] - 90;
        const lx1 = rockBox[2] + 12;
        const ly0 = rockBox[1] - 12;
        const ly1 = rockBox[3] + 52;
        const over = mask.rects.some((r) => lx0 < r[2] && lx1 > r[0] && ly0 < r[3] && ly1 > r[1]);
        ctx.globalAlpha = over ? mask.floor : Math.max(0.5, fade);
      }
      const rockZ = poses[clip.rockIndex][2];
      const up = rockZ - clip.rockRestZ > clip.radius * 0.08;
      const alignRight = opts.labelAlign === 'right';
      if (rockBox) bracket(ctx, rockBox, m.mass != null ? `SAMPLE · ${fmt(m.mass)} g` : 'SAMPLE', 'below', false, alignRight);
      const jawBox = boxes[clip.jawIndex];
      const jawLabel = typeof opts.jawLabel === 'function' ? opts.jawLabel(w, h) : opts.jawLabel !== false;
      if (jawBox && jawLabel) {
        // the jaw closes around the rock, so its label goes on the far side, at the top
        tagAt(ctx, jawBox[0] - 12 - textWidth(ctx, 'JAW'), jawBox[1] + 4, 'JAW');
        tick(ctx, jawBox[0] - 2, jawBox[1], -1);
      }
      if (up && rockBox) {
        const txt = m.rise != null ? `LIFT · ${fmt(m.rise)} mm` : 'LIFT';
        tagAt(ctx, alignRight ? rockBox[2] + 10 - textWidth(ctx, txt) : rockBox[0] - 10, rockBox[3] + 10 + 30, txt);
      }
      if (opts.cornerTag !== false) {
        ctx.font = '500 10px "Geist Mono", ui-monospace, monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        const tag = 'SIMULATION';
        const tw = ctx.measureText(tag).width;
        let tx = w - tw - 20;
        let ty = h - 18;
        if (opts.cornerTag === 'scene') {
          // top-right corner of the drawn scene
          let x1 = -Infinity;
          let y0 = Infinity;
          boxes.forEach((b) => {
            if (b && Number.isFinite(b[2])) {
              x1 = Math.max(x1, b[2]);
              y0 = Math.min(y0, b[1]);
            }
          });
          if (Number.isFinite(x1)) {
            tx = Math.min(w - tw - 8, x1 - tw);
            ty = Math.max(opts.minTagY || 14, y0 - 12);
          }
        }
        ctx.fillText(tag, Math.round(tx), Math.round(ty));
      }
    }
    ctx.globalAlpha = 1;
  }

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
    raf = requestAnimationFrame(loop);
  }
  function stopLoop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  resize();
  new ResizeObserver(() => {
    resize();
    if (!running) draw(performance.now());
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
  draw(performance.now());
  startLoop();
}

function fmt(v) {
  if (Math.abs(v) >= 10) return String(Math.round(v));
  return String(Math.round(v * 10) / 10);
}

function makeFloor(clip) {
  const out = [];
  const R = clip.radius * 1.6;
  const stepXY = clip.radius / 7;
  const cx = clip.center[0];
  const cy = clip.center[1];
  for (let x = -R; x <= R; x += stepXY) {
    for (let y = -R; y <= R; y += stepXY) {
      if (x * x + y * y > R * R) continue;
      out.push(cx + x, cy + y);
    }
  }
  return out;
}

function bracket(ctx, box, text, where, small, alignRight) {
  const pad = small ? 6 : 10;
  const x0 = box[0] - pad;
  const y0 = box[1] - pad;
  const x1 = box[2] + pad;
  const y1 = box[3] + pad;
  const L = 7;
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y0 + L); ctx.lineTo(x0, y0); ctx.lineTo(x0 + L, y0);
  ctx.moveTo(x1 - L, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + L);
  ctx.moveTo(x1, y1 - L); ctx.lineTo(x1, y1); ctx.lineTo(x1 - L, y1);
  ctx.moveTo(x0 + L, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - L);
  ctx.stroke();
  tagAt(ctx, alignRight ? x1 - textWidth(ctx, text) : x0, where === 'above' ? y0 - 8 : y1 + 16, text);
}

function textWidth(ctx, text) {
  ctx.font = '500 10.5px "Geist Mono", ui-monospace, monospace';
  return ctx.measureText(text).width;
}

function tick(ctx, x, y, dir = 1) {
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.beginPath();
  ctx.moveTo(x, y + 6);
  ctx.lineTo(x, y);
  ctx.lineTo(x + 6 * dir, y);
  ctx.stroke();
}

function tagAt(ctx, x, y, text) {
  ctx.font = '500 10.5px "Geist Mono", ui-monospace, monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.fillText(text, Math.round(x), Math.round(y));
}
