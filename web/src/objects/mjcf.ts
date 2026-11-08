// A validated object as an MJCF fragment: one <mesh> asset with inline hull points,
// and one free body with explicit mass and friction. An assembly gets one mesh and one geom
// per part, each its own convex hull with the mass of that part, so contacts follow the
// real compound shape and the body's mass is the sum.

import { MAX_HULL_VERT } from './limits';
import type { Receipt } from './receipt';

export interface MjcfFragment {
  /** Goes inside <asset>. */
  asset: string;
  /** Goes inside <worldbody>. */
  body: string;
  /** For an assembly, mesh and geom are the first part's; parts lists every part's. */
  names: { mesh: string; body: string; geom: string; joint: string; parts?: { mesh: string; geom: string; name: string }[] };
  mass_kg: number;
  friction: number;
  priority: boolean;
  hull_vertex_count: number;
}

export interface MjcfOptions {
  /** Shared across every fragment that goes into one model, so names never collide. */
  namer?: MjcfNamer;
  /** Body origin in metres. The mesh's lowest point sits at the origin's height. Default 2 mm above the floor. */
  pos?: readonly [number, number, number];
  /** Body orientation, w x y z. Default upright, as generated. */
  quat?: readonly [number, number, number, number];
  /** Base for the names. Anything outside [a-z0-9_] is replaced. */
  name?: string;
}

export class MjcfExportError extends Error {}

/** Hands out names that are safe in XML and unique within one model. */
export class MjcfNamer {
  private readonly used = new Set<string>();

  next(base: string): string {
    let clean = base.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    if (!/^[a-z]/.test(clean)) clean = `obj_${clean}`;
    clean = clean.slice(0, 40);
    let name = clean;
    for (let i = 2; this.used.has(name); i++) name = `${clean}_${i}`;
    this.used.add(name);
    return name;
  }
}

/** Seven decimals of a metre is 0.1 micrometre: far below anything the arm can feel. */
function num(v: number): string {
  return Number(v.toFixed(7)).toString();
}

function rgba(color: string): string {
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color : '#808080';
  const channel = (i: number): string => (Number.parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3);
  return `${channel(1)} ${channel(3)} ${channel(5)} 1`;
}

/** Export a receipt's object. Needs a hull and a mass, so BAD_MESH and NO_SINGLE_SCALE receipts cannot export. */
export function toMjcf(receipt: Receipt, options: MjcfOptions = {}): MjcfFragment {
  const { hull, mass_kg: mass, friction } = receipt;
  if (!hull || mass === null || !friction) {
    throw new MjcfExportError('This receipt has no safe mesh to export: the guardrail stopped before sizing it.');
  }
  const namer = options.namer ?? new MjcfNamer();
  const base = namer.next(options.name ?? `${receipt.spec.kind}_${receipt.spec.seed}`);
  const names: MjcfFragment['names'] = { mesh: `${base}_mesh`, body: base, geom: `${base}_geom`, joint: `${base}_free` };
  const pos = options.pos ?? [0, 0, 0.002];

  const vertices = (points: ArrayLike<number>): string => {
    const out: string[] = [];
    for (let i = 0; i < points.length; i++) out.push(num(points[i]!));
    return out.join(' ');
  };
  // maxhullvert is fixed at 64: lower values crashed MuJoCo in testing, so it is not an option.
  const meshTag = (name: string, points: ArrayLike<number>): string => `<mesh name="${name}" maxhullvert="${MAX_HULL_VERT}" vertex="${vertices(points)}"/>`;
  // MuJoCo takes the larger friction of two geoms of equal priority, and the pads are 1.0,
  // so only a deliberately slippery object gets priority="1".
  const priority = friction.priority ? ' priority="1"' : '';
  const geomTag = (name: string, mesh: string, kg: number, color: string): string =>
    `<geom name="${name}" type="mesh" mesh="${mesh}" mass="${kg.toPrecision(12)}" friction="${num(friction.mu)} 0.005 0.0001"${priority} rgba="${rgba(color)}"/>`;

  let asset: string;
  let geoms: string;
  let hullVertices: number;
  const parts = receipt.parts;
  if (parts && parts.length > 0) {
    names.parts = parts.map((part, i) => ({ mesh: `${base}_p${i + 1}_mesh`, geom: `${base}_p${i + 1}`, name: part.name }));
    names.mesh = names.parts[0]!.mesh;
    names.geom = names.parts[0]!.geom;
    asset = parts.map((part, i) => meshTag(names.parts![i]!.mesh, part.hull.points)).join('');
    geoms = parts.map((part, i) => geomTag(names.parts![i]!.geom, names.parts![i]!.mesh, part.mass_kg, part.color)).join('');
    hullVertices = parts.reduce((n, part) => n + part.hull.points.length / 3, 0);
  } else {
    asset = meshTag(names.mesh, hull.points);
    geoms = geomTag(names.geom, names.mesh, mass, receipt.spec.color);
    hullVertices = hull.points.length / 3;
  }
  const body =
    `<body name="${names.body}" pos="${pos.map(num).join(' ')}"${options.quat ? ` quat="${options.quat.map(num).join(' ')}"` : ''}>` +
    `<freejoint name="${names.joint}"/>` +
    geoms +
    `</body>`;
  return { asset, body, names, mass_kg: mass, friction: friction.mu, priority: friction.priority, hull_vertex_count: hullVertices };
}
