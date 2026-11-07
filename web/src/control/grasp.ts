import { FIXED_PAD_FACE_X } from '../sim/armXml';
import type { Vec3 } from '../sim/simulation';
import { ARM_WORKSPACE } from './workspace';

/**
 * Jaw closing axis heading for a target, in radians about world z. The jaws close across
 * the line from the base to the target, as they do at the home pose (heading 0 = world +x
 * while the arm faces -y). Directly over the base axis the home heading is kept.
 */
export function closingYawFor(target: Vec3, baseAxis: [number, number] = ARM_WORKSPACE.baseAxis): number {
  const rx = target[0] - baseAxis[0];
  const ry = target[1] - baseAxis[1];
  if (Math.hypot(rx, ry) < 1e-6) return 0;
  return Math.atan2(rx, -ry);
}

/**
 * Where to put the gripper site so a box of the given half width sits between the jaws,
 * `clearance` metres from the fixed jaw pad. The fixed jaw does not move: the moving jaw
 * closes the gap. heightAboveCenter puts the tip pads across the middle of the box.
 */
export function graspSiteFor(center: Vec3, halfWidth: number, clearance: number, heightAboveCenter: number): Vec3 {
  const yaw = closingYawFor(center);
  const offset = halfWidth + clearance - FIXED_PAD_FACE_X;
  return [center[0] + Math.cos(yaw) * offset, center[1] + Math.sin(yaw) * offset, center[2] + heightAboveCenter];
}
