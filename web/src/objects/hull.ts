// Incremental 3D convex hull, written for this package. Everything physical in
// the guardrail uses this hull, because MuJoCo collides on the hull as well.

export interface ConvexHull {
  /** Hull vertices only, x y z per point. */
  points: Float64Array;
  /** Three indices into `points` per triangle, counter-clockwise from outside. */
  faces: Uint32Array;
  volume: number;
}

/** Plane tolerance as a fraction of the bounding diagonal. */
const RELATIVE_EPSILON = 1e-6;

interface Face {
  a: number;
  b: number;
  c: number;
  nx: number;
  ny: number;
  nz: number;
  d: number;
}

function makeFace(p: Float64Array, a: number, b: number, c: number): Face {
  const ax = p[a * 3]!;
  const ay = p[a * 3 + 1]!;
  const az = p[a * 3 + 2]!;
  const ux = p[b * 3]! - ax;
  const uy = p[b * 3 + 1]! - ay;
  const uz = p[b * 3 + 2]! - az;
  const vx = p[c * 3]! - ax;
  const vy = p[c * 3 + 1]! - ay;
  const vz = p[c * 3 + 2]! - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 0) {
    nx /= len;
    ny /= len;
    nz /= len;
  }
  return { a, b, c, nx, ny, nz, d: nx * ax + ny * ay + nz * az };
}

function distanceToFace(p: Float64Array, face: Face, i: number): number {
  return face.nx * p[i * 3]! + face.ny * p[i * 3 + 1]! + face.nz * p[i * 3 + 2]! - face.d;
}

function diagonal(p: Float64Array): number {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = p[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  return Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
}

/** Four points that span real volume, or null if the cloud is a point, a line or a plane. */
function initialTetrahedron(p: Float64Array, epsilon: number): [number, number, number, number] | null {
  const count = p.length / 3;
  let i0 = 0;
  for (let i = 1; i < count; i++) if (p[i * 3]! < p[i0 * 3]!) i0 = i;

  let i1 = -1;
  let best = -1;
  for (let i = 0; i < count; i++) {
    const dist = Math.hypot(p[i * 3]! - p[i0 * 3]!, p[i * 3 + 1]! - p[i0 * 3 + 1]!, p[i * 3 + 2]! - p[i0 * 3 + 2]!);
    if (dist > best) {
      best = dist;
      i1 = i;
    }
  }
  if (best <= epsilon) return null;

  const dx = (p[i1 * 3]! - p[i0 * 3]!) / best;
  const dy = (p[i1 * 3 + 1]! - p[i0 * 3 + 1]!) / best;
  const dz = (p[i1 * 3 + 2]! - p[i0 * 3 + 2]!) / best;
  let i2 = -1;
  best = -1;
  for (let i = 0; i < count; i++) {
    const wx = p[i * 3]! - p[i0 * 3]!;
    const wy = p[i * 3 + 1]! - p[i0 * 3 + 1]!;
    const wz = p[i * 3 + 2]! - p[i0 * 3 + 2]!;
    const dist = Math.hypot(wy * dz - wz * dy, wz * dx - wx * dz, wx * dy - wy * dx);
    if (dist > best) {
      best = dist;
      i2 = i;
    }
  }
  if (best <= epsilon) return null;

  const plane = makeFace(p, i0, i1, i2);
  let i3 = -1;
  best = -1;
  for (let i = 0; i < count; i++) {
    const dist = Math.abs(distanceToFace(p, plane, i));
    if (dist > best) {
      best = dist;
      i3 = i;
    }
  }
  if (best <= epsilon) return null;
  return [i0, i1, i2, i3];
}

/** Returns null when the points are not finite or span no volume. */
export function convexHull(positions: ArrayLike<number>): ConvexHull | null {
  const count = Math.floor(positions.length / 3);
  if (count < 4) return null;
  const p = new Float64Array(count * 3);
  for (let i = 0; i < count * 3; i++) {
    const v = positions[i]!;
    if (!Number.isFinite(v)) return null;
    p[i] = v;
  }
  const epsilon = diagonal(p) * RELATIVE_EPSILON;
  const start = initialTetrahedron(p, epsilon);
  if (!start) return null;
  const [i0, i1, i2, i3] = start;

  let faces: Face[];
  if (distanceToFace(p, makeFace(p, i0, i1, i2), i3) < 0) {
    faces = [makeFace(p, i0, i1, i2), makeFace(p, i0, i3, i1), makeFace(p, i1, i3, i2), makeFace(p, i2, i3, i0)];
  } else {
    faces = [makeFace(p, i0, i2, i1), makeFace(p, i0, i1, i3), makeFace(p, i1, i2, i3), makeFace(p, i2, i0, i3)];
  }

  // Directed edge -> index of the live face that owns it. Kept up to date as faces come and go.
  const key = (from: number, to: number): number => from * count + to;
  let alive: Uint8Array = new Uint8Array(faces.length).fill(1);
  let liveCount = faces.length;
  let owner = new Map<number, number>();
  const register = (f: number): void => {
    const face = faces[f]!;
    owner.set(key(face.a, face.b), f);
    owner.set(key(face.b, face.c), f);
    owner.set(key(face.c, face.a), f);
  };
  faces.forEach((_, f) => register(f));
  // A closed hull of n points has at most 2n - 4 faces. Far more means rounding broke it.
  const faceLimit = 2 * count + 16;

  for (let point = 0; point < count; point++) {
    let seed = -1;
    let seedDistance = epsilon;
    for (let f = 0; f < faces.length; f++) {
      if (!alive[f]) continue;
      const d = distanceToFace(p, faces[f]!, point);
      if (d > seedDistance) {
        seedDistance = d;
        seed = f;
      }
    }
    if (seed < 0) continue;

    // Grow the visible region from the most visible face across shared edges only, so it
    // stays one connected patch even when rounding makes a far face look visible too.
    const visible = new Set<number>([seed]);
    const queue = [seed];
    while (queue.length > 0) {
      const face = faces[queue.pop()!]!;
      for (const [from, to] of [[face.a, face.b], [face.b, face.c], [face.c, face.a]] as const) {
        const twin = owner.get(key(to, from));
        if (twin !== undefined && !visible.has(twin) && distanceToFace(p, faces[twin]!, point) > epsilon) {
          visible.add(twin);
          queue.push(twin);
        }
      }
    }

    // Edges of the visible patch whose twin is not visible form the horizon.
    const horizon: [number, number][] = [];
    for (const f of visible) {
      const face = faces[f]!;
      for (const [from, to] of [[face.a, face.b], [face.b, face.c], [face.c, face.a]] as const) {
        const twin = owner.get(key(to, from));
        if (twin === undefined || !visible.has(twin)) horizon.push([from, to]);
      }
    }
    for (const f of visible) {
      const face = faces[f]!;
      for (const [from, to] of [[face.a, face.b], [face.b, face.c], [face.c, face.a]] as const) {
        if (owner.get(key(from, to)) === f) owner.delete(key(from, to));
      }
      alive[f] = 0;
      liveCount--;
    }
    for (const [from, to] of horizon) {
      faces.push(makeFace(p, from, to, point));
      register(faces.length - 1);
      liveCount++;
    }
    if (liveCount > faceLimit) return null;
    if (alive.length < faces.length) {
      const grown = new Uint8Array(Math.max(faces.length, alive.length * 2));
      grown.set(alive);
      alive = grown;
    }
    alive.fill(1, faces.length - horizon.length, faces.length);
    // Drop dead faces now and then, so the seed scan stays short.
    if (faces.length > 4 * liveCount + 64) {
      faces = faces.filter((_, f) => alive[f]);
      alive = new Uint8Array(faces.length).fill(1);
      owner = new Map<number, number>();
      faces.forEach((_, f) => register(f));
    }
  }
  faces = faces.filter((_, f) => alive[f]);

  // Keep only the points the hull uses.
  const remap = new Map<number, number>();
  const outPoints: number[] = [];
  const outFaces: number[] = [];
  const mapPoint = (i: number): number => {
    let mapped = remap.get(i);
    if (mapped === undefined) {
      mapped = remap.size;
      remap.set(i, mapped);
      outPoints.push(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!);
    }
    return mapped;
  };
  for (const face of faces) outFaces.push(mapPoint(face.a), mapPoint(face.b), mapPoint(face.c));

  const points = Float64Array.from(outPoints);
  const faceArray = Uint32Array.from(outFaces);
  const volume = closedVolume(points, faceArray);
  if (!(volume > 0)) return null;
  return { points, faces: faceArray, volume };
}

/** Signed volume of a closed triangle mesh. Positive when triangles wind counter-clockwise from outside. */
export function closedVolume(points: ArrayLike<number>, indices: ArrayLike<number>): number {
  if (points.length < 3) return 0;
  // Measured from the first vertex, so large coordinates keep their precision.
  const ox = points[0]!;
  const oy = points[1]!;
  const oz = points[2]!;
  let sum = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const ax = points[a]! - ox;
    const ay = points[a + 1]! - oy;
    const az = points[a + 2]! - oz;
    const bx = points[b]! - ox;
    const by = points[b + 1]! - oy;
    const bz = points[b + 2]! - oz;
    const cx = points[c]! - ox;
    const cy = points[c + 1]! - oy;
    const cz = points[c + 2]! - oz;
    sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return sum / 6;
}
