// A cone: traffic cones, funnels, party hats. A chamfered base, a short straight band, then
// sides up to a small flat tip. The seed turns its facets. The straight band is where the jaw
// grips: on a bare cone the pads would meet the slanted side, and squeezing would push it out.

import { fitToBox, flatMesh, type ObjectMesh } from '../mesh';
import { createRng, range, streamSeed } from '../rng';
import type { ObjectSpec } from '../spec';
import { circle, rimHeight, stackRings } from './rings';

const SIDES = 32;
const TIP = 0.05;
/** Top of the straight band, as a fraction of the height. */
const BAND = 0.34;

export function buildCone(spec: ObjectSpec): ObjectMesh {
  const rng = createRng(streamSeed(spec.seed, 0xc0));
  const outline = circle(SIDES, range(rng, 0, (2 * Math.PI) / SIDES));
  const chamfer = 0.03 + 0.1 * spec.lumpiness;
  const rim = rimHeight(chamfer, spec.width_mm, spec.height_mm, 0.15);
  const profile = [
    [1 - chamfer, 0],
    [1, rim],
    [1, BAND],
    [TIP, 1],
  ] as const;
  const { points, triangles } = stackRings(outline, profile);
  const width = spec.width_mm / 1000;
  fitToBox(points, { x: width, y: width, z: spec.height_mm / 1000 });
  return flatMesh(points, triangles);
}
