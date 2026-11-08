// A cylinder: cans, mugs, wheels, pucks. lumpiness chamfers its rims; the seed turns its facets.

import { fitToBox, flatMesh, type ObjectMesh } from '../mesh';
import { createRng, range, streamSeed } from '../rng';
import type { ObjectSpec } from '../spec';
import { circle, rimHeight, stackRings } from './rings';

const SIDES = 32;

export function buildCylinder(spec: ObjectSpec): ObjectMesh {
  const rng = createRng(streamSeed(spec.seed, 0xc1));
  const outline = circle(SIDES, range(rng, 0, (2 * Math.PI) / SIDES));
  const chamfer = 0.03 + 0.12 * spec.lumpiness;
  const rim = rimHeight(chamfer, spec.width_mm, spec.height_mm);
  const profile = [
    [1 - chamfer, 0],
    [1, rim],
    [1, 1 - rim],
    [1 - chamfer, 1],
  ] as const;
  const { points, triangles } = stackRings(outline, profile);
  const width = spec.width_mm / 1000;
  fitToBox(points, { x: width, y: width, z: spec.height_mm / 1000 });
  return flatMesh(points, triangles);
}
