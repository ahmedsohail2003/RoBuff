// A satellite bus: a faceted prism with bevelled edges, a shoulder and a docking collar on top.

import { fitToBox, flatMesh, MeshBuilder, type ObjectMesh } from '../mesh';
import { createRng, range, streamSeed } from '../rng';
import type { ObjectSpec } from '../spec';

const SIDE_CHOICES = [4, 6, 8] as const;

export function buildBus(spec: ObjectSpec): ObjectMesh {
  const rng = createRng(streamSeed(spec.seed, 0x81));
  const sides = SIDE_CHOICES[Math.floor(rng() * SIDE_CHOICES.length)]!;
  const depthRatio = range(rng, 0.78, 1);
  const shoulder = range(rng, 0.8, 0.9) - 0.05 * spec.lumpiness;
  const collar = range(rng, 0.45, 0.7);
  const bevel = 0.04 + 0.08 * spec.roughness;

  // Rings as (radius, height) at unit size, from the base to the top of the collar.
  const profile: [number, number][] = [
    [1 - bevel, 0],
    [1, bevel],
    [1, shoulder - bevel],
    [1 - bevel, shoulder],
    [collar, shoulder],
    [collar, 1],
  ];

  const b = new MeshBuilder();
  const rings = profile.map(([r, z]) => {
    const ring: number[] = [];
    for (let j = 0; j < sides; j++) {
      const angle = Math.PI / sides + (2 * Math.PI * j) / sides;
      ring.push(b.vertex(r * Math.cos(angle), r * depthRatio * Math.sin(angle), z));
    }
    return ring;
  });
  const bottom = b.vertex(0, 0, 0);
  const top = b.vertex(0, 0, 1);
  const last = rings.length - 1;
  for (let j = 0; j < sides; j++) {
    const next = (j + 1) % sides;
    for (let i = 0; i < last; i++) b.quad(rings[i]![j]!, rings[i]![next]!, rings[i + 1]![next]!, rings[i + 1]![j]!);
    b.triangle(bottom, rings[0]![next]!, rings[0]![j]!);
    b.triangle(top, rings[last]![j]!, rings[last]![next]!);
  }

  const points = b.pointArray();
  const width = spec.width_mm / 1000;
  fitToBox(points, { x: width, y: width * depthRatio, z: spec.height_mm / 1000 });
  return flatMesh(points, b.triangleArray());
}
