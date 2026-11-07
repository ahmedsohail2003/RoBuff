// Wavefront OBJ text, so a person can open a generated shape in any viewer.
// OBJ viewers expect Y up, so Z-up coordinates are written as (x, z, -y).

import type { ObjectMesh } from './mesh';

export function meshToObj(mesh: ObjectMesh, comment = ''): string {
  const out: string[] = [];
  if (comment) for (const line of comment.split('\n')) out.push(`# ${line}`);
  out.push('# units: millimetres, Y up');
  const p = mesh.positions;
  const n = mesh.normals;
  for (let i = 0; i < p.length; i += 3) out.push(`v ${(p[i]! * 1000).toFixed(4)} ${(p[i + 2]! * 1000).toFixed(4)} ${(-p[i + 1]! * 1000).toFixed(4)}`);
  for (let i = 0; i < n.length; i += 3) out.push(`vn ${n[i]!.toFixed(5)} ${n[i + 2]!.toFixed(5)} ${(-n[i + 1]!).toFixed(5)}`);
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t]! + 1;
    const b = mesh.indices[t + 1]! + 1;
    const c = mesh.indices[t + 2]! + 1;
    out.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
  }
  return `${out.join('\n')}\n`;
}
