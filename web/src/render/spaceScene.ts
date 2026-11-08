// The deep-space look: a dark sky, one point-cloud starfield (a single THREE.Points, so one
// draw call), the floor as lunar regolith with a faint grid (render/lunarFloor.ts: procedural
// texture, ground that fades into the stars, a small procedural Earth), the Robuff mission
// patch on the arm (render/missionPatch.ts), and a cool key light. It only restyles what the
// viewport already drew; physics is untouched. No image files: everything is drawn in code.

import * as THREE from 'three';
import { createRng, randomUnit, range } from '../objects/rng';
import { dressLunarGround } from './lunarFloor';
import { attachMissionPatch } from './missionPatch';
import type { Viewport } from './viewport';

export const STAR_COUNT = 8000;
const STAR_SEED = 20261107;
/** Stars sit on a shell well outside the arena and inside the camera's far plane (20 m). */
const STAR_RADIUS_MIN = 7;
const STAR_RADIUS_MAX = 12;
const SKY = 0x04060c;
const REGOLITH = 0x5d5f63;
const KEY_LIGHT = 0xcfdcff;

export interface SpaceScene {
  readonly stars: THREE.Points;
  readonly starCount: number;
  /** Draw calls the stars add to one frame: renders once without them and once with them. */
  measureStarDrawCalls(): number;
}

function starfield(): THREE.Points {
  const rng = createRng(STAR_SEED);
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const [x, y, z] = randomUnit(rng);
    const r = range(rng, STAR_RADIUS_MIN, STAR_RADIUS_MAX);
    positions.set([x * r, y * r, z * r], 3 * i);
    // Mostly white, a few warm and a few blue, dimmer on average.
    const brightness = range(rng, 0.35, 1);
    const tint = rng();
    const color = tint < 0.12 ? [1, 0.85, 0.7] : tint < 0.3 ? [0.75, 0.85, 1] : [1, 1, 1];
    colors.set(color.map((c) => c * brightness), 3 * i);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false });
  const points = new THREE.Points(geometry, material);
  points.name = 'starfield';
  points.frustumCulled = false;
  return points;
}

/** Restyles the viewport's scene in place and adds the stars. Call once after the viewport exists. */
export function applySpaceScene(viewport: Viewport): SpaceScene {
  const scene = viewport.scene;
  scene.background = new THREE.Color(SKY);

  const grids: THREE.Object3D[] = [];
  scene.traverse((node) => {
    if (node instanceof THREE.GridHelper) grids.push(node);
    if (node instanceof THREE.HemisphereLight) {
      node.color.set(0x9aa6c4);
      node.groundColor.set(0x1a1c22);
      node.intensity = 0.7;
    }
    if (node instanceof THREE.DirectionalLight) {
      node.color.set(KEY_LIGHT);
      node.intensity = 2.4;
    }
  });
  // The floor plane is a geom of the world body (body 0).
  viewport.bodyGroup(0)?.traverse((node) => {
    if (node instanceof THREE.Mesh && node.geometry instanceof THREE.PlaneGeometry) {
      const material = node.material as THREE.MeshStandardMaterial;
      material.color.set(REGOLITH);
      material.roughness = 1;
      material.metalness = 0;
    }
  });
  for (const grid of grids) {
    grid.removeFromParent();
    if (grid instanceof THREE.GridHelper) grid.dispose();
  }
  const grid = new THREE.GridHelper(2, 20, 0x80889a, 0x80889a);
  grid.rotation.x = Math.PI / 2;
  grid.position.z = 0.0005;
  const gridMaterial = grid.material as THREE.LineBasicMaterial;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.07;
  gridMaterial.depthWrite = false;
  scene.add(grid);
  dressLunarGround(viewport);
  attachMissionPatch(viewport);

  const stars = starfield();
  scene.add(stars);
  return {
    stars,
    starCount: STAR_COUNT,
    measureStarDrawCalls(): number {
      stars.visible = false;
      viewport.render();
      const without = viewport.stats().drawCalls;
      stars.visible = true;
      viewport.render();
      return viewport.stats().drawCalls - without;
    },
  };
}
