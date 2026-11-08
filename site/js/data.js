// Every number the page's scripts show, with the fact id it comes from.
// The fact ids resolve in site/content/facts.json, which records each number's source file or command.
// Nothing here is invented: if a value is not in facts.json, it is not here.

// Arm limits for hand flying, from web/src/objects/limits.ts.
export const LIMITS = {
  handWMin: 15, // mm  {hand_width_min_mm}
  handWMax: 55, // mm  {hand_width_max_mm}
  handMMax: 200, // g  {hand_mass_max_g}
  farTooBig: 110, // mm  calculator rule 1 threshold (COPY.md); not shown as a number
  squeezeN: 50, // N  {squeeze_n}
  liftPassMm: 48, // mm  {lift_pass_rise_mm}
  iceNeeded: 0.26, // mu  {ice_friction_needed}
  lowGravityWarnBelow: 0.1, // m/s^2  {low_gravity_warning_below}
};

// Gravity, m/s^2 (limits.ts GRAVITY).  {g_earth} {g_mars} {g_moon} {g_bennu}
export const GRAVITY = [
  { id: 'earth', label: 'Earth', g: 9.82, shown: '9.82' },
  { id: 'mars', label: 'Mars', g: 3.73, shown: '3.73' },
  { id: 'moon', label: 'Moon', g: 1.62, shown: '1.62' },
  { id: 'bennu', label: 'Bennu', g: 8.3e-5, shown: '0.000083' },
];

// Materials (web/src/objects/materials.ts): density g/cm^3 and friction.
// {c_type_density} {s_type_density} {ice_density} {aluminium_density} {iron_density}
// {c_type_friction} {s_type_friction} {ice_friction} {aluminium_friction} {iron_friction}
export const MATERIALS = {
  c_type_rock: { label: 'C-type rock', density: 1.6, friction: 0.6 },
  s_type_rock: { label: 'S-type rock', density: 3.2, friction: 0.7 },
  ice: { label: 'Ice', density: 0.9, friction: 0.03 },
  aluminium: { label: 'Aluminium', density: 2.7, friction: 0.47 },
  iron: { label: 'Iron', density: 7.8, friction: 0.6 },
};

// Calculator tabs. Mass = a measured convex hull scaled to the chosen size, times density.
// Rock: Bennu-like sample hull 17.887 cm^3 at 40 mm {calc_rock_ref_hull_cc}.
// Part: CubeSat panel hull 14.786 cm^3 at 50 mm {calc_part_ref_hull_cc}.
// Defaults give 28.6 g (rock) {calc_default_rock_g}.
export const TABS = {
  rock: {
    materials: ['c_type_rock', 's_type_rock', 'ice'], refHullCc: 17.887, refMm: 40, defaultMm: 40,
    shape: 'Shape: Bennu-like hull, 17.9 cm³ at 40 mm, scaled.',
  },
  // The part tab is a flat panel, so it is much lighter than a solid lump of the same width.
  // {panel_width_mm} {panel_height_mm}
  part: {
    materials: ['aluminium', 'iron'], refHullCc: 14.786, refMm: 50, defaultMm: 50, matSuffix: ' panel',
    shape: 'Shape: CubeSat panel, 50 × 10 mm, 14.8 cm³, scaled.',
  },
};

// Shown when the part tab is set to iron, so the panel result is not mistaken for the tested solid iron request.
// {iron_width_mm} {iron_mass_g}
export const IRON_SOLID_NOTE = 'A solid 60 mm iron piece was 562 g: refused.';

// The seven requests tested end to end in the browser (COPY.md section 5).
// {objects_tested_browser} {objects_lifted} {objects_refused}
export const OBJECTS = [
  {
    name: 'Bennu-like sample', kind: 'asteroid', width: '40 mm', mass: '29 g', lift: '77.3 mm', verdict: 'PASS',
    note: 'C-type rock at the returned sample’s density, 1.6 g/cm³.',
    // {bennu_width_mm} {bennu_mass_g} {bennu_lift_rise_mm} {c_type_density}
  },
  {
    name: 'S-type chip', kind: 'fragment', width: '30 mm', mass: '18 g', lift: '79.3 mm', verdict: 'PASS',
    note: 'Stony rock, twice as dense as C-type.',
    // {chip_width_mm} {chip_mass_g} {chip_lift_rise_mm}
  },
  {
    name: 'CubeSat panel', kind: 'panel', width: '50 mm', mass: '40 g', lift: '78.5 mm', verdict: 'PASS',
    note: 'Aluminium panel, 10 mm thick.',
    // {panel_width_mm} {panel_height_mm} {panel_mass_g} {panel_lift_rise_mm}
  },
  {
    name: 'Comms dish', kind: 'dish', width: '48 mm', mass: '59 g', lift: '77.6 mm', verdict: 'PASS',
    note: 'Aluminium dish on a short foot.',
    // {dish_width_mm} {dish_mass_g} {dish_lift_rise_mm}
  },
  {
    name: 'Size of Texas', kind: 'asteroid', width: '55 mm', mass: '144 g', lift: '76.0 mm', verdict: 'ADJUSTED',
    note: 'Asked for about 1,200 km. Rebuilt as a 55 mm model, and the receipt says so.',
    asked: 'asked: ~1,200 km',
    // {texas_asked_km} {texas_model_mm} {texas_model_mass_g} {texas_lift_rise_mm}
  },
  {
    name: 'Solid iron, 60 mm', kind: 'fragment', width: '60 mm', mass: '562 g', lift: 'not run', verdict: 'REFUSED',
    note: 'Too heavy: the hand-flown limit is 200 g. Never spawned.',
    // {iron_width_mm} {iron_mass_g} {hand_mass_max_g}
  },
  {
    name: 'Comet ice shard', kind: 'shard', width: '34 mm', mass: '7.9 g', lift: 'not run', verdict: 'REFUSED',
    note: 'The pads meet it 14° off square, so it needs friction 0.26. Ice has 0.03.',
    // {ice_width_mm} {ice_mass_g} {ice_angle_deg} {ice_friction_needed} {ice_friction}
  },
];
