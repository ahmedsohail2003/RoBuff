// A flat solar panel: a frame with recessed cells. Near-convex, lying flat.

import { fitToBox, flatMesh, MeshBuilder, type ObjectMesh } from '../mesh';
import { createRng, randomInt, range, streamSeed } from '../rng';
import type { ObjectSpec } from '../spec';

/** Grid lines for `cells` recesses separated by `frame` wide strips: even tiles are frame, odd tiles are cells. */
function gridLines(span: number, cells: number, frame: number): number[] {
  const cellSize = (span - frame * (cells + 1)) / cells;
  const lines = [-span / 2];
  for (let i = 0; i < cells; i++) {
    const last = lines[lines.length - 1]!;
    lines.push(last + frame, last + frame + cellSize);
  }
  lines.push(span / 2);
  return lines;
}

type Point = readonly [number, number, number];

export function buildPanel(spec: ObjectSpec): ObjectMesh {
  const rng = createRng(streamSeed(spec.seed, 0x61));
  const width = spec.width_mm / 1000;
  const height = spec.height_mm / 1000;
  const depth = width * range(rng, 0.52, 0.72);

  const cellsX = randomInt(rng, 2, 3) + Math.round(spec.lumpiness);
  const cellsY = randomInt(rng, 1, 2);
  const frame = Math.min(width, depth) * range(rng, 0.05, 0.08);
  const recess = height * (0.08 + 0.14 * spec.roughness);
  const xs = gridLines(width, cellsX, frame);
  const ys = gridLines(depth, cellsY, frame);
  const top = height / 2;
  const bottom = -height / 2;
  const floor = top - recess;

  const b = new MeshBuilder();
  const quad = (p: Point, q: Point, r: Point, s: Point): void => {
    b.quad(b.vertex(...p), b.vertex(...q), b.vertex(...r), b.vertex(...s));
  };

  for (let ix = 0; ix < xs.length - 1; ix++) {
    for (let iy = 0; iy < ys.length - 1; iy++) {
      const x0 = xs[ix]!;
      const x1 = xs[ix + 1]!;
      const y0 = ys[iy]!;
      const y1 = ys[iy + 1]!;
      if (ix % 2 === 1 && iy % 2 === 1) {
        quad([x0, y0, floor], [x1, y0, floor], [x1, y1, floor], [x0, y1, floor]);
        quad([x0, y0, top], [x1, y0, top], [x1, y0, floor], [x0, y0, floor]);
        quad([x1, y0, top], [x1, y1, top], [x1, y1, floor], [x1, y0, floor]);
        quad([x1, y1, top], [x0, y1, top], [x0, y1, floor], [x1, y1, floor]);
        quad([x0, y1, top], [x0, y0, top], [x0, y0, floor], [x0, y1, floor]);
      } else {
        quad([x0, y0, top], [x1, y0, top], [x1, y1, top], [x0, y1, top]);
      }
    }
  }
  const hx = width / 2;
  const hy = depth / 2;
  quad([hx, -hy, bottom], [-hx, -hy, bottom], [-hx, hy, bottom], [hx, hy, bottom]);
  quad([-hx, -hy, bottom], [hx, -hy, bottom], [hx, -hy, top], [-hx, -hy, top]);
  quad([hx, -hy, bottom], [hx, hy, bottom], [hx, hy, top], [hx, -hy, top]);
  quad([hx, hy, bottom], [-hx, hy, bottom], [-hx, hy, top], [hx, hy, top]);
  quad([-hx, hy, bottom], [-hx, -hy, bottom], [-hx, -hy, top], [-hx, hy, top]);

  const points = b.pointArray();
  fitToBox(points, { x: width, y: depth, z: height });
  return flatMesh(points, b.triangleArray());
}
