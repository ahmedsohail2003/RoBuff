import type { Vec3 } from '../sim/simulation';

/**
 * Where the gripper site may be sent. Measured from the model: the Rotation joint's axis
 * is vertical through (0, -0.0452), the Pitch joint (shoulder) sits at (0, -0.0758, 0.119)
 * at home, and the fixed jaw tip reaches about 1 cm below the gripper site.
 */
export interface Workspace {
  /** Vertical axis of the base rotation, as world x, y. */
  baseAxis: [number, number];
  /** Closest horizontal distance to the base axis. Keeps the jaws out of the base. */
  minRadius: number;
  shoulder: Vec3;
  /** Farthest distance from the shoulder. */
  maxReach: number;
  minZ: number;
  maxZ: number;
}

export const ARM_WORKSPACE: Workspace = {
  baseAxis: [0, -0.0452],
  minRadius: 0.08,
  shoulder: [0, -0.0758, 0.119],
  // An IK scan reached (0, -0.40, 0.02), 0.339 m from the shoulder, within 3 mm.
  maxReach: 0.33,
  minZ: 0.012,
  maxZ: 0.3,
};

/** The nearest point to p that the workspace allows. Never returns NaN for finite input. */
export function clampTarget(p: Vec3, ws: Workspace = ARM_WORKSPACE): Vec3 {
  let [x, y, z] = p.map((value) => (Number.isFinite(value) ? value : 0)) as Vec3;
  z = Math.min(ws.maxZ, Math.max(ws.minZ, z));

  // Outside the shoulder's reach: pull back along the line to the shoulder.
  const dx = x - ws.shoulder[0];
  const dy = y - ws.shoulder[1];
  const dz = z - ws.shoulder[2];
  const reach = Math.hypot(dx, dy, dz);
  if (reach > ws.maxReach) {
    const k = ws.maxReach / reach;
    x = ws.shoulder[0] + dx * k;
    y = ws.shoulder[1] + dy * k;
    z = Math.min(ws.maxZ, Math.max(ws.minZ, ws.shoulder[2] + dz * k));
  }

  // Inside the base column: push out horizontally. On the axis itself, push forward (-y).
  const rx = x - ws.baseAxis[0];
  const ry = y - ws.baseAxis[1];
  const radius = Math.hypot(rx, ry);
  if (radius < ws.minRadius) {
    const [ux, uy] = radius > 1e-9 ? [rx / radius, ry / radius] : [0, -1];
    x = ws.baseAxis[0] + ux * ws.minRadius;
    y = ws.baseAxis[1] + uy * ws.minRadius;
  }
  return [x, y, z];
}
