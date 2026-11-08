// Voice pick, place and drop: the lift test's grasp (sim/liftTester.ts) aimed at the object's
// LIVE pose and played through the voice source on the live arm. The planners are pure; the
// runners take what they read and do as functions, so the unit tests can drive them headless.
//
// A pick counts as holding only when MuJoCo agrees: the centre of mass rose at least 48 mm
// (the lift test's pass rise), both jaw bodies touch it, and the grip command is closed.

import { LIFT_PASS_RISE } from '../objects/limits';
import { APPROACH_HEIGHT, JAW_EXTRA_OPENING, LIFT_CLEARANCE } from '../sim/liftTester';
import type { LiveObject } from '../sim/liveObject';
import { alongJaw, GRIP_POINT_ABOVE_SITE, graspSiteForFrame } from '../sim/objectSlot';
import type { Vec3 } from '../sim/simulation';
import type { StepsOutcome, VoiceStep } from '../input/voiceSource';
import { GRIP_Z_MIN } from '../objects/limits';
import { closingYawFor } from './grasp';
import { HAND_WORKSPACE } from './handMapping';
import { VOICE_MOTION, moveDuration } from './voiceMotion';
import { clampTarget } from './workspace';

/** The jaw widths the guardrail allows (objects/limits.ts hard band), m. */
export const PICK_MIN_WIDTH = 0.01;
export const PICK_MAX_WIDTH = 0.07;
export const PICK_LIFT = 0.08;
export const PLACE_RISE = 0.07;
/** No jaw contact for this long while holding counts as a drop, s (trials/protocol.ts uses contact plus height). */
export const DROP_NO_CONTACT_S = 0.1;

export interface JawModel {
  /** [closed, open] jaw angles, rad. */
  range: [number, number];
  angleForGap(gap: number): number;
}

export interface PickPlanOk {
  ok: true;
  steps: VoiceStep[];
  grasp: Vec3;
  openGrip: number;
  width: number;
  restZ: number;
  heading: number;
}
export type PickPlanResult = PickPlanOk | { ok: false; refuse: string };

const mm = (m: number): string => `${Math.round(m * 1000)}`;

/** The lift test's grasp on the object where it is now: above, down, close, lift, hold. */
export function planPick(obj: LiveObject, jaw: JawModel, from: Vec3): PickPlanResult {
  const heading = closingYawFor(obj.com);
  const frame = alongJaw(obj.points, heading, [obj.com[0], obj.com[1]]);
  const width = 2 * frame.halfWidth;
  if (!(width >= PICK_MIN_WIDTH && width <= PICK_MAX_WIDTH)) {
    return { ok: false, refuse: `It is ${mm(width)} millimetres across my jaw, and I can only grip 10 to 70 millimetres.` };
  }
  const siteZ = Math.max(frame.height / 2, GRIP_Z_MIN) + frame.lowest - GRIP_POINT_ABOVE_SITE;
  const grasp = graspSiteForFrame(frame, siteZ, LIFT_CLEARANCE);
  const above: Vec3 = [grasp[0], grasp[1], grasp[2] + APPROACH_HEIGHT];
  const lifted: Vec3 = [grasp[0], grasp[1], grasp[2] + PICK_LIFT];
  for (const point of [grasp, above, lifted]) {
    const kept = clampTarget(point, HAND_WORKSPACE);
    if (Math.hypot(kept[0] - point[0], kept[1] - point[1], kept[2] - point[2]) > 0.002) {
      return { ok: false, refuse: `It is out of my reach there: the grasp would be ${mm(Math.hypot(kept[0] - point[0], kept[1] - point[1], kept[2] - point[2]))} millimetres outside the box I can reach.` };
    }
  }
  const [closed, open] = jaw.range;
  const openGrip = Math.min(1, Math.max(0, (open - jaw.angleForGap(width + JAW_EXTRA_OPENING)) / (open - closed)));
  const toAbove = Math.hypot(above[0] - from[0], above[1] - from[1], above[2] - from[2]);
  const steps: VoiceStep[] = [
    { name: 'above', waypoint: above, grip: openGrip, moveS: Math.max(2, moveDuration(toAbove)), dwellS: 0.6 },
    { name: 'down', waypoint: grasp, grip: openGrip, moveS: 1.5, dwellS: 0.7 },
    { name: 'close', waypoint: grasp, grip: 1, moveS: 0.6, dwellS: 0.8 },
    { name: 'lift', waypoint: lifted, grip: 1, moveS: 1.5, dwellS: 0.6 },
    { name: 'hold', waypoint: lifted, grip: 1, moveS: 0, dwellS: 1 },
  ];
  return { ok: true, steps, grasp, openGrip, width, restZ: obj.com[2], heading };
}

/** Lower what is held until its lowest point is 2 mm over the floor, open to the pick opening, rise 7 cm. */
export function planPlace(obj: LiveObject, site: Vec3, openGrip: number): VoiceStep[] {
  const z = Math.max(HAND_WORKSPACE.minZ, site[2] - (obj.lowest - 0.002));
  const down: Vec3 = [site[0], site[1], z];
  const up: Vec3 = [site[0], site[1], z + PLACE_RISE];
  return [
    { name: 'lower', waypoint: down, grip: 1, moveS: Math.max(1.5, moveDuration(site[2] - z)), dwellS: 0.5 },
    { name: 'release', waypoint: down, grip: openGrip, moveS: VOICE_MOTION.gripS, dwellS: 0.8 },
    { name: 'retreat', waypoint: up, grip: openGrip, moveS: 1.5, dwellS: 0.3 },
  ];
}

/** Open the jaw fully where the arm is and wait for it to fall. */
export function planDrop(site: Vec3): VoiceStep[] {
  return [{ name: 'release', waypoint: site, grip: 0, moveS: VOICE_MOTION.gripS, dwellS: 1.5 }];
}

export interface PickCheck {
  ok: boolean;
  riseMm: number;
  jaws: string[];
  closed: boolean;
}

export function checkPick(riseM: number, jaws: readonly string[], grip: number): PickCheck {
  const both = jaws.includes('Fixed_Jaw') && jaws.includes('Moving_Jaw');
  const closed = grip >= 0.999;
  return { ok: riseM >= LIFT_PASS_RISE && both && closed, riseMm: riseM * 1000, jaws: [...jaws], closed };
}

export function jawWords(jaws: readonly string[]): string {
  if (jaws.length >= 2) return 'both jaws on it';
  if (jaws.length === 1) return `only the ${jaws[0] === 'Fixed_Jaw' ? 'fixed' : 'moving'} jaw on it`;
  return 'no jaw on it';
}

export function pickLine(check: PickCheck): string {
  if (check.ok) return `Holding it, up ${Math.round(check.riseMm)} millimetres, ${jawWords(check.jaws)}.`;
  return `I could not hold it: it rose ${Math.round(check.riseMm)} millimetres with ${jawWords(check.jaws)}, so I let go and backed off.`;
}

/** What a runner needs from the live scene. */
export interface MacroWorld {
  run(steps: VoiceStep[], label: string): Promise<StepsOutcome>;
  read(): LiveObject;
  jaws(): string[];
  /** The grip command sent now (0 open .. 1 closed). */
  grip(): number;
  site(): Vec3;
}

export interface Holding {
  body: string;
  openGrip: number;
  restZ: number;
}

export type MacroResult = { ok: true; line: string; holding: Holding | null; check?: PickCheck } | { ok: false; line: string; cancelled?: boolean; check?: PickCheck };

const CANCELLED = 'I stopped partway, so I am holding where I am. Say it again to try once more.';

export async function runPick(world: MacroWorld, plan: PickPlanOk): Promise<MacroResult> {
  const outcome = await world.run(plan.steps, 'picking it up');
  if (outcome === 'cancelled') return { ok: false, line: CANCELLED, cancelled: true };
  const obj = world.read();
  const check = checkPick(obj.com[2] - plan.restZ, world.jaws(), world.grip());
  if (check.ok) return { ok: true, line: pickLine(check), holding: { body: obj.body, openGrip: plan.openGrip, restZ: plan.restZ }, check };
  // A failed pick: let go to the approach opening and back off upward.
  const site = world.site();
  await world.run(
    [
      { name: 'release', waypoint: site, grip: plan.openGrip, moveS: VOICE_MOTION.gripS, dwellS: 0.5 },
      { name: 'retreat', waypoint: [site[0], site[1], site[2] + APPROACH_HEIGHT], grip: plan.openGrip, moveS: 1, dwellS: 0.3 },
    ],
    'backing off',
  );
  return { ok: false, line: pickLine(check), check };
}

export async function runPlace(world: MacroWorld, holding: Holding): Promise<MacroResult> {
  const steps = planPlace(world.read(), world.site(), holding.openGrip);
  const outcome = await world.run(steps, 'putting it down');
  if (outcome === 'cancelled') return { ok: false, line: CANCELLED, cancelled: true };
  const obj = world.read();
  const jaws = world.jaws();
  if (jaws.length > 0) return { ok: false, line: `I opened, but ${jawWords(jaws).replace(' on it', '')} still touches it.` };
  const lowMm = Math.round(Math.max(0, obj.lowest) * 1000);
  return { ok: true, line: lowMm <= 5 ? 'Put it down. It is on the floor and the jaw is clear.' : `I let go, but its lowest point is ${lowMm} millimetres up.`, holding: null };
}

export async function runDrop(world: MacroWorld): Promise<MacroResult> {
  const outcome = await world.run(planDrop(world.site()), 'dropping it');
  if (outcome === 'cancelled') return { ok: false, line: CANCELLED, cancelled: true };
  const obj = world.read();
  const lowMm = Math.round(Math.max(0, obj.lowest) * 1000);
  if (world.jaws().length === 0 && lowMm <= 5) return { ok: true, line: 'Dropped it. It is on the floor.', holding: null };
  if (world.jaws().length === 0) return { ok: true, line: `Let go. It is ${lowMm} millimetres up and not touching the jaw, so in this gravity it may be floating.`, holding: null };
  return { ok: false, line: 'I opened the jaw, but it is still touching it.' };
}
