// Halftone image: horizontal scanline bars whose thickness follows the brightness of the screenshot's
// subject (the app's plain backdrop is removed first), revealed row by row, with a sharp lens under the pointer.

const CELL_W = 2; // css px per cell, horizontally
const ROW_H = 4; // css px per row
const LENS = 110; // lens radius in css px
const REVEAL_MS = 1600;

export function mountHalftone(canvas) {
  const src = canvas.dataset.src;
  const crop = (canvas.dataset.crop || '0,0,1,1').split(',').map(Number);
  // On the wide card the image is fitted into this box (fractions of the canvas: x0,y0,x1,y1), so the
  // step's subject sits above the copy and left of the mini panel instead of under them.
  const place = (canvas.dataset.place || '0,0,1,1').split(',').map(Number);
  // The step's subject (the cube or the rock), as fractions of the whole image: its bars are drawn
  // brighter than the rest, so each card reads as one object.
  const focus = canvas.dataset.focus ? canvas.dataset.focus.split(',').map(Number) : null;
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const img = new Image();
  img.decoding = 'async';
  img.src = src;

  const layer = document.createElement('canvas');
  const lctx = layer.getContext('2d');
  let w = 0;
  let h = 0;
  let dpr = 1;
  let values = null;
  let hi = null;
  let cols = 0;
  let rows = 0;
  let revealStart = 0;
  let revealedRows = 0;
  let pointer = null;
  let raf = 0;
  let ready = false;
  let entered = false;
  // where the cropped image lands inside the canvas (cover fit)
  let dest = { x: 0, y: 0, w: 0, h: 0 };

  function sourceRect() {
    return {
      sx: crop[0] * img.naturalWidth,
      sy: crop[1] * img.naturalHeight,
      sw: crop[2] * img.naturalWidth,
      sh: crop[3] * img.naturalHeight,
    };
  }

  // The app's screenshots show the arm on a plain backdrop: a pale sky, a grey floor, darker grid lines
  // and soft floor shadows, all cool greys (blue a little above red). The arm's shells are neutral
  // white-grey, its servos near black, the test cube red and the rock dark. So: flood-fill the
  // cool-grey backdrop in from the crop's border, keep what it cannot reach (the arm, cube or rock),
  // and turn that into bar strength, brightest where the subject is bright, with the step's object
  // (data-focus) forced bright. Built once per image at its own resolution.
  let subject = null;
  function buildSubject() {
    const { sx, sy, sw, sh } = sourceRect();
    const W = Math.max(1, Math.round(sw));
    const H = Math.max(1, Math.round(sh));
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
    const im = g.getImageData(0, 0, W, H);
    const d = im.data;
    const N = W * H;
    const backdrop = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const r = d[i * 4];
      const gg = d[i * 4 + 1];
      const b = d[i * 4 + 2];
      const t = b - r;
      backdrop[i] = t >= 6 && t <= 24 && b >= gg && gg >= r && b > 90 ? 1 : 0;
    }
    const outside = new Uint8Array(N);
    const queue = new Int32Array(N);
    let qh = 0;
    let qt = 0;
    const seed = (i) => {
      if (backdrop[i] && !outside[i]) {
        outside[i] = 1;
        queue[qt++] = i;
      }
    };
    for (let x = 0; x < W; x++) {
      seed(x);
      seed((H - 1) * W + x);
    }
    for (let y = 0; y < H; y++) {
      seed(y * W);
      seed(y * W + W - 1);
    }
    while (qh < qt) {
      const i = queue[qh++];
      const x = i % W;
      if (x > 0) seed(i - 1);
      if (x < W - 1) seed(i + 1);
      if (i >= W) seed(i - W);
      if (i < N - W) seed(i + W);
    }
    const fx0 = focus ? focus[0] * img.naturalWidth - sx : -1;
    const fy0 = focus ? focus[1] * img.naturalHeight - sy : -1;
    const fx1 = focus ? focus[2] * img.naturalWidth - sx : -1;
    const fy1 = focus ? focus[3] * img.naturalHeight - sy : -1;
    for (let i = 0; i < N; i++) {
      let v = 0;
      let inFocus = 0;
      if (!outside[i]) {
        const r = d[i * 4];
        const gg = d[i * 4 + 1];
        const b = d[i * 4 + 2];
        const l = (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255;
        const sat = (Math.max(r, gg, b) - Math.min(r, gg, b)) / 255;
        // shells thick, servos thin but present
        v = 0.16 + 0.84 * Math.pow(l, 1.15);
        if (sat > 0.2) v = Math.max(v, 0.95);
        const x = i % W;
        const y = (i - x) / W;
        if (x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1) {
          v = Math.max(v, 0.92);
          inFocus = 1;
        }
      }
      // red channel: bar strength; green channel: 255 marks the step's object
      d[i * 4] = Math.round(v * 255);
      d[i * 4 + 1] = inFocus ? 255 : 0;
      d[i * 4 + 2] = 0;
      d[i * 4 + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    subject = c;
  }

  function compute() {
    const r = canvas.getBoundingClientRect();
    w = Math.max(1, Math.round(r.width));
    h = Math.max(1, Math.round(r.height));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = layer.width = Math.round(w * dpr);
    canvas.height = layer.height = Math.round(h * dpr);
    if (!img.naturalWidth) return;
    if (!subject) buildSubject();
    const { sw, sh } = sourceRect();
    // contain-fit the crop: into the placement box on the wide card, into the whole canvas when stacked
    const [px0, py0, px1, py1] = w > 600 ? place : [0, 0, 1, 1];
    const bx = px0 * w;
    const by = py0 * h;
    const bw = (px1 - px0) * w;
    const bh = (py1 - py0) * h;
    const scale = Math.min(bw / sw, bh / sh);
    dest = { w: sw * scale, h: sh * scale, x: bx + (bw - sw * scale) / 2, y: by + (bh - sh * scale) / 2 };
    cols = Math.ceil(w / CELL_W);
    rows = Math.ceil(h / ROW_H);
    const off = document.createElement('canvas');
    off.width = cols;
    off.height = rows;
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.fillStyle = '#000';
    octx.fillRect(0, 0, cols, rows);
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(subject, 0, 0, subject.width, subject.height, dest.x / CELL_W, dest.y / ROW_H, dest.w / CELL_W, dest.h / ROW_H);
    const data = octx.getImageData(0, 0, cols, rows).data;
    // where the image sits, in cell units, for the edge fade
    const mx0 = dest.x / CELL_W;
    const my0 = dest.y / ROW_H;
    const mx1 = (dest.x + dest.w) / CELL_W;
    const my1 = (dest.y + dest.h) / ROW_H;
    const smooth = (e) => (e <= 0 ? 0 : e >= 1 ? 1 : e * e * (3 - 2 * e));
    values = new Float32Array(cols * rows);
    hi = new Uint8Array(cols * rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        let v = data[i * 4] / 255;
        if (v <= 0) continue;
        // edge fade: the last 12% of the crop on each side fades out, so no crop rectangle shows
        const ex = Math.min(x - mx0, mx1 - x) / ((mx1 - mx0) * 0.12);
        const ey = Math.min(y - my0, my1 - y) / ((my1 - my0) * 0.12);
        v *= smooth(ex) * smooth(ey);
        values[i] = v;
        if (data[i * 4 + 1] > 100) hi[i] = 1;
      }
    }
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, layer.width, layer.height);
    revealedRows = 0;
    ready = true;
  }

  function paintRows(upTo) {
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (let y = revealedRows; y < upTo; y++) {
      const cyRow = y * ROW_H + ROW_H / 2;
      // faint base line across every row, like a scan
      lctx.globalAlpha = 0.12;
      lctx.fillStyle = 'rgba(255,255,255,0.5)';
      lctx.fillRect(0, cyRow - 0.25, w, 0.5);
      lctx.globalAlpha = 1;
      for (let x = 0; x < cols; x++) {
        const v = values[y * cols + x];
        if (v < 0.05) continue;
        const bh = Math.min(ROW_H - 0.8, 0.6 + v * (ROW_H - 1));
        lctx.fillStyle = hi[y * cols + x] ? 'rgba(255,255,255,1)' : `rgba(255,255,255,${(0.4 + 0.5 * v).toFixed(3)})`;
        lctx.fillRect(x * CELL_W, cyRow - bh / 2, CELL_W, bh);
      }
    }
    revealedRows = upTo;
  }

  function render(now) {
    raf = 0;
    if (!ready) return;
    let more = false;
    if (entered && revealedRows < rows) {
      const p = reduce ? 1 : Math.min(1, (now - revealStart) / REVEAL_MS);
      paintRows(Math.ceil(p * rows));
      more = revealedRows < rows;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(layer, 0, 0);
    if (pointer && revealedRows >= rows) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.save();
      ctx.beginPath();
      ctx.arc(pointer.x, pointer.y, LENS, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = '#0b0c0e';
      ctx.fillRect(pointer.x - LENS, pointer.y - LENS, LENS * 2, LENS * 2);
      const { sx, sy, sw, sh } = sourceRect();
      ctx.filter = 'grayscale(1) brightness(0.62) contrast(1.35)';
      ctx.drawImage(img, sx, sy, sw, sh, dest.x, dest.y, dest.w, dest.h);
      ctx.filter = 'none';
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(pointer.x, pointer.y, LENS, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (more) schedule();
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(render);
  }

  img.addEventListener('load', () => {
    compute();
    schedule();
  });
  img.addEventListener('error', () => {
    // show the plain screenshot if the halftone cannot be made
    const fallback = document.createElement('img');
    fallback.className = 'halftone-fallback';
    fallback.src = src;
    fallback.alt = '';
    canvas.replaceWith(fallback);
  });

  new ResizeObserver(() => {
    if (!img.naturalWidth) return;
    const wasRevealed = revealedRows >= rows && rows > 0;
    compute();
    if (wasRevealed || entered) {
      revealStart = performance.now() - REVEAL_MS;
    }
    schedule();
  }).observe(canvas);

  new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting && !entered) {
        entered = true;
        revealStart = performance.now();
        schedule();
      }
    },
    { threshold: 0.15 },
  ).observe(canvas);

  // The canvas sits under the copy, so listen on the whole card.
  const card = canvas.parentElement;
  if (window.matchMedia('(hover: hover)').matches) {
    card.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      pointer = x >= 0 && y >= 0 && x <= r.width && y <= r.height ? { x, y } : null;
      schedule();
    });
    card.addEventListener('pointerleave', () => {
      pointer = null;
      schedule();
    });
  }
}
