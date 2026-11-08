// The ghost error meter's arithmetic. The operator sees the truth arm 1.28 s late, and the
// truth arm runs each command 1.28 s after it was sent, so the truth pose on screen now is
// the result of commands sent 2.56 s ago. The ghost ran those same commands the moment they
// were sent, so the fair comparison is: truth as seen now against the ghost as it was 2.56 s
// ago. Both are known at the operator's end; nothing here peeks at the truth before the
// operator could see it.

import type { Vec3 } from '../sim/simulation';

/** Under this the ghost is a good guide (green). */
export const GREEN_BELOW_MM = 5;
/** Up to this, amber; above it, red with the cue "wait for truth". */
export const AMBER_TO_MM = 20;

export type ErrorLevel = 'green' | 'amber' | 'red';

export function distanceMm(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 1000;
}

export function errorLevel(mm: number): ErrorLevel {
  if (mm < GREEN_BELOW_MM) return 'green';
  if (mm <= AMBER_TO_MM) return 'amber';
  return 'red';
}

export function errorCue(level: ErrorLevel): string {
  return level === 'red' ? 'wait for truth' : level === 'amber' ? 'ghost drifting from truth' : 'ghost matches truth';
}

/** Where the gripper and the rock are at one moment. */
export interface ArmSample {
  gripper: Vec3;
  rock: Vec3 | null;
}

export interface GhostError {
  gripper_mm: number;
  rock_mm: number | null;
  level: ErrorLevel;
}

/** Truth as seen against the ghost at the matching command time. The level follows the larger of the two errors. */
export function ghostError(truthSeen: ArmSample, ghostMatched: ArmSample): GhostError {
  const gripper = distanceMm(truthSeen.gripper, ghostMatched.gripper);
  const rock = truthSeen.rock && ghostMatched.rock ? distanceMm(truthSeen.rock, ghostMatched.rock) : null;
  return { gripper_mm: gripper, rock_mm: rock, level: errorLevel(Math.max(gripper, rock ?? 0)) };
}

/** Running max and mean of an error, for a trial row. */
export class ErrorStats {
  private sum = 0;
  private n = 0;
  max: number | null = null;

  add(mm: number): void {
    if (!Number.isFinite(mm)) return;
    this.sum += mm;
    this.n++;
    this.max = this.max === null ? mm : Math.max(this.max, mm);
  }

  get mean(): number | null {
    return this.n === 0 ? null : this.sum / this.n;
  }

  get count(): number {
    return this.n;
  }
}
