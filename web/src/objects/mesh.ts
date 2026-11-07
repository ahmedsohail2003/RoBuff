// The mesh type every generator returns, plus helpers to finish one.
// Units are metres. Z is up, matching MuJoCo.

export interface ObjectMesh {
  /** x, y, z per vertex, in metres. */
  positions: Float32Array;
  /** Three vertex indices per triangle, counter-clockwise from outside. */
  indices: Uint32Array;
  /** Unit normal per vertex. */
  normals: Float32Array;
}

export interface BoxSize {
  x: number;
  y: number;
  z: number;
}

/** Rescales points in place so their bounding box is exactly `size`, centred on the origin. */
export function fitToBox(points: Float64Array, size: BoxSize): void {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = points[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  const target = [size.x, size.y, size.z];
  for (let i = 0; i < points.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const span = max[a]! - min[a]!;
      const centre = (max[a]! + min[a]!) / 2;
      points[i + a] = span > 0 ? ((points[i + a]! - centre) / span) * target[a]! : 0;
    }
  }
}

function faceNormal(points: ArrayLike<number>, a: number, b: number, c: number): [number, number, number] {
  const ux = points[b]! - points[a]!;
  const uy = points[b + 1]! - points[a + 1]!;
  const uz = points[b + 2]! - points[a + 2]!;
  const vx = points[c]! - points[a]!;
  const vy = points[c + 1]! - points[a + 1]!;
  const vz = points[c + 2]! - points[a + 2]!;
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** Area-weighted vertex normals, for welded meshes that should shade smooth. */
export function smoothMesh(points: Float64Array, indices: Uint32Array): ObjectMesh {
  const normals = new Float64Array(points.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const [nx, ny, nz] = faceNormal(points, a, b, c);
    for (const v of [a, b, c]) {
      normals[v] = normals[v]! + nx;
      normals[v + 1] = normals[v + 1]! + ny;
      normals[v + 2] = normals[v + 2]! + nz;
    }
  }
  return { positions: Float32Array.from(points), indices, normals: normalizeAll(normals) };
}

/** One vertex per triangle corner and one normal per face, for parts with hard edges. */
export function flatMesh(points: Float64Array, triangles: Uint32Array): ObjectMesh {
  const count = triangles.length;
  const positions = new Float32Array(count * 3);
  const normals = new Float64Array(count * 3);
  const indices = new Uint32Array(count);
  for (let t = 0; t < count; t += 3) {
    const corners = [triangles[t]! * 3, triangles[t + 1]! * 3, triangles[t + 2]! * 3] as const;
    const [nx, ny, nz] = faceNormal(points, corners[0], corners[1], corners[2]);
    for (let k = 0; k < 3; k++) {
      const source = corners[k]!;
      const out = (t + k) * 3;
      positions[out] = points[source]!;
      positions[out + 1] = points[source + 1]!;
      positions[out + 2] = points[source + 2]!;
      normals[out] = nx;
      normals[out + 1] = ny;
      normals[out + 2] = nz;
      indices[t + k] = t + k;
    }
  }
  return { positions, indices, normals: normalizeAll(normals) };
}

function normalizeAll(values: Float64Array): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 3) {
    const x = values[i]!;
    const y = values[i + 1]!;
    const z = values[i + 2]!;
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 0) {
      out[i] = x / len;
      out[i + 1] = y / len;
      out[i + 2] = z / len;
    } else {
      out[i + 2] = 1;
    }
  }
  return out;
}

/** Copy of a mesh with a uniform scale and a shift applied. Normals do not change under uniform scale. */
export function transformMesh(mesh: ObjectMesh, scale: number, shift: readonly [number, number, number]): ObjectMesh {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = mesh.positions[i]! * scale + shift[0];
    positions[i + 1] = mesh.positions[i + 1]! * scale + shift[1];
    positions[i + 2] = mesh.positions[i + 2]! * scale + shift[2];
  }
  return { positions, indices: mesh.indices.slice(), normals: mesh.normals.slice() };
}

/** Collects vertices and triangles for a generator. */
export class MeshBuilder {
  private readonly points: number[] = [];
  private readonly triangles: number[] = [];

  vertex(x: number, y: number, z: number): number {
    this.points.push(x, y, z);
    return this.points.length / 3 - 1;
  }

  triangle(a: number, b: number, c: number): void {
    this.triangles.push(a, b, c);
  }

  /** a, b, c, d counter-clockwise from outside. */
  quad(a: number, b: number, c: number, d: number): void {
    this.triangles.push(a, b, c, a, c, d);
  }

  pointArray(): Float64Array {
    return Float64Array.from(this.points);
  }

  triangleArray(): Uint32Array {
    return Uint32Array.from(this.triangles);
  }
}
