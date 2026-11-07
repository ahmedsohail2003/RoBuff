// A physics-only copy of the arm for recompiling. Compiling the full arm takes 1-3 s in WASM,
// almost all of it in its 18 STL meshes, so a spawn would freeze the page. MuJoCo collides a
// mesh through its convex hull, and every moving arm body has an explicit <inertial>, so this
// copy keeps exactly what the physics uses: the collision meshes become inline lists of their
// own convex hull points, and the visual-only geoms (contype 0, density 0) are dropped. The
// screen keeps drawing the full meshes from the model loaded at start.

import { convexHull } from '../objects/hull';
import type { ModelFiles } from './compileModel';

/** Geoms of these classes never collide and weigh nothing (so_arm100.xml defaults). */
const VISUAL_GEOM = /\s*<geom\b[^>]*\bclass="(?:visual|motor_visual)"[^>]*\/>/g;

/** Unique vertex positions of a binary STL, in its own units. */
export function stlPoints(bytes: Uint8Array): Float64Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 84) throw new Error('STL is too short');
  const triangles = view.getUint32(80, true);
  if (84 + triangles * 50 !== bytes.byteLength) throw new Error('only binary STL is supported');
  const seen = new Set<string>();
  const out: number[] = [];
  for (let t = 0; t < triangles; t++) {
    for (let v = 0; v < 3; v++) {
      const at = 84 + t * 50 + 12 + v * 12;
      const x = view.getFloat32(at, true);
      const y = view.getFloat32(at + 4, true);
      const z = view.getFloat32(at + 8, true);
      const key = `${x},${y},${z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(x, y, z);
    }
  }
  return Float64Array.from(out);
}

function num(v: number): string {
  return Number(v.toPrecision(9)).toString();
}

export interface PhysicsFiles extends ModelFiles {
  /** Collision meshes now inline as hull points: name, STL points, hull points. */
  inlined: { mesh: string; stlPoints: number; hullPoints: number }[];
  droppedGeoms: number;
}

/** The arm with visual geoms dropped and mesh files that collide replaced by their hull points. */
export function physicsOnlyFiles(files: ModelFiles): PhysicsFiles {
  const plan = planPhysics(files);
  const hulls = new Map(plan.meshes.map((m) => [m.name, hullOfMesh(files, m.name, m.file)]));
  return buildPhysics(files, plan.armXml, hulls);
}

/** Same, giving the page a turn after each mesh, so preparing it never freezes the tab. */
export async function physicsOnlyFilesAsync(files: ModelFiles, pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0))): Promise<PhysicsFiles> {
  const plan = planPhysics(files);
  const hulls = new Map<string, HullOfMesh>();
  for (const m of plan.meshes) {
    hulls.set(m.name, hullOfMesh(files, m.name, m.file));
    await pause();
  }
  return buildPhysics(files, plan.armXml, hulls);
}

interface HullOfMesh {
  stlPoints: number;
  points: Float64Array;
}

const MESH_TAG = /(<mesh\b[^>]*\bname="([^"]+)"[^>]*\bfile="([^"]+)"[^>]*\/>)(\s*)/g;

function planPhysics(files: ModelFiles): { armXml: string; meshes: { name: string; file: string }[]; dropped: number } {
  const dropped = files.armXml.match(VISUAL_GEOM)?.length ?? 0;
  const armXml = files.armXml.replace(VISUAL_GEOM, '');
  const used = new Set([...armXml.matchAll(/<geom\b[^>]*\bmesh="([^"]+)"/g)].map((m) => m[1]!));
  const meshes = [...armXml.matchAll(MESH_TAG)].filter((m) => used.has(m[2]!)).map((m) => ({ name: m[2]!, file: m[3]! }));
  return { armXml, meshes, dropped };
}

function hullOfMesh(files: ModelFiles, name: string, file: string): HullOfMesh {
  const bytes = files.meshes.get(`assets/${file}`);
  if (!bytes) throw new Error(`no bytes for mesh file ${file}`);
  const points = stlPoints(bytes);
  const hull = convexHull(points);
  if (!hull) throw new Error(`mesh ${name} has no convex hull`);
  return { stlPoints: points.length / 3, points: hull.points instanceof Float64Array ? hull.points : Float64Array.from(hull.points) };
}

function buildPhysics(files: ModelFiles, strippedXml: string, hulls: Map<string, HullOfMesh>): PhysicsFiles {
  const inlined: PhysicsFiles['inlined'] = [];
  const armXml = strippedXml.replace(MESH_TAG, (_all, tag: string, name: string, _file: string, space: string) => {
    const hull = hulls.get(name);
    if (!hull) return '';
    inlined.push({ mesh: name, stlPoints: hull.stlPoints, hullPoints: hull.points.length / 3 });
    const vertex = Array.from(hull.points, num).join(' ');
    return `${tag.replace(/\s*file="[^"]+"/, '').replace(/\/>$/, ` vertex="${vertex}"/>`)}${space}`;
  });
  return { armXml, sceneXml: files.sceneXml, meshes: new Map(), inlined, droppedGeoms: files.armXml.match(VISUAL_GEOM)?.length ?? 0 };
}
