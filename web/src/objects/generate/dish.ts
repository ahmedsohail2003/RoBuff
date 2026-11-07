// A solid comms dish: a shallow bowl on a tapered back and a foot, revolved. The hull fills the bowl.

import { fitToBox, MeshBuilder, smoothMesh, type ObjectMesh } from '../mesh';
import { createRng, randomInt, range, streamSeed } from '../rng';
import type { ObjectSpec } from '../spec';

export function buildDish(spec: ObjectSpec): ObjectMesh {
  const rng = createRng(streamSeed(spec.seed, 0x71));
  const sides = randomInt(rng, 24, 36);
  const width = spec.width_mm / 1000;
  const height = spec.height_mm / 1000;
  const ovalness = range(rng, 0.92, 1);
  const bowlDepth = (0.2 + 0.28 * spec.roughness) * range(rng, 0.85, 1.15);
  const footRadius = range(rng, 0.32, 0.46) + 0.06 * spec.lumpiness;
  const footHeight = range(rng, 0.14, 0.24);
  const lipHeight = range(rng, 0.05, 0.1);

  // Profile as (radius, height) at unit size, from the bowl's centre out over the rim and back in to the foot.
  const profile: [number, number][] = [];
  const bowlRings = 6;
  const innerRadius = 0.96;
  for (let i = 1; i <= bowlRings; i++) {
    const t = i / bowlRings;
    profile.push([innerRadius * t, 1 - bowlDepth * (1 - t * t)]);
  }
  profile.push([1, 1], [1, 1 - lipHeight]);
  const backRings = 4;
  for (let i = 1; i <= backRings; i++) {
    const t = i / backRings;
    profile.push([1 + (footRadius - 1) * t, 1 - lipHeight + (footHeight - (1 - lipHeight)) * (t * (2 - t))]);
  }
  profile.push([footRadius, 0]);

  const b = new MeshBuilder();
  const topPole = b.vertex(0, 0, 1 - bowlDepth);
  const rings: number[][] = profile.map(([r, z]) => {
    const ring: number[] = [];
    for (let j = 0; j < sides; j++) {
      const angle = (2 * Math.PI * j) / sides;
      ring.push(b.vertex(r * Math.cos(angle), r * ovalness * Math.sin(angle), z));
    }
    return ring;
  });
  const bottomPole = b.vertex(0, 0, 0);

  const last = rings.length - 1;
  for (let j = 0; j < sides; j++) {
    const next = (j + 1) % sides;
    b.triangle(topPole, rings[0]![j]!, rings[0]![next]!);
    for (let i = 0; i < last; i++) b.quad(rings[i]![j]!, rings[i + 1]![j]!, rings[i + 1]![next]!, rings[i]![next]!);
    b.triangle(rings[last]![j]!, bottomPole, rings[last]![next]!);
  }

  const points = b.pointArray();
  fitToBox(points, { x: width, y: width * ovalness, z: height });
  return smoothMesh(points, b.triangleArray());
}
