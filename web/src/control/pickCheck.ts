import type { ContactReport, Vec3 } from '../sim/simulation';

/** Bodies whose contact with the cube counts as the jaws touching it. */
export const JAW_BODIES = ['Fixed_Jaw', 'Moving_Jaw'] as const;

/** Acceptance thresholds for a scripted pick, in metres and seconds. */
export const PICK_CRITERIA = {
  waypointTolerance: 0.015,
  minRise: 0.05,
  minHoldS: 2,
  /** Deeper jaw-cube penetration than this counts as the cube intersecting the jaws. */
  maxPenetration: 0.001,
  /** After the jaws open the cube must be back near its rest height within this time. */
  fallWithinS: 1.5,
  restTolerance: 0.005,
};

export interface PickSample {
  t: number;
  phase: string;
  phaseIndex: number;
  settled: boolean;
  waypoint: Vec3;
  site: Vec3;
  cube: Vec3;
  /** Commanded grip, 0 open .. 1 closed. */
  grip: number;
  /** Jaw bodies touching the cube in this sample. */
  jawsTouching: string[];
  /** Most negative jaw-cube contact distance, or 0 with no contact. */
  jawMinDist: number;
}

export interface PickReport {
  pass: boolean;
  failures: string[];
  restZ: number;
  /** Error at the end of each phase's dwell, by phase name. */
  waypointErrors: Record<string, number>;
  maxRise: number;
  /** Longest stretch with the grip closed, both jaws on the cube and the cube up by minRise. */
  heldS: number;
  /** Deepest jaw-cube penetration while held, positive metres. */
  heldPenetration: number;
  /** Seconds from the open command until the cube was back at rest, or null if it never was. */
  fallS: number | null;
}

/** Reduces a body's contacts (the cube unless named) to what the pick check needs. */
export function jawContactSummary(contacts: readonly ContactReport[], bodyName = 'cube'): { jawsTouching: string[]; jawMinDist: number } {
  const touching = new Set<string>();
  let minDist = 0;
  for (const contact of contacts) {
    const other = contact.body1 === bodyName ? contact.body2 : contact.body1;
    if (!(JAW_BODIES as readonly string[]).includes(other)) continue;
    touching.add(other);
    minDist = Math.min(minDist, contact.dist);
  }
  return { jawsTouching: [...touching].sort(), jawMinDist: minDist };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function evaluatePick(samples: readonly PickSample[], restZ: number): PickReport {
  const c = PICK_CRITERIA;
  const failures: string[] = [];

  const waypointErrors: Record<string, number> = {};
  const lastSettled = new Map<number, PickSample>();
  for (const sample of samples) if (sample.settled && sample.phase !== 'done') lastSettled.set(sample.phaseIndex, sample);
  for (const sample of lastSettled.values()) {
    const error = distance(sample.site, sample.waypoint);
    waypointErrors[sample.phase] = error;
    if (error > c.waypointTolerance) failures.push(`${sample.phase}: end effector ${(error * 1000).toFixed(1)} mm from its waypoint`);
  }
  for (const phase of ['above', 'down', 'close', 'lift', 'hold', 'move', 'open']) {
    if (!(phase in waypointErrors)) failures.push(`${phase}: never settled at its waypoint`);
  }

  const maxRise = samples.reduce((best, sample) => Math.max(best, sample.cube[2] - restZ), -Infinity);
  if (!(maxRise >= c.minRise)) failures.push(`cube rose ${(maxRise * 1000).toFixed(1)} mm, needs ${c.minRise * 1000}`);

  let heldS = 0;
  let heldPenetration = 0;
  let runStart: PickSample | null = null;
  let runPenetration = 0;
  for (const sample of samples) {
    const held =
      sample.grip >= 0.99 &&
      sample.cube[2] - restZ >= c.minRise &&
      JAW_BODIES.every((body) => sample.jawsTouching.includes(body)) &&
      -sample.jawMinDist <= c.maxPenetration;
    if (held) {
      runStart ??= sample;
      runPenetration = Math.max(runPenetration, -sample.jawMinDist);
      if (sample.t - runStart.t > heldS) {
        heldS = sample.t - runStart.t;
        heldPenetration = runPenetration;
      }
    } else {
      runStart = null;
      runPenetration = 0;
    }
  }
  if (heldS < c.minHoldS) failures.push(`held ${heldS.toFixed(2)} s, needs ${c.minHoldS}`);

  const openAt = samples.find((sample) => sample.phase === 'open');
  let fallS: number | null = null;
  if (openAt) {
    const atRest = samples.find(
      (sample) => sample.t >= openAt.t && sample.cube[2] - restZ <= c.restTolerance && sample.jawsTouching.length === 0,
    );
    fallS = atRest ? atRest.t - openAt.t : null;
  }
  if (fallS === null || fallS > c.fallWithinS) failures.push(`cube did not fall within ${c.fallWithinS} s of opening (${fallS})`);

  return { pass: failures.length === 0, failures, restZ, waypointErrors, maxRise, heldS, heldPenetration, fallS };
}
