// A sphere (an ellipsoid when height differs from width): balls, oranges, marbles.
// Latitude rings between two poles; the seed turns the rings.

import { fitToBox, smoothMesh, type ObjectMesh } from '../mesh';
import { createRng, range, streamSeed } from '../rng';
import type { ObjectSpec } from '../spec';
import { circle, stackRings } from './rings';

const SIDES = 32;
const BANDS = 16;

export function buildSphere(spec: ObjectSpec): ObjectMesh {
  const rng = createRng(streamSeed(spec.seed, 0x5f));
  const outline = circle(SIDES, range(rng, 0, (2 * Math.PI) / SIDES));
  const profile: [number, number][] = [];
  for (let k = 1; k < BANDS; k++) {
    const theta = (Math.PI * k) / BANDS;
    profile.push([Math.sin(theta), (1 - Math.cos(theta)) / 2]);
  }
  const { points, triangles } = stackRings(outline, profile, 0, 1);
  const width = spec.width_mm / 1000;
  fitToBox(points, { x: width, y: width, z: spec.height_mm / 1000 });
  return smoothMesh(points, triangles);
}
