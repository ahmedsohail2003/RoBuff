// WebGL backdrop for the dark bands: a slowly drifting, twinkling starfield and, in the hero,
// a procedurally textured Moon partly in view at the right edge. Decorative only (illustrative,
// not a sky map). Pauses when off screen, draws one still frame under prefers-reduced-motion,
// and does nothing if WebGL is unavailable.
import * as THREE from '../vendor/three.module.js';

function webglOK() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) {
    return false;
  }
}

// small seeded random, so the Moon looks the same on every visit
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

function moonTexture() {
  const W = 1024;
  const H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const r = rng(2026);
  g.fillStyle = '#8d8d8f';
  g.fillRect(0, 0, W, H);
  // maria: large soft dark patches
  for (let i = 0; i < 14; i++) {
    const x = r() * W;
    const y = H * (0.2 + r() * 0.6);
    const rad = 40 + r() * 120;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, 'rgba(60,60,64,0.55)');
    grd.addColorStop(1, 'rgba(60,60,64,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.ellipse(x, y, rad * 1.4, rad, 0, 0, Math.PI * 2);
    g.fill();
  }
  // fine grain
  const im = g.getImageData(0, 0, W, H);
  for (let i = 0; i < im.data.length; i += 4) {
    const n = (r() - 0.5) * 18;
    im.data[i] += n;
    im.data[i + 1] += n;
    im.data[i + 2] += n;
  }
  g.putImageData(im, 0, 0);
  // craters: dark floor, bright rim on one side, shadow on the other
  for (let i = 0; i < 420; i++) {
    const big = r() < 0.08;
    const rad = big ? 14 + r() * 26 : 2 + Math.pow(r(), 2) * 12;
    const x = r() * W;
    const y = H * 0.08 + r() * H * 0.84;
    const sx = 1 / Math.max(0.35, Math.cos(((y / H) - 0.5) * Math.PI)); // widen near the poles
    g.save();
    g.translate(x, y);
    g.scale(Math.min(sx, 2.5), 1);
    g.fillStyle = 'rgba(40,40,44,0.35)';
    g.beginPath();
    g.arc(0, 0, rad, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(210,210,214,0.35)';
    g.lineWidth = Math.max(1, rad * 0.18);
    g.beginPath();
    g.arc(0, 0, rad, Math.PI * 0.9, Math.PI * 1.9);
    g.stroke();
    g.strokeStyle = 'rgba(20,20,24,0.35)';
    g.beginPath();
    g.arc(0, 0, rad, Math.PI * -0.1, Math.PI * 0.9);
    g.stroke();
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

function starField(count, spread) {
  const r = rng(7 + count);
  const pos = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (r() - 0.5) * spread;
    pos[i * 3 + 1] = (r() - 0.5) * spread * 0.6;
    pos[i * 3 + 2] = -5 - r() * 60;
    size[i] = 0.6 + Math.pow(r(), 6) * 2.6;
    phase[i] = r() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uPx: { value: 1 } },
    vertexShader: `
      attribute float aSize; attribute float aPhase;
      uniform float uTime; uniform float uPx;
      varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uPx * 1.6;
        vA = 0.55 + 0.45 * sin(uTime * (0.6 + fract(aPhase) * 1.4) + aPhase * 7.0);
      }`,
    fragmentShader: `
      varying float vA;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.0, length(d));
        gl_FragColor = vec4(vec3(0.86, 0.9, 1.0), a * vA);
      }`,
  });
  return new THREE.Points(geo, mat);
}

function mountScene(canvas, { moon, stars }) {
  const host = canvas.parentElement;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  camera.position.set(0, 0, 10);

  const field = starField(stars, 90);
  field.material.uniforms.uPx.value = dpr;
  scene.add(field);

  let moonMesh = null;
  if (moon) {
    const tex = moonTexture();
    const mat = new THREE.MeshStandardMaterial({ map: tex, bumpMap: tex, bumpScale: 2.5, roughness: 1, metalness: 0 });
    moonMesh = new THREE.Mesh(new THREE.SphereGeometry(3.2, 96, 64), mat);
    moonMesh.rotation.z = 0.12;
    scene.add(moonMesh);
    const sun = new THREE.DirectionalLight(0xffffff, 3.2);
    sun.position.set(-6, 2, 4);
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0x8090b0, 0.08));
  }

  function resize() {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (moonMesh) {
      // keep the Moon partly off the right edge, whatever the aspect
      const halfW = Math.tan((camera.fov * Math.PI) / 360) * 10 * camera.aspect;
      const narrow = w < 901;
      moonMesh.position.set(halfW - (narrow ? 0.2 : 0.9), narrow ? 4.6 : 1.6, 0);
      // on phones the hero is tall and narrow: a smaller Moon tucked in the top corner keeps the copy on black
      moonMesh.scale.setScalar(narrow ? 0.38 : 1);
    }
  }
  resize();
  new ResizeObserver(resize).observe(host);

  let visible = true;
  let raf = 0;
  let last = performance.now();
  let t = 0;
  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    field.material.uniforms.uTime.value = t;
    field.rotation.z = t * 0.004;
    field.position.x = Math.sin(t * 0.03) * 0.6;
    if (moonMesh) moonMesh.rotation.y = 0.6 + t * 0.03;
    renderer.render(scene, camera);
    if (visible && !reduce) raf = requestAnimationFrame(frame);
  }
  if (reduce) {
    frame(performance.now());
    window.addEventListener('resize', () => requestAnimationFrame(frame));
    return;
  }
  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (visible && !raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }).observe(host);
  raf = requestAnimationFrame(frame);
}

export function mountSpace3D() {
  if (!webglOK()) return;
  const hero = document.getElementById('hero-space');
  if (hero) mountScene(hero, { moon: true, stars: 3000 });
  const cta = document.getElementById('cta-space');
  if (cta) mountScene(cta, { moon: false, stars: 1200 });
}
