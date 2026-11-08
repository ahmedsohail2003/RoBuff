// The lunar ground: the floor plane gets a regolith texture and a matching normal map, both
// built here from seeded noise and craters (no image files), and grows into a disc of ground
// that darkens and fades into the starfield; plus a small procedural Earth low on the horizon
// with a soft glow. Nothing here animates. Physics is untouched: MuJoCo's floor is an
// infinite plane whatever is drawn.

import * as THREE from 'three';
import { createRng, range, type Rng } from '../objects/rng';
import { DEFAULT_VIEW } from './defaultView';
import type { Viewport } from './viewport';

const SEED = 20261107;
const TEXTURE_SIZE = 512;
/** Metres of ground one texture tile covers. */
const TILE_M = 0.6;
/** The ground is a disc this wide; it darkens toward the rim and fades into the stars. */
const GROUND_RADIUS_M = 1.8;
const DARKEN_START_M = 0.9;
const FADE_START_M = 1.15;
const EARTH_RADIUS_M = 0.16;
/** Inside the star shell (7 m from the origin), so no star is drawn in front of the Earth. */
const EARTH_DISTANCE_M = 6;

const noRaycast = (): void => {};

function smooth(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** Value noise on a lattice that wraps, so the texture tiles without seams. Values in [0, 1). */
export function tilingNoise(size: number, cells: number, rng: Rng): Float32Array {
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
  const out = new Float32Array(size * size);
  const step = cells / size;
  for (let y = 0; y < size; y++) {
    const gy = y * step;
    const y0 = Math.floor(gy);
    const ty = smooth(gy - y0);
    const y1 = (y0 + 1) % cells;
    for (let x = 0; x < size; x++) {
      const gx = x * step;
      const x0 = Math.floor(gx);
      const tx = smooth(gx - x0);
      const x1 = (x0 + 1) % cells;
      const a = lattice[y0 * cells + x0]!;
      const b = lattice[y0 * cells + x1]!;
      const c = lattice[y1 * cells + x0]!;
      const d = lattice[y1 * cells + x1]!;
      out[y * size + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

function fbm(size: number, rng: Rng, cells: number[]): Float32Array {
  const out = new Float32Array(size * size);
  let total = 0;
  cells.forEach((count, octave) => {
    const weight = 0.5 ** octave;
    total += weight;
    const layer = tilingNoise(size, count, rng);
    for (let i = 0; i < out.length; i++) out[i]! += layer[i]! * weight;
  });
  for (let i = 0; i < out.length; i++) out[i]! /= total;
  return out;
}

function dataTexture(bytes: Uint8Array, width: number, height: number, srgb: boolean): THREE.DataTexture {
  const texture = new THREE.DataTexture(bytes, width, height, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Grey-tan regolith with soft craters of several sizes, and the normal map of the same height field. */
export function regolithTextures(size = TEXTURE_SIZE): { albedo: THREE.DataTexture; normal: THREE.DataTexture } {
  const rng = createRng(SEED);
  const broad = fbm(size, rng, [4, 8, 16]);
  const fine = fbm(size, rng, [32, 64, 128]);
  const height = new Float32Array(size * size);
  const tone = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) height[i] = broad[i]! * 6 + fine[i]! * 1.5;

  const wrap = (v: number) => ((v % size) + size) % size;
  const crater = (radius: number) => {
    const cx = rng() * size;
    const cy = rng() * size;
    const depth = radius * 0.45;
    const reach = Math.ceil(radius * 1.7);
    for (let py = Math.floor(cy) - reach; py <= Math.floor(cy) + reach; py++) {
      for (let px = Math.floor(cx) - reach; px <= Math.floor(cx) + reach; px++) {
        const d = Math.hypot(px - cx, py - cy) / radius;
        if (d >= 1.7) continue;
        const i = wrap(py) * size + wrap(px);
        if (d < 1) {
          // A bowl, continuous with the rim at d = 1.
          height[i]! += depth * (1.25 * d * d - 1);
          tone[i]! -= 0.07 * (1 - d);
        } else {
          height[i]! += depth * 0.25 * (1 - smooth((d - 1) / 0.7));
          if (d < 1.35) tone[i]! += 0.05;
        }
      }
    }
  };
  for (let i = 0; i < 3; i++) crater(range(rng, 40, 70));
  for (let i = 0; i < 28; i++) crater(range(rng, 12, 30));
  for (let i = 0; i < 260; i++) crater(range(rng, 3, 10));

  const albedo = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const strength = 0.6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const left = height[y * size + wrap(x - 1)]!;
      const right = height[y * size + wrap(x + 1)]!;
      const down = height[wrap(y - 1) * size + x]!;
      const up = height[wrap(y + 1) * size + x]!;
      // DataTexture rows run with v, so row + 1 is +v.
      let nx = -(right - left) * 0.5 * strength;
      let ny = -(up - down) * 0.5 * strength;
      let nz = 1;
      const length = Math.hypot(nx, ny, nz);
      nx /= length;
      ny /= length;
      nz /= length;
      normal.set([(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz * 0.5 + 0.5) * 255, 255], 4 * i);

      // A little light baked in from one side, so craters still read under flat light.
      const lit =
        0.86 + (fine[i]! - 0.5) * 0.35 + (broad[i]! - 0.5) * 0.25 + tone[i]! + (rng() - 0.5) * 0.06 - (right - left) * 0.025;
      albedo.set([0.45 * lit * 255, 0.43 * lit * 255, 0.4 * lit * 255, 255], 4 * i);
    }
  }
  return { albedo: dataTexture(albedo, size, size, true), normal: dataTexture(normal, size, size, false) };
}

function earthTexture(): THREE.DataTexture {
  const width = 256;
  const height = 128;
  const rng = createRng(SEED + 1);
  const land = fbm(width, rng, [6, 12, 24, 48]);
  const cloud = fbm(width, rng, [8, 16, 32, 64]);
  const bytes = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const latitude = Math.abs(y / height - 0.5) * 2;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const l = land[i]!;
      let color: [number, number, number] =
        l > 0.56 ? (l > 0.62 ? [150, 128, 88] : [64, 112, 62]) : [18 + 30 * l, 58 + 50 * l, 132 + 60 * l];
      if (latitude > 0.82) color = [235, 240, 245];
      const c = Math.min(1, Math.max(0, (cloud[i]! - 0.5) * 3));
      color = color.map((v) => v * (1 - c) + 248 * c) as [number, number, number];
      bytes.set([...color, 255], 4 * i);
    }
  }
  return dataTexture(bytes, width, height, true);
}

function glowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const g = canvas.getContext('2d')!;
  const gradient = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(110, 170, 255, 0.0)');
  gradient.addColorStop(0.3, 'rgba(110, 170, 255, 0.35)');
  gradient.addColorStop(0.42, 'rgba(90, 150, 255, 0.16)');
  gradient.addColorStop(1, 'rgba(60, 120, 255, 0)');
  g.fillStyle = gradient;
  g.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A small Earth low over the ground's rim in the default view. */
function earth(): THREE.Object3D[] {
  const [px, py, pz] = DEFAULT_VIEW.position;
  const [tx, ty, tz] = DEFAULT_VIEW.target;
  // Left of centre and about a quarter of the way down the view, just past the ground's rim.
  const heading = Math.atan2(ty - py, tx - px) + 0.38;
  const pitchDown = Math.atan2(pz - tz, Math.hypot(tx - px, ty - py));
  const elevation = -pitchDown + Math.atan(0.54 * Math.tan((DEFAULT_VIEW.fovDeg * Math.PI) / 360));
  const position = new THREE.Vector3(
    px + EARTH_DISTANCE_M * Math.cos(elevation) * Math.cos(heading),
    py + EARTH_DISTANCE_M * Math.cos(elevation) * Math.sin(heading),
    pz + EARTH_DISTANCE_M * Math.sin(elevation),
  );
  const globe = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS_M, 32, 16).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: earthTexture(), roughness: 0.9, metalness: 0, emissive: 0x0b1a33 }),
  );
  globe.name = 'earth';
  globe.position.copy(position);
  globe.rotation.z = 2.2;
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
  );
  glow.name = 'earth-glow';
  glow.position.copy(position);
  glow.scale.set(EARTH_RADIUS_M * 3.4, EARTH_RADIUS_M * 3.4, 1);
  for (const node of [globe, glow]) node.raycast = noRaycast;
  return [globe, glow];
}

export interface LunarGround {
  readonly floor: THREE.Mesh | null;
  readonly earth: THREE.Object3D[];
}

/**
 * Gives the floor plane (a geom of the world body) the regolith, enlarged to a disc of ground
 * that darkens toward its rim and fades into the starfield, and adds the Earth. The floor stays
 * a PlaneGeometry; it is drawn first among transparent objects so ghosts still blend over it.
 */
export function dressLunarGround(viewport: Viewport): LunarGround {
  const planes: THREE.Mesh[] = [];
  viewport.bodyGroup(0)?.traverse((node) => {
    if (node instanceof THREE.Mesh && node.geometry instanceof THREE.PlaneGeometry) planes.push(node);
  });
  const extras = earth();
  viewport.scene.add(...extras);
  const plane = planes[0];
  if (!plane) return { floor: null, earth: extras };

  const ground = new THREE.PlaneGeometry(2 * GROUND_RADIUS_M, 2 * GROUND_RADIUS_M, 72, 72);
  const position = ground.attributes.position!;
  const colors = new Float32Array(position.count * 4);
  for (let i = 0; i < position.count; i++) {
    const r = Math.hypot(position.getX(i), position.getY(i));
    const shade = 1 - 0.55 * smooth((r - DARKEN_START_M) / (GROUND_RADIUS_M - DARKEN_START_M));
    const alpha = 1 - smooth((r - FADE_START_M) / (GROUND_RADIUS_M - FADE_START_M));
    colors.set([shade, shade, shade, alpha], 4 * i);
  }
  ground.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  plane.geometry.dispose();
  plane.geometry = ground;

  const { albedo, normal } = regolithTextures();
  albedo.repeat.set((2 * GROUND_RADIUS_M) / TILE_M, (2 * GROUND_RADIUS_M) / TILE_M);
  normal.repeat.copy(albedo.repeat);
  const material = plane.material as THREE.MeshStandardMaterial;
  material.map = albedo;
  material.normalMap = normal;
  material.normalScale.set(1, 1);
  material.color.set(0xffffff);
  material.roughness = 1;
  material.metalness = 0;
  material.vertexColors = true;
  material.transparent = true;
  material.needsUpdate = true;
  plane.renderOrder = -1;
  return { floor: plane, earth: extras };
}
