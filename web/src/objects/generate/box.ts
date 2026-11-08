// A box: width by depth (square when no depth is given) by height. lumpiness rounds its edges: 0 is nearly sharp (a game
// block), 1 is a soft, well-rounded brick. The seed nudges the rounding by under 1 percent.

import { fitToBox, flatMesh, type ObjectMesh } from '../mesh';
import { createRng, range, streamSeed } from '../rng';
import type { ObjectSpec } from '../spec';
import { rimHeight, stackRings } from './rings';

const CORNER_STEPS = 4;
const EDGE_STEPS = 3;
const CORNERS = [
  [1, 1],
  [-1, 1],
  [-1, -1],
  [1, -1],
] as const;

export function buildBox(spec: ObjectSpec): ObjectMesh {
  const rng = createRng(streamSeed(spec.seed, 0xb0));
  const radius = 0.03 + 0.3 * spec.lumpiness + range(rng, 0, 0.015);
  const inner = 1 - radius;

  // Rounded square, counter-clockwise from above: four quarter-circle corners.
  const outline: [number, number][] = [];
  CORNERS.forEach(([sx, sy], q) => {
    for (let k = 0; k <= CORNER_STEPS; k++) {
      const angle = (q * Math.PI) / 2 + (k * Math.PI) / 2 / CORNER_STEPS;
      outline.push([sx * inner + radius * Math.cos(angle), sy * inner + radius * Math.sin(angle)]);
    }
  });

  // The bottom and top edges round over the same way.
  const rim = rimHeight(radius, spec.width_mm, spec.height_mm, 0.3);
  const bottom: [number, number][] = [];
  for (let k = 0; k <= EDGE_STEPS; k++) {
    const phi = (k * Math.PI) / 2 / EDGE_STEPS;
    bottom.push([1 - radius * (1 - Math.sin(phi)), rim * (1 - Math.cos(phi))]);
  }
  const top = bottom.map(([s, z]) => [s, 1 - z] as [number, number]).reverse();

  const { points, triangles } = stackRings(outline, [...bottom, ...top]);
  const width = spec.width_mm / 1000;
  fitToBox(points, { x: width, y: (spec.depth_mm ?? spec.width_mm) / 1000, z: spec.height_mm / 1000 });
  return flatMesh(points, triangles);
}
