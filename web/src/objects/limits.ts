// Every limit the guardrail uses, in SI units, with the measurement behind it.
// [M] measured in MuJoCo 4.0.0 on the Menagerie trs_so_arm100 model, 2026-11-07.
// [I] inferred from those measurements. None of this was measured on a real arm.
// The real arm's payload is unverified, so these limits describe the simulated arm only.

/** Hard band. [M] 30 x 40 mm box: 3 mm lifted, but below 8 mm the jaw hits its closing limit (torque 0.77 N*m at 3 mm, saturated 3.5 from 8 mm). */
export const W_MIN = 0.01;
/** Hard band. [M] Widths to 90 mm lifted, but 80 mm needs jaw 1.57 rad and 90 mm the 1.75 limit; pads hinge, so the gap stops being parallel. */
export const W_MAX = 0.07;
/** Hard band. [M] A 60 mm box lifted, gripped at 30 mm. A 120 mm cylinder had no feasible IK. 60-120 mm untested. */
export const H_MAX = 0.06;
/** Hard band. [M] A 30 mm cube rose 76.5 mm at 0.3 kg and failed only at 2.5 kg, but sim is likely optimistic [I], so 0.30 kg, not more. */
export const M_MAX = 0.3;
/** [I] (3.5 N*m - 0.1 frictionloss) / 0.0676 m lever. Friction failures sat at 2*mu*F/(m*g) of about 1.06, a pass at 1.77. */
export const CLAMP_N = 50;

/** Hand-flown band. Prior-work audit: 70-80 mm was erratic, a heavier part succeeding where a lighter one failed, so 55 mm leaves margin. */
export const HAND_W_MAX = 0.055;
/** Hand-flown band. Prior-work audit: margin above the 8 mm edge where the jaw runs out of closing range. */
export const HAND_W_MIN = 0.015;
/** Hand-flown band. Prior-work audit: between the weak public 200 g and 500 g figures. Hand control has not been tested. */
export const HAND_M_MAX = 0.2;

/** [M] A 20 x 150 x 30 mm bar lifted at 50 g and 300 g with a centre grip. Longer was not tried, so this is where the evidence stops. */
export const L_MAX = 0.15;
/** [I] The fingertip reaches 4 mm above the floor (GRIP_Z_MIN - TIP_BELOW), plus MIN_PAD_OVERLAP. A flatter object stays under the pads. */
export const H_MIN = 0.008;
/** [M, research pipeline step 8] Lowest grip height: fingertip 14.4 mm below the grip point plus clearance. */
export const GRIP_Z_MIN = 0.0184;
/** [M, read from XML] Fingertip distance below the grip point at depth -0.092 in the Fixed_Jaw frame. */
export const TIP_BELOW = 0.0144;
/** [M, read from XML] Tip pad length along the finger. */
export const PAD_LENGTH = 0.01;
/** [M, read from XML] Half the width of the tip pads across the jaw axis (box half-sizes 4 to 6 mm). */
export const PAD_HALF_WIDTH = 0.005;
/** [M] The widest gap the jaw opens: 90 mm needs the jaw's 1.75 rad limit (see W_MAX). */
export const JAW_MAX_GAP = 0.09;
/** Research pipeline step 10: the lift test opens the jaw to the object's width plus this. Same value as JAW_EXTRA_OPENING in sim/liftTester.ts. */
export const JAW_EXTRA_GAP = 0.016;
/** [I] Pad length that must overlap the object. A design margin, not a measured failure. */
export const MIN_PAD_OVERLAP = 0.004;
/**
 * [I] How close a hull face must come to a pad to count as one the pad can settle on. On the
 * five presets and the comet ice shard the grip angle was the same at 0.5, 1 and 2 mm [M].
 */
export const GRIP_TOUCH_TOL = 0.001;

/** Pipeline step 4: width is sampled every 15 degrees over 180 degrees, because width repeats after a half turn. */
export const YAW_STEP_DEG = 15;
/** [M] Over 2,500 vertices is wasted on collision; compile time went from 66 ms at 2,562 verts to 445 ms at 40,962. */
export const MESH_MAX_INPUT_VERTICES = 2500;
/** Research: warn over 30 percent, because fingers may look like they hold air around the hidden filled volume. */
export const HULL_FILL_WARN_PERCENT = 30;
/** [M] maxhullvert=3 segfaulted MuJoCo in testing. Fixed at 64 and deliberately not an option anywhere. */
export const MAX_HULL_VERT = 64;

/** [M] Irregular asteroids rolled up to 29 mm after spawning. Task rule: note anything above 10 mm. */
export const ROLL_NOTE_MM = 10;
/** [M] Research pipeline step 3: settle for 1.5 s. */
export const SETTLE_MAX_SECONDS = 1.5;

/** [M, research] Verdict lift height. */
export const LIFT_HEIGHT = 0.08;
/** [M, research] A lift passes if the rise is at least 60 percent of LIFT_HEIGHT, which is 48 mm. */
export const LIFT_PASS_RISE = 0.6 * LIFT_HEIGHT;
/** [M, research] Grasps were retried at the next-best yaw twice, so three attempts in all. */
export const LIFT_MAX_ATTEMPTS = 3;

/** m/s^2. Research physics menu: Earth, Mars and Moon from NSSDC; Bennu calculated from JPL SBDB GM and diameter, ignoring spin; orbit is 0 in sim. */
export const GRAVITY = {
  earth: 9.82,
  mars: 3.73,
  moon: 1.62,
  bennu: 8.3e-5,
  orbit: 0,
} as const;

export interface Band {
  readonly name: 'hand-flown' | 'hard';
  readonly w_min: number;
  readonly w_max: number;
  readonly h_max: number;
  readonly m_max: number;
}

export const HARD_BAND: Band = { name: 'hard', w_min: W_MIN, w_max: W_MAX, h_max: H_MAX, m_max: M_MAX };
export const HAND_BAND: Band = { name: 'hand-flown', w_min: HAND_W_MIN, w_max: HAND_W_MAX, h_max: H_MAX, m_max: HAND_M_MAX };
