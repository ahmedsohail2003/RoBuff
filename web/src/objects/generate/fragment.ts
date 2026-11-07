// Debris: a jagged convex shard, the hull of a seeded handful of points.

import { convexHull } from '../hull';
import { fitToBox, flatMesh, type ObjectMesh } from '../mesh';
import { createRng, randomInt, range, streamSeed } from '../rng';
import type { ObjectSpec } from '../spec';

export function buildFragment(spec: ObjectSpec): ObjectMesh {
  const rng = createRng(streamSeed(spec.seed, 0x91));
  const extra = randomInt(rng, 4, 8) + Math.round(spec.roughness * 8);
  const skew = 0.25 + 0.5 * spec.lumpiness;
  const depthRatio = range(rng, 0.55, 0.9);
  const raw: number[] = [];
  // One point on each face of the unit box, so the shard reaches its full size in every direction.
  for (let axis = 0; axis < 3; axis++) {
    for (const side of [-1, 1]) {
      const point = [range(rng, -skew, skew), range(rng, -skew, skew), range(rng, -skew, skew)];
      point[axis] = side;
      raw.push(point[0]!, point[1]!, point[2]!);
    }
  }
  for (let i = 0; i < extra; i++) raw.push(range(rng, -1, 1), range(rng, -1, 1), range(rng, -1, 1));

  const hull = convexHull(raw);
  if (!hull) throw new Error('fragment points span no volume, which their construction rules out');
  const points = Float64Array.from(hull.points);
  const width = spec.width_mm / 1000;
  fitToBox(points, { x: width, y: width * depthRatio, z: spec.height_mm / 1000 });
  return flatMesh(points, hull.faces);
}
