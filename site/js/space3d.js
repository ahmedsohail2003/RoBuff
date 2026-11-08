// WebGL backdrop for the dark bands: a drifting, twinkling starfield in three depth layers, and bodies
// drawn as dots like the robot: in the hero a large cratered Moon at the right edge and a small far
// ringed planet; in the closing band a ringed planet in the corner. Each dot is lit from a sun to one
// side, so there is a terminator, and dots thin out and dim toward the night side. The sun and the
// bodies lean toward the mouse or finger. Decorative and illustrative only, not a sky map.
// Pauses when off screen, draws one still frame under prefers-reduced-motion, and does nothing
// if WebGL is unavailable.
import * as THREE from '../vendor/three.module.js';
import { makeBody, makeRing, rng } from './dotbody.js';
import { pointer, trackPointer } from './pointer.js';

function webglOK() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) {
    return false;
  }
}

function starField(count, spread, zNear = 5, zFar = 65) {
  const r = rng(7 + count + zNear);
  const pos = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (r() - 0.5) * spread;
    pos[i * 3 + 1] = (r() - 0.5) * spread * 0.6;
    pos[i * 3 + 2] = -zNear - r() * (zFar - zNear);
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

// A body made of dots (see dotbody.js). Every dot is lit in the shader from uSun, so the terminator,
// the crater shadows and the thinning of dots into the night side all move when the sun or the body turns.
// A scan ring sweeps from the nearest point out to the edge now and then, like the robot's scan band.
const BODY_VERT = `
  attribute vec3 aNormal; attribute float aAlb; attribute float aRnd;
  uniform vec3 uSun; uniform float uPx; uniform float uSize; uniform float uScan;
  uniform float uNight; uniform float uAlpha; uniform float uR; uniform float uRing; uniform float uHideR;
  varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    // light and facing both use the view-space normal, with the sun given in view space too
    vec3 nV = normalize(normalMatrix * aNormal);
    float l = dot(nV, uSun);
    // a dot faces the camera when its normal points back along the line of sight (not just toward +z:
    // under perspective an off-axis body would lose part of its lit rim)
    float front = smoothstep(0.0, 0.32, dot(nV, normalize(-mv.xyz)));
    if (uRing > 0.5) {
      // ring dots have no far side; the ones behind the planet's disc are hidden by it
      l = 0.25 + 0.75 * abs(l);
      front = (mv.z < c.z && length(mv.xy - c.xy) < uHideR) ? 0.0 : 1.0;
    }
    float lit = clamp(l, 0.0, 1.0);
    float b = aAlb * pow(lit, 0.7);
    // brightness sets each dot's size and alpha, like a halftone; the darkest ground drops out
    float show = smoothstep(0.03, 0.16, b);
    float night = uNight * (1.0 - smoothstep(-0.05, 0.1, l));
    float depth = (mv.z - c.z) / max(uR, 0.0001);
    float scan = (1.0 - uRing) * max(0.0, 1.0 - abs(depth - uScan) / 0.05) * step(0.03, lit);
    vA = uAlpha * front * clamp(show * (0.2 + 0.8 * b) + night + scan * 0.5, 0.0, 1.0);
    gl_PointSize = uSize * uPx * (0.55 + 0.9 * b + scan * 0.6);
  }`;
// square dots, like the robot's: at 1.5 to 2.5 px a round mask would leave most of them faint
const BODY_FRAG = `
  varying float vA;
  void main() {
    if (vA < 0.004) discard;
    gl_FragColor = vec4(1.0, 1.0, 1.0, vA);
  }`;

function dotPoints(body, { size = 1.6, night = 0.06, alpha = 1, ring = false } = {}) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(body.pos, 3));
  geo.setAttribute('aNormal', new THREE.BufferAttribute(body.nrm, 3));
  geo.setAttribute('aAlb', new THREE.BufferAttribute(body.alb, 1));
  geo.setAttribute('aRnd', new THREE.BufferAttribute(body.rnd, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uSun: { value: new THREE.Vector3(0.6, 0.45, 0.65).normalize() },
      uPx: { value: 1 },
      uSize: { value: size },
      uScan: { value: -1 },
      uNight: { value: night },
      uAlpha: { value: alpha },
      uR: { value: 1 },
      uRing: { value: ring ? 1 : 0 },
      uHideR: { value: 0 },
    },
    vertexShader: BODY_VERT,
    fragmentShader: BODY_FRAG,
  });
  const pts = new THREE.Points(geo, mat);
  if (!ring) {
    // an invisible sphere that only writes depth, so stars behind the body are hidden instead of shining through its dots
    const occ = new THREE.Mesh(new THREE.SphereGeometry(0.97, 32, 20), new THREE.MeshBasicMaterial({ colorWrite: false }));
    pts.add(occ);
  }
  return pts;
}

// A ringed planet: banded dots for the globe and a flat dotted ring tilted around it.
function ringedPlanet(dense, seed, alpha = 1) {
  const group = new THREE.Group();
  const globe = dotPoints(makeBody({ n: dense ? 3200 : 1800, seed, craters: 0, bands: 7, grain: 0.05, base: 0.78, squash: 0.94 }), { size: 1.5, night: 0.05, alpha });
  const ring = dotPoints(makeRing({ n: dense ? 1500 : 900, seed: seed + 1, inner: 1.3, outer: 1.95 }), { size: 1.2, ring: true, alpha: 0.55 * alpha });
  ring.rotation.x = -1.02;
  group.add(globe, ring);
  group.rotation.z = 0.32;
  return { group, globe, ring };
}

function mountScene(canvas, { moon, planet, stars }) {
  const host = canvas.parentElement;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  camera.position.set(0, 0, 10);

  // three depth layers; on pointer, touch and scroll the near layer shifts most (parallax)
  const layers = [
    { pts: starField(Math.round(stars * 0.55), 110, 40, 65), k: 0.35 },
    { pts: starField(Math.round(stars * 0.3), 90, 18, 40), k: 0.9 },
    { pts: starField(Math.round(stars * 0.15), 70, 5, 18), k: 1.8 },
  ];
  layers.forEach((l) => {
    l.pts.material.uniforms.uPx.value = dpr;
    scene.add(l.pts);
  });

  // bodies: each has a home in pixels (worked out per layout on resize) and a size in pixels
  const bodies = [];
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  if (moon) {
    const m = dotPoints(makeBody({ n: small ? 22000 : 48000, seed: 2026, craters: 190, rMin: 0.02, rMax: 0.26, depth: 1.7, maria: 8, layout: 'rings' }), { size: small ? 1.6 : 1.7, night: 0.05 });
    scene.add(m);
    bodies.push({ kind: 'moon', obj: m, pts: [m], spin: 0.03, sunBase: new THREE.Vector3(-0.86, 0.3, 0.42), home: { x: 0, y: 0, r: 1 } });
  }
  if (planet) {
    const p = ringedPlanet(!small, planet.seed || 11, planet.alpha || 1);
    scene.add(p.group);
    bodies.push({ kind: 'planet', obj: p.group, pts: [p.globe, p.ring], spin: 0.05, sunBase: new THREE.Vector3(-0.5, 0.5, 0.7), place: planet.place, home: { x: 0, y: 0, r: 1 } });
  }
  bodies.forEach((b) => b.pts.forEach((p) => (p.material.uniforms.uPx.value = dpr)));
  const moonBody = bodies.find((b) => b.kind === 'moon');

  let w = 1;
  let h = 1;
  // the calculator card's right edge, in this band's pixels (the desktop Moon sits just right of it)
  const cardRight = () => {
    const card = document.getElementById('calc');
    return card ? card.getBoundingClientRect().right - host.getBoundingClientRect().left : w * 0.88;
  };
  let unit = 1; // world units per css pixel at the bodies' depth (z = 0)
  function resize() {
    w = Math.max(1, host.clientWidth);
    h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    unit = (2 * Math.tan((camera.fov * Math.PI) / 360) * 10) / h;
    const narrow = w < 901;
    if (moonBody) moonBody.pts[0].material.uniforms.uAlpha.value = narrow ? 0.26 : 1;
    bodies.forEach((b) => {
      let px;
      if (b.kind === 'moon') {
        // desktop: a large Moon just right of the glass calculator, mostly off the edge, its lit left side showing as a crescent.
        // phone: a dimmer Moon behind the robot band, as a backdrop disc, clear of the menu button and the copy.
        const r = narrow ? Math.min(150, w * 0.38) : Math.min(320, h * 0.36);
        // at least 90 px of crescent always shows, even where the gap beside the card is narrow
        px = narrow ? { x: w * 0.6, y: 224, r } : { x: Math.min(cardRight() + r + 12, w + r - 90), y: h * 0.26, r };
      } else {
        px = b.place(w, h, narrow);
      }
      b.obj.visible = !!px;
      if (!px) return;
      b.home = px;
      b.obj.scale.setScalar(px.r * unit);
      b.pts.forEach((p) => {
        p.material.uniforms.uR.value = px.r * unit;
        p.material.uniforms.uHideR.value = px.r * unit * 0.98;
      });
    });
  }
  resize();
  // setSize clears the drawing buffer, so under reduced motion the still frame is drawn again after each resize
  new ResizeObserver(() => {
    resize();
    if (reduce) frame(performance.now());
  }).observe(host);

  let visible = true;
  let ex = 0;
  let ey = 0;
  let raf = 0;
  let last = performance.now();
  let t = 0;
  const sun = new THREE.Vector3();
  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    ex += (pointer.x - ex) * Math.min(1, dt * 3);
    ey += (pointer.y - ey) * Math.min(1, dt * 3);
    // scroll drift: how far the band has moved through the window, about -1..1 while it is on screen
    const rect = host.getBoundingClientRect();
    const sc = reduce ? 0 : (rect.top + rect.height / 2 - window.innerHeight / 2) / Math.max(1, window.innerHeight);
    layers.forEach((l) => {
      l.pts.material.uniforms.uTime.value = t;
      l.pts.rotation.z = t * 0.004;
      l.pts.position.x = Math.sin(t * 0.03) * 0.6 - ex * 0.8 * l.k;
      l.pts.position.y = -ey * 0.5 * l.k + sc * 1.2 * l.k;
    });
    camera.rotation.set(ey * 0.025, -ex * 0.035, 0);
    camera.updateMatrixWorld();
    // the scan ring sweeps out from the nearest point every 9 s, then rests
    const ph = (t * 0.11) % 1;
    const scan = reduce ? -1 : ph < 0.55 ? 1 - ph / 0.55 : -1;
    bodies.forEach((b) => {
      if (!b.obj.visible) return;
      const hx = (b.home.x - w / 2) * unit;
      const hy = (h / 2 - b.home.y) * unit;
      const drift = b.kind === 'moon' && w < 901 ? 0 : sc * 0.5;
      b.obj.position.set(hx + ex * 0.25, hy + ey * 0.18 + drift, 0);
      if (b.kind === 'moon') {
        b.obj.rotation.set(0.2 - ey * 0.22, 0.6 + t * b.spin + ex * 0.45, 0.62);
      } else {
        b.obj.rotation.y = t * b.spin + ex * 0.4;
        b.obj.rotation.x = 0.25 - ey * 0.2;
      }
      // the sun swings toward the pointer, so the terminator and the crater shadows move with it;
      // the shader lights in view space, so the sun is turned into the camera's frame
      sun.copy(b.sunBase);
      sun.x += ex * 0.75;
      sun.y += ey * 0.45;
      sun.normalize().transformDirection(camera.matrixWorldInverse);
      b.pts.forEach((p) => {
        p.material.uniforms.uSun.value.copy(sun);
        p.material.uniforms.uScan.value = scan;
      });
    });
    renderer.render(scene, camera);
    if (visible && !reduce) raf = requestAnimationFrame(frame);
  }
  if (reduce) {
    frame(performance.now());
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
  trackPointer();
  const hero = document.getElementById('hero-space');
  if (hero) {
    mountScene(hero, {
      moon: true,
      // a small far planet in the hero's upper left, above the badge
      planet: { seed: 17, alpha: 0.55, place: (w, h, narrow) => (narrow ? null : { x: Math.max(84, (w - 1152) / 2 - 62), y: 140, r: 26 }) },
      stars: 3000,
    });
  }
  const cta = document.getElementById('cta-space');
  if (cta) {
    mountScene(cta, {
      moon: false,
      // a ringed planet in the closing band's top right corner, clear of the heading and the robot (not on phones, where it would sit on the heading)
      planet: { seed: 11, place: (w, h, narrow) => (narrow ? null : { x: w - 118, y: 96, r: 38 }) },
      stars: 1200,
    });
  }
}
