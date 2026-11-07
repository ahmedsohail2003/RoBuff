// The cheap pipeline, in order: sanity, hull, yaw, rescale, mass, friction, grip height.
// It can rule an object out. It cannot prove a lift: only the simulated lift test can.

import { generateMesh } from './generate/index';
import { checkSanity, extents, gripFaceAngleDeg, hullWidthAtHeight, hullFillPercent, sweepYaw, transformPoints } from './geometry';
import { convexHull, type ConvexHull } from './hull';
import {
  CLAMP_N,
  GRAVITY,
  GRIP_TOUCH_TOL,
  GRIP_Z_MIN,
  H_MIN,
  HAND_BAND,
  HARD_BAND,
  HULL_FILL_WARN_PERCENT,
  L_MAX,
  LIFT_MAX_ATTEMPTS,
  MESH_MAX_INPUT_VERTICES,
  MIN_PAD_OVERLAP,
  PAD_LENGTH,
  TIP_BELOW,
  W_MAX,
  W_MIN,
  type Band,
} from './limits';
import { MATERIALS } from './materials';
import { transformMesh, type ObjectMesh } from './mesh';
import { lines } from './messages';
import { isRefused, type FrictionCheck, type Receipt, type ReceiptStep } from './receipt';
import { normalizeSpec, type ObjectSpec } from './spec';
import { say } from './format';

export interface ValidateOptions {
  /** Gravity magnitude in m/s^2. Default Earth, 9.82. */
  gravity_m_s2?: number;
  /** Which limits to author into. Default the narrower hand-flown band. */
  band?: 'hand-flown' | 'hard';
  /** Override density, kept inside the material's range. Default the material's value. */
  density_g_cc?: number;
}

const MM = 1000;
/** Rescaled objects land this far inside a limit, so rounding never leaves them on the line. */
const INSIDE_MARGIN = 0.001;
/** When the request is already being shrunk to less than half, it is a model anyway, so size it for mass too. */
const MODEL_SCALE = 0.5;

function step(code: ReceiptStep['code'], ok: boolean, measured: number | null, limit: number | null, unit: string, message: string, action: ReceiptStep['action']): ReceiptStep {
  return { code, ok, measured, limit, unit, message, action };
}

/** Generate the mesh from a spec and run the pipeline. Never throws on bad input. */
export function validate(rawSpec: unknown, options: ValidateOptions = {}): Receipt {
  const { spec, clamps } = normalizeSpec(rawSpec);
  return runPipeline(generateMesh(spec), spec, options, clamps);
}

/** Run the pipeline on a mesh from any source. The spec supplies material and labels. Never throws on bad input. */
export function validateMesh(mesh: Partial<ObjectMesh>, rawSpec: unknown, options: ValidateOptions = {}): Receipt {
  const { spec, clamps } = normalizeSpec(rawSpec);
  const safe: ObjectMesh = {
    positions: mesh.positions instanceof Float32Array ? mesh.positions : new Float32Array(0),
    indices: mesh.indices instanceof Uint32Array ? mesh.indices : new Uint32Array(0),
    normals: mesh.normals instanceof Float32Array ? mesh.normals : new Float32Array(0),
  };
  return runPipeline(safe, spec, options, clamps);
}

/** Every k-th vertex: keeps the cloud's outline well enough for a collision hull. */
function decimate(positions: Float32Array, keep: number): Float64Array {
  const count = positions.length / 3;
  const stride = count / keep;
  const out = new Float64Array(keep * 3);
  for (let i = 0; i < keep; i++) {
    const source = Math.min(count - 1, Math.floor(i * stride)) * 3;
    out[i * 3] = positions[source]!;
    out[i * 3 + 1] = positions[source + 1]!;
    out[i * 3 + 2] = positions[source + 2]!;
  }
  return out;
}

interface ScaleWindow {
  low: number;
  high: number;
  lowReason: 'width' | 'height';
  highReason: 'width' | 'height' | 'length';
}

function scaleWindow(narrow: number, height: number, length: number, band: Band): ScaleWindow {
  const lowByWidth = band.w_min / narrow;
  const lowByHeight = H_MIN / height;
  const highByWidth = band.w_max / narrow;
  const highByHeight = band.h_max / height;
  const highByLength = L_MAX / length;
  const high = Math.min(highByWidth, highByHeight, highByLength);
  return {
    low: Math.max(lowByWidth, lowByHeight),
    high,
    lowReason: lowByWidth >= lowByHeight ? 'width' : 'height',
    highReason: high === highByWidth ? 'width' : high === highByHeight ? 'height' : 'length',
  };
}

function runPipeline(mesh: ObjectMesh, spec: ObjectSpec, options: ValidateOptions, clamps: string[]): Receipt {
  const steps: ReceiptStep[] = clamps.map((text) => step('SPEC_CLAMPED', false, null, null, '', `I adjusted the request: ${text}`, 'clamped'));
  const material = MATERIALS[spec.material];
  let band: Band = options.band === 'hard' ? HARD_BAND : HAND_BAND;

  let gravity: number = GRAVITY.earth;
  if (options.gravity_m_s2 !== undefined) {
    if (Number.isFinite(options.gravity_m_s2)) gravity = Math.abs(options.gravity_m_s2);
    else steps.push(step('SPEC_CLAMPED', false, null, null, 'm/s2', `I adjusted the request: gravity was ${options.gravity_m_s2}, so I used Earth, ${GRAVITY.earth}.`, 'clamped'));
  }

  let density = material.density_g_cc;
  if (options.density_g_cc !== undefined) {
    const [lo, hi] = material.density_range_g_cc;
    const asked = Number.isFinite(options.density_g_cc) ? options.density_g_cc : density;
    density = Math.min(hi, Math.max(lo, asked));
    if (density !== options.density_g_cc) {
      steps.push(step('SPEC_CLAMPED', false, asked, hi, 'g/cc', `I adjusted the request: density ${options.density_g_cc} is outside ${material.label} range ${lo}-${hi} g/cc, so I used ${density}.`, 'clamped'));
    }
  }

  const requested = extents(mesh.positions).size.map((v) => v * MM) as [number, number, number];
  const receipt: Receipt = {
    schema: 's5-receipt-v1',
    verdict: 'READY_FOR_LIFT_TEST',
    adjusted: false,
    spec,
    band,
    material,
    density_g_cc: density,
    gravity_m_s2: gravity,
    steps,
    mesh: null,
    hull: null,
    scale: null,
    requested_size_mm: requested.every(Number.isFinite) ? requested : [spec.width_mm, spec.width_mm, spec.height_mm],
    size_mm: null,
    narrow_width_mm: null,
    hull_volume_cm3: null,
    hull_fill_percent: null,
    mass_kg: null,
    friction: null,
    yaw_deg: null,
    yaw_candidates_deg: [],
    grip_z_mm: null,
    rest: null,
    lift: { status: 'not_run', message: '', attempts: [] },
  };

  const finish = (): Receipt => {
    const refused = isRefused(steps);
    const liftLine = lines.liftNotRun(refused);
    steps.push(step('LIFT_NOT_RUN', false, null, null, '', liftLine, 'pending'));
    receipt.lift = { status: 'not_run', message: liftLine, attempts: [] };
    receipt.verdict = refused ? 'REFUSED' : 'READY_FOR_LIFT_TEST';
    receipt.adjusted = steps.some((s) => s.action === 'rescaled' || s.action === 'clamped');
    receipt.band = band;
    return receipt;
  };

  // 1. Sanity.
  const sanity = checkSanity(mesh.positions, mesh.indices);
  if (!sanity.ok) {
    const detail: Record<string, [string, string, number, number, string]> = {
      not_finite: ['has numbers that are not finite', `${say(sanity.non_finite_values)} ${sanity.non_finite_values === 1 ? 'coordinate is' : 'coordinates are'} NaN or infinite.`, sanity.non_finite_values, 0, 'non-finite values'],
      too_few_vertices: ['has too few vertices', `It has ${say(sanity.vertex_count)}; a solid needs at least 4.`, sanity.vertex_count, 4, 'vertices'],
      bad_index: ['points at vertices that do not exist', 'A triangle index is out of range.', sanity.vertex_count, sanity.vertex_count, 'vertices'],
      coincident: ['is a single point', 'All its vertices sit in one place.', 0, 0, 'mm'],
      collinear: ['is a line', 'All its vertices sit on one line, so it has no volume.', 0, 0, 'mm'],
      coplanar: ['is flat', 'All its vertices sit in one plane, so it has no volume.', 0, 0, 'mm'],
    };
    const [problem, text, measured, limit, unit] = detail[sanity.problem!]!;
    steps.push(step('BAD_MESH', false, measured, limit, unit, lines.badMesh(problem, text), 'refused'));
    return finish();
  }
  steps.push(step('SANITY_OK', true, sanity.vertex_count, 4, 'vertices', lines.sanityOk(sanity.vertex_count), 'none'));

  let points: ArrayLike<number> = mesh.positions;
  if (sanity.vertex_count > MESH_MAX_INPUT_VERTICES) {
    points = decimate(mesh.positions, MESH_MAX_INPUT_VERTICES);
    steps.push(step('DECIMATED', true, sanity.vertex_count, MESH_MAX_INPUT_VERTICES, 'vertices', lines.decimated(sanity.vertex_count, MESH_MAX_INPUT_VERTICES), 'note'));
  }

  // 2. Hull.
  const hull0 = convexHull(points);
  if (!hull0) {
    steps.push(step('BAD_MESH', false, 0, null, 'cm3', lines.badMesh('has no volume I can measure', 'Its convex hull came out empty.'), 'refused'));
    return finish();
  }
  const fill = hullFillPercent(hull0.volume, mesh.positions, mesh.indices);
  receipt.hull_fill_percent = fill;
  steps.push(step('HULL_OK', true, hull0.volume * 1e6, null, 'cm3', lines.hullOk(hull0.volume * 1e6, hull0.points.length / 3), 'none'));
  if (fill !== null && fill > HULL_FILL_WARN_PERCENT) {
    steps.push(step('HULL_FILL', true, fill, HULL_FILL_WARN_PERCENT, 'percent', lines.hullFill(fill), 'note'));
  }

  // 3. Yaw: narrowest width per 15 degrees.
  const sweep = sweepYaw(hull0.points);
  const narrow0 = sweep[0]!.width;
  const long0 = sweep[sweep.length - 1]!.width;
  const box0 = extents(hull0.points);
  const height0 = box0.size[2];
  receipt.yaw_deg = sweep[0]!.yaw_deg;
  receipt.yaw_candidates_deg = sweep.map((s) => s.yaw_deg);
  steps.push(step('YAW_CHOSEN', true, narrow0 * MM, null, 'mm', lines.yawChosen(narrow0 * MM, sweep[0]!.yaw_deg, long0 * MM), 'note'));

  // 4. Uniform rescale into the band.
  let fit = scaleWindow(narrow0, height0, long0, band);
  if (fit.low > fit.high && band.name === 'hand-flown') {
    // No hand-flown size: try the hard limits. If those fail too, the refusal quotes the hard limits, the arm's real edge.
    band = HARD_BAND;
    fit = scaleWindow(narrow0, height0, long0, HARD_BAND);
    if (fit.low <= fit.high) steps.push(step('OUTSIDE_HAND_BAND', false, null, null, '', lines.outsideHandBand(), 'note'));
  }
  if (fit.low > fit.high) {
    const s = fit.high;
    const ceiling = {
      width: `my ${say(band.w_max * MM)} millimetre jaw`,
      height: `my ${say(band.h_max * MM)} millimetre height limit`,
      length: `the ${say(L_MAX * MM)} millimetre length I have evidence for`,
    }[fit.highReason];
    const floor =
      fit.lowReason === 'width'
        ? `its narrowest side would be ${say(narrow0 * s * MM)} millimetres and my jaw needs at least ${say(band.w_min * MM)}`
        : `it would stand ${say(height0 * s * MM)} millimetres tall and my fingertips need at least ${say(H_MIN * MM)}`;
    const measured = fit.lowReason === 'width' ? narrow0 * s * MM : height0 * s * MM;
    const limit = fit.lowReason === 'width' ? band.w_min * MM : H_MIN * MM;
    steps.push(step('NO_SINGLE_SCALE', false, measured, limit, 'mm', lines.noSingleScale(Math.max(long0, height0) * MM, ceiling, floor, s), 'refused'));
    return finish();
  }

  let scale = 1;
  if (fit.low > 1) scale = Math.min(fit.high, fit.low * (1 + INSIDE_MARGIN));
  else if (fit.high < 1) scale = Math.max(fit.low, fit.high * (1 - INSIDE_MARGIN));

  const rho = density * 1000;
  let sizedForMass = false;
  if (scale < MODEL_SCALE) {
    const massAtScale = hull0.volume * scale ** 3 * rho;
    if (massAtScale > band.m_max) {
      const massScale = Math.cbrt((band.m_max * 0.98) / (hull0.volume * rho));
      if (massScale >= fit.low) {
        scale = massScale;
        sizedForMass = true;
      }
    }
  }

  const across0 = Math.max(box0.size[0], box0.size[1]);
  const fin = { narrow: narrow0 * scale * MM, long: long0 * scale * MM, across: across0 * scale * MM, height: height0 * scale * MM };
  if (scale === 1) {
    steps.push(step('SCALE_OK', true, narrow0 * MM, band.w_max * MM, 'mm', lines.scaleOk(narrow0 * MM, height0 * MM), 'none'));
  } else {
    if (narrow0 > band.w_max) {
      let text = lines.tooWide(across0 * MM, narrow0 * MM, band.w_max * MM, W_MAX * MM, band.name, fin.narrow, fin.across);
      if (sizedForMass) text += ` I sized it to stay under my ${say(band.m_max * 1000)} gram limit.`;
      steps.push(step('TOO_WIDE', false, narrow0 * MM, band.w_max * MM, 'mm', text, 'rescaled'));
    }
    if (narrow0 < band.w_min) steps.push(step('TOO_SMALL', false, narrow0 * MM, band.w_min * MM, 'mm', lines.tooSmall(narrow0 * MM, band.w_min * MM, fin.narrow), 'rescaled'));
    if (height0 > band.h_max) steps.push(step('TOO_TALL', false, height0 * MM, band.h_max * MM, 'mm', lines.tooTall(height0 * MM, band.h_max * MM, fin.height), 'rescaled'));
    if (height0 < H_MIN) steps.push(step('TOO_SHORT', false, height0 * MM, H_MIN * MM, 'mm', lines.tooShort(height0 * MM, H_MIN * MM, fin.height), 'rescaled'));
    if (long0 > L_MAX) steps.push(step('TOO_LONG', false, long0 * MM, L_MAX * MM, 'mm', lines.tooLong(long0 * MM, L_MAX * MM, fin.long), 'rescaled'));
  }

  // Final geometry: centred in x and y, lowest point on z = 0.
  const shift: [number, number, number] = [
    (-(box0.min[0] + box0.max[0]) / 2) * scale,
    (-(box0.min[1] + box0.max[1]) / 2) * scale,
    -box0.min[2] * scale,
  ];
  const hull: ConvexHull = { points: transformPoints(hull0.points, scale, shift), faces: hull0.faces, volume: hull0.volume * scale ** 3 };
  receipt.scale = scale;
  receipt.mesh = transformMesh(mesh, scale, shift);
  receipt.hull = hull;
  receipt.size_mm = box0.size.map((v) => v * scale * MM) as [number, number, number];
  receipt.narrow_width_mm = fin.narrow;
  receipt.hull_volume_cm3 = hull.volume * 1e6;

  // 5. Mass from hull volume and density. Set explicitly in MJCF, never left to MuJoCo.
  const mass = hull.volume * rho;
  receipt.mass_kg = mass;
  if (mass > band.m_max) {
    const lighter = Math.cbrt((band.m_max * 0.98) / mass);
    const suggestion =
      narrow0 * scale * lighter >= band.w_min && height0 * scale * lighter >= H_MIN
        ? `At ${say(fin.narrow * lighter)} millimetres across it would be ${say(mass * lighter ** 3 * 1000)} grams. Ask for that, or pick a lighter material.`
        : 'No size my jaw can hold is light enough in this material. Pick a lighter one.';
    steps.push(step('TOO_HEAVY', false, mass, band.m_max, 'kg', lines.tooHeavy(material.label, mass, band.m_max, band.name, HARD_BAND.m_max, suggestion), 'refused'));
  } else {
    steps.push(step('MASS_OK', true, mass, band.m_max, 'kg', lines.massOk(material.label, hull.volume * 1e6, density, material.density_basis, mass, band.m_max, band.name), 'none'));
  }

  // 6. Friction, two parts. Weight: 2 * mu * CLAMP_N >= 2 * m * g, at the gravity given.
  // Squeeze: the pads meet the hull off square, and squeezing pushes it out unless mu covers
  // that angle (mu >= tan), at any gravity. The lift test showed this, not weight, is what
  // drops slippery shapes: the 8 g comet ice shard needs 0.0016 for its weight, yet dropped.
  const mu = material.friction;
  const weightMu = (mass * gravity) / CLAMP_N;
  const squeeze = squeezeAngle(hull, sweep.slice(0, LIFT_MAX_ATTEMPTS).map((s) => s.yaw_deg), fin.height / MM);
  const squeezeMu = squeeze ? Math.tan((squeeze.angle_deg * Math.PI) / 180) : 0;
  const requiredMu = squeezeMu + weightMu;
  const friction: FrictionCheck = {
    mu,
    required_mu: requiredMu,
    clamp_n: CLAMP_N,
    gravity_m_s2: gravity,
    grip_ratio: gravity > 0 ? (2 * mu * CLAMP_N) / (mass * gravity) : Number.MAX_VALUE,
    squeeze_angle_deg: squeeze?.angle_deg ?? null,
    squeeze_yaw_deg: squeeze?.yaw_deg ?? null,
    squeeze_mu: squeezeMu,
    weight_mu: weightMu,
    priority: material.slippery,
  };
  receipt.friction = friction;
  if (mu >= requiredMu) {
    steps.push(step('FRICTION_OK', true, mu, requiredMu, 'mu', lines.frictionOk(requiredMu, mu, gravity, squeeze?.angle_deg ?? null, squeezeMu, weightMu), 'none'));
  } else {
    steps.push(step('SLIPS', false, mu, requiredMu, 'mu', lines.slips(requiredMu, material.label, mu, gravity, squeeze?.angle_deg ?? null, squeezeMu, weightMu), 'refused'));
  }

  // 7. Geometry where the fingertips actually meet it.
  const height = fin.height / MM;
  const gripZ = Math.max(height / 2, GRIP_Z_MIN);
  const tipZ = gripZ - TIP_BELOW;
  const padTop = Math.min(height, tipZ + PAD_LENGTH);
  const overlap = padTop - tipZ;
  receipt.grip_z_mm = gripZ * MM;
  if (overlap < MIN_PAD_OVERLAP) {
    steps.push(step('GRIP_HEIGHT', false, Math.max(0, overlap) * MM, MIN_PAD_OVERLAP * MM, 'mm', lines.gripTooLow(fin.height, Math.max(0, overlap) * MM, MIN_PAD_OVERLAP * MM), 'refused'));
  } else {
    const contactZ = (tipZ + padTop) / 2;
    const slice = hullWidthAtHeight(hull, sweep[0]!.yaw_deg, contactZ);
    if (slice < W_MIN || slice > W_MAX) {
      steps.push(step('GRIP_HEIGHT', false, slice * MM, (slice < W_MIN ? W_MIN : W_MAX) * MM, 'mm', lines.gripSlice(contactZ * MM, slice * MM, W_MIN * MM, W_MAX * MM), 'refused'));
    } else {
      steps.push(step('GRIP_OK', true, slice * MM, W_MIN * MM, 'mm', lines.gripOk(contactZ * MM, slice * MM), 'none'));
    }
  }

  return finish();
}

/**
 * The squarest grip among the yaws the lift test would try: the pad band runs from the
 * fingertip (TIP_BELOW under the grip point) to the top of the object.
 */
function squeezeAngle(hull: ConvexHull, yaws: readonly number[], height: number): { angle_deg: number; yaw_deg: number } | null {
  const tipZ = Math.max(height / 2, GRIP_Z_MIN) - TIP_BELOW;
  let found: { angle_deg: number; yaw_deg: number } | null = null;
  for (const yaw of yaws) {
    const angle = gripFaceAngleDeg(hull, yaw, Math.max(0, tipZ), height, GRIP_TOUCH_TOL);
    if (angle !== null && (!found || angle < found.angle_deg)) found = { angle_deg: angle, yaw_deg: yaw };
  }
  return found;
}
