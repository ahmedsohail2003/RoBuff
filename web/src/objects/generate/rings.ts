// Closed solids made of stacked rings, for the everyday kinds (box, cylinder, sphere, cone).
// Every ring is one outline scaled about the z axis; a fan closes the bottom and the top.

import { MeshBuilder } from '../mesh';

export type Outline = readonly (readonly [number, number])[];
/** [scale, z] per ring, from the base up. */
export type Profile = readonly (readonly [number, number])[];

/** A regular polygon of unit radius, counter-clockwise seen from above, turned by `phase` radians. */
export function circle(sides: number, phase: number): [number, number][] {
  const out: [number, number][] = [];
  for (let j = 0; j < sides; j++) {
    const angle = phase + (2 * Math.PI * j) / sides;
    out.push([Math.cos(angle), Math.sin(angle)]);
  }
  return out;
}

/** Height of a rounded or chamfered rim in unit z, so it looks the same size as `inset` does across. */
export function rimHeight(inset: number, widthMm: number, heightMm: number, most = 0.2): number {
  return Math.min(most, Math.max(0.002, (inset * widthMm) / 2 / heightMm));
}

/** Outline counter-clockwise from above; rings ordered from the base up. The caps sit at bottomZ and topZ. */
export function stackRings(
  outline: Outline,
  profile: Profile,
  bottomZ = profile[0]![1],
  topZ = profile[profile.length - 1]![1],
): { points: Float64Array; triangles: Uint32Array } {
  const b = new MeshBuilder();
  const rings = profile.map(([s, z]) => outline.map(([x, y]) => b.vertex(s * x, s * y, z)));
  const bottom = b.vertex(0, 0, bottomZ);
  const top = b.vertex(0, 0, topZ);
  const last = rings.length - 1;
  const n = outline.length;
  for (let j = 0; j < n; j++) {
    const next = (j + 1) % n;
    for (let i = 0; i < last; i++) b.quad(rings[i]![j]!, rings[i]![next]!, rings[i + 1]![next]!, rings[i + 1]![j]!);
    b.triangle(bottom, rings[0]![next]!, rings[0]![j]!);
    b.triangle(top, rings[last]![j]!, rings[last]![next]!);
  }
  return { points: b.pointArray(), triangles: b.triangleArray() };
}
