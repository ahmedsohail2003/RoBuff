// Fixed deep-space backdrop behind the whole page (#space-bg). The light sections sit on top of it as
// rounded panels, so it shows at the left and right edges of the window: stars in three depth layers,
// slowly tumbling low-poly asteroids, two distant planets (one ringed) and an occasional comet.
// Everything drifts slowly and shifts with the pointer, touch and page scroll (near layers move more).
// Decorative only. Pixel ratio capped at 1.5, paused while the tab is hidden, one still frame under
// prefers-reduced-motion, and nothing at all if WebGL is unavailable (the body stays plain dark).
import * as THREE from '../vendor/three.module.js';

function webglOK() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) {
    return false;
  }
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POINT_VS = `
  attribute float aSize; attribute float aPhase; attribute float aAlpha;
  uniform float uTime; uniform float uPx; uniform float uTw;
  varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPx * 1.6;
    float tw = 0.55 + 0.45 * sin(uTime * (0.6 + fract(aPhase) * 1.4) + aPhase * 7.0);
    vA = aAlpha * mix(1.0, tw, uTw);
  }`;
const POINT_FS = `
  uniform vec3 uColor;
  varying float vA;
  void main() {
    float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
    gl_FragColor = vec4(uColor, a * vA);
  }`;

function pointsMaterial(dpr, twinkle, color) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uPx: { value: dpr }, uTw: { value: twinkle }, uColor: { value: new THREE.Color(color) } },
    vertexShader: POINT_VS,
    fragmentShader: POINT_FS,
  });
}

// stars on a shell around the camera, so the layer can turn with the pointer and scroll without edges
function starShell(count, radius, sizeMax, seed, dpr) {
  const r = rng(seed);
  const pos = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  const alpha = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const u = r() * 2 - 1;
    const th = r() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const rad = radius * (0.85 + r() * 0.3);
    pos[i * 3] = s * Math.cos(th) * rad;
    pos[i * 3 + 1] = u * rad;
    pos[i * 3 + 2] = s * Math.sin(th) * rad;
    size[i] = 0.5 + Math.pow(r(), 5) * sizeMax;
    phase[i] = r() * Math.PI * 2;
    alpha[i] = 0.5 + r() * 0.5;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  return new THREE.Points(geo, pointsMaterial(dpr, 1, 0xdce6ff));
}

function asteroidGeo(r, radius) {
  const geo = new THREE.IcosahedronGeometry(radius, 1);
  const p = geo.attributes.position;
  // jitter each unique corner the same way so the faceted surface stays closed
  const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!seen.has(key)) seen.set(key, 0.72 + r() * 0.5);
    const k = seen.get(key);
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.85, p.getZ(i) * k);
  }
  geo.computeVertexNormals();
  return geo;
}

function bandTexture(seed, base, bands) {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 256;
  const g = c.getContext('2d');
  const r = rng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, 16, 256);
  for (let y = 0; y < 256; y += 2 + Math.floor(r() * 10)) {
    g.fillStyle = bands[Math.floor(r() * bands.length)];
    g.globalAlpha = 0.25 + r() * 0.5;
    g.fillRect(0, y, 16, 2 + r() * 14);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function mountSpaceBg() {
  const canvas = document.getElementById('space-bg');
  if (!canvas || !webglOK()) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch (e) {
    return;
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);

  // three star layers: far (many, small), mid, near (few, larger); near layers move more
  const layers = [
    { pts: starShell(2600, 300, 1.4, 11, dpr), k: 0.25 },
    { pts: starShell(1100, 200, 2.2, 23, dpr), k: 0.6 },
    { pts: starShell(320, 120, 3.2, 37, dpr), k: 1.1 },
  ];
  layers.forEach((l) => scene.add(l.pts));

  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(-4, 3, 5);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0x8090b0, 0.18));

  // things placed in screen terms: nx, ny in -1..1 of the view at depth z, so they stay at the edges
  const things = [];
  const r = rng(404);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8a8782, roughness: 1, metalness: 0, flatShading: true });
  const rockSpots = [
    [-0.86, 0.62, -18, 1.0], [-0.78, -0.18, -26, 1.6], [-0.92, -0.72, -14, 0.7],
    [0.84, 0.5, -22, 1.3], [0.9, -0.35, -16, 0.8], [0.8, -0.85, -30, 2.0], [-0.95, 0.15, -40, 2.4],
  ];
  rockSpots.forEach(([nx, ny, z, rad]) => {
    const m = new THREE.Mesh(asteroidGeo(r, rad), rockMat);
    m.rotation.set(r() * 6, r() * 6, r() * 6);
    scene.add(m);
    things.push({ obj: m, nx, ny, z, par: 0.9 + (40 + z) * 0.03, spin: [(r() - 0.5) * 0.4, (r() - 0.5) * 0.4], drift: 0.012 + r() * 0.02 });
  });

  // ringed planet at the left, a small blue one at the right
  const p1 = new THREE.Mesh(
    new THREE.SphereGeometry(7, 48, 32),
    new THREE.MeshStandardMaterial({ map: bandTexture(5, '#b59a74', ['#8c6f4f', '#d8c3a0', '#a4825c']), roughness: 1 })
  );
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(9.5, 14, 96),
    new THREE.MeshBasicMaterial({ color: 0xcdbb9c, side: THREE.DoubleSide, transparent: true, opacity: 0.38, depthWrite: false })
  );
  ring.rotation.x = Math.PI * 0.42;
  const sat = new THREE.Group();
  sat.add(p1, ring);
  sat.rotation.z = 0.35;
  scene.add(sat);
  things.push({ obj: sat, nx: -0.82, ny: -0.42, z: -90, par: 0.35, spin: [0, 0.03], drift: 0.004, keep: true });

  const p2 = new THREE.Mesh(
    new THREE.SphereGeometry(4, 40, 28),
    new THREE.MeshStandardMaterial({ map: bandTexture(9, '#5a7fa8', ['#3d5f86', '#86a7c8', '#2e4a6b']), roughness: 1 })
  );
  scene.add(p2);
  things.push({ obj: p2, nx: 0.86, ny: 0.3, z: -110, par: 0.3, spin: [0, 0.04], drift: 0.003, keep: true });

  // comet: a bright head and a tail of fading points along its path
  const TAIL = 48;
  const cPos = new Float32Array(TAIL * 3);
  const cSize = new Float32Array(TAIL);
  const cAlpha = new Float32Array(TAIL);
  const cPhase = new Float32Array(TAIL);
  for (let i = 0; i < TAIL; i++) {
    const f = i / (TAIL - 1);
    cSize[i] = i === 0 ? 7 : 4.2 * (1 - f) + 0.6;
    cAlpha[i] = i === 0 ? 1 : 0.75 * Math.pow(1 - f, 1.6);
  }
  const cGeo = new THREE.BufferGeometry();
  cGeo.setAttribute('position', new THREE.BufferAttribute(cPos, 3));
  cGeo.setAttribute('aSize', new THREE.BufferAttribute(cSize, 1));
  cGeo.setAttribute('aAlpha', new THREE.BufferAttribute(cAlpha, 1));
  cGeo.setAttribute('aPhase', new THREE.BufferAttribute(cPhase, 1));
  const comet = new THREE.Points(cGeo, pointsMaterial(dpr, 0, 0xe8f2ff));
  comet.frustumCulled = false;
  scene.add(comet);
  const cr = rng(77);
  const cs = { active: false, wait: 3, t: 0, dur: 6, a: [0, 0], b: [0, 0], z: -35 };
  function launch() {
    const side = cr() < 0.5 ? -1 : 1;
    cs.a = [side * (0.7 + cr() * 0.25), 1.25];
    cs.b = [side * (0.6 + cr() * 0.35) - side * 0.25, -1.25];
    cs.z = -30 - cr() * 20;
    cs.dur = 5 + cr() * 3;
    cs.t = 0;
    cs.active = true;
  }

  let halfH = 1;
  let halfW = 1;
  function resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    halfH = Math.tan((camera.fov * Math.PI) / 360);
    halfW = halfH * camera.aspect;
  }
  resize();
  window.addEventListener('resize', () => {
    resize();
    if (reduce) render(0);
  });

  // pointer / touch, eased every frame
  let px = 0;
  let py = 0;
  let ex = 0;
  let ey = 0;
  const setP = (x, y) => {
    px = (x / window.innerWidth) * 2 - 1;
    py = -((y / window.innerHeight) * 2 - 1);
  };
  if (!reduce) {
    window.addEventListener('pointermove', (e) => setP(e.clientX, e.clientY), { passive: true });
    window.addEventListener('touchmove', (e) => { if (e.touches[0]) setP(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  }

  let t = 0;
  function render(dt) {
    t += dt;
    ex += (px - ex) * Math.min(1, dt * 3);
    ey += (py - ey) * Math.min(1, dt * 3);
    const sc = (window.scrollY || 0) / Math.max(1, window.innerHeight);
    layers.forEach((l) => {
      l.pts.material.uniforms.uTime.value = t;
      l.pts.rotation.y = t * 0.004 * l.k - ex * 0.06 * l.k;
      l.pts.rotation.x = ey * 0.04 * l.k + sc * 0.05 * l.k;
    });
    camera.rotation.set(ey * 0.02, -ex * 0.03, 0);
    things.forEach((o) => {
      const hw = halfW * -o.z;
      const hh = halfH * -o.z;
      let ny = o.ny + sc * o.drift * 6 + t * o.drift * 0.15;
      if (!o.keep) ny = ((ny + 1.4) % 2.8 + 2.8) % 2.8 - 1.4; // rocks wrap off screen
      o.obj.position.set((o.nx - ex * 0.05 * o.par) * hw, (ny - ey * 0.05 * o.par) * hh, o.z);
      if (o.keep && !reduce) o.obj.position.y = (o.ny - ey * 0.05 * o.par) * hh + Math.sin(t * 0.05) * 0.5;
      o.obj.rotation.x += o.spin[0] * dt;
      o.obj.rotation.y += o.spin[1] * dt;
    });
    // comet
    if (!cs.active) {
      cs.wait -= dt;
      comet.visible = false;
      if (cs.wait <= 0 && !reduce) launch();
    }
    if (cs.active) {
      cs.t += dt;
      const f = cs.t / cs.dur;
      const hw = halfW * -cs.z;
      const hh = halfH * -cs.z;
      const dx = (cs.b[0] - cs.a[0]) * hw;
      const dy = (cs.b[1] - cs.a[1]) * hh;
      const len = Math.hypot(dx, dy) || 1;
      const hx = (cs.a[0] - ex * 0.04) * hw + dx * f;
      const hy = (cs.a[1] - ey * 0.04) * hh + dy * f;
      for (let i = 0; i < TAIL; i++) {
        const back = i * 0.22;
        cPos[i * 3] = hx - (dx / len) * back;
        cPos[i * 3 + 1] = hy - (dy / len) * back;
        cPos[i * 3 + 2] = cs.z;
      }
      cGeo.attributes.position.needsUpdate = true;
      comet.visible = true;
      if (f >= 1.15) {
        cs.active = false;
        cs.wait = 6 + cr() * 10;
      }
    }
    renderer.render(scene, camera);
  }

  if (reduce) {
    render(0);
    return;
  }
  let raf = 0;
  let last = performance.now();
  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    render(dt);
    if (!document.hidden) raf = requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  });
  raf = requestAnimationFrame(frame);
}
