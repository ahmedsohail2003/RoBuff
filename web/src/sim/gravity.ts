// Gravity for every simulation in the page, through one small registry. Each simulation
// registers a function that returns its current model (a function, because the object slot
// swaps the live model on every spawn). setGravity writes model.opt.gravity live on all of
// them, and a newly compiled model gets the current value through applyGravityTo before it
// steps. The truth and ghost simulations of the delay mode register the same way.

import type { MjModel } from '@mujoco/mujoco';
import { GRAVITY } from '../objects/limits';

export type GravityId = keyof typeof GRAVITY;

/** Bennu from JPL SBDB (sstr=101955, phys-par): GM in m^3/s^2 and mean diameter in metres. */
export const BENNU_GM = 4.8904;
export const BENNU_DIAMETER_M = 484.44;
/** Surface gravity GM / r^2, spin ignored: about 8.3e-5 m/s^2. */
export const BENNU_SURFACE_G = BENNU_GM / (BENNU_DIAMETER_M / 2) ** 2;
/** Escape speed sqrt(2 GM / r), spin ignored: about 0.20 m/s. */
export const BENNU_ESCAPE_M_S = Math.sqrt((2 * BENNU_GM) / (BENNU_DIAMETER_M / 2));
/** Below this gravity, contact in the solver shows small artefacts, and the receipt says so. */
export const LOW_GRAVITY_NOTE_BELOW = 0.1;
/**
 * Measured on 2026-11-07 with the arena cube in Node (private evidence m3-tap.txt): a 5 cm/s
 * sideways push on the resting cube raised it 46.9 mm at Bennu gravity (0.044 mm on the Moon,
 * 0 on Earth); the open jaw sweeping through it at about 5 cm/s raised it 7.7 mm (0.69 mm on the Moon).
 */
export const LOW_GRAVITY_NOTE =
  'Contact at this gravity shows solver artefacts. Measured today: a 5 cm/s sideways tap lifted a resting cube 47 mm on Bennu (under 0.1 mm on the Moon), and the open jaw sweeping through it lifted it 8 mm.';

export interface GravityPreset {
  id: GravityId;
  label: string;
  /** Magnitude in m/s^2, pointing down (-z) in the simulation. */
  value: number;
  /** Where the number comes from, shown next to it in the menu. */
  source: string;
}

export const GRAVITY_PRESETS: readonly GravityPreset[] = [
  { id: 'earth', label: 'Earth', value: GRAVITY.earth, source: 'NASA NSSDC Earth fact sheet' },
  { id: 'mars', label: 'Mars', value: GRAVITY.mars, source: 'NASA NSSDC Mars fact sheet' },
  { id: 'moon', label: 'Moon', value: GRAVITY.moon, source: 'NASA NSSDC Moon fact sheet' },
  {
    id: 'bennu',
    label: 'Bennu',
    value: GRAVITY.bennu,
    source: `calculated from JPL SBDB: GM ${BENNU_GM} m3/s2, diameter ${BENNU_DIAMETER_M} m; spin ignored`,
  },
  { id: 'orbit', label: 'Orbit', value: GRAVITY.orbit, source: 'in sim; real is about 1e-6 g (NASA, "What is microgravity?")' },
];

export function gravityPreset(id: GravityId): GravityPreset {
  const preset = GRAVITY_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`unknown gravity ${String(id)}`);
  return preset;
}

export function isGravityId(value: unknown): value is GravityId {
  return typeof value === 'string' && GRAVITY_PRESETS.some((p) => p.id === value);
}

type ModelSource = () => MjModel | null;
type Listener = (preset: GravityPreset) => void;
type TargetsListener = () => void;

/** Writes gravity (0, 0, -g) into a model's options. Takes effect on the next mj_step. */
export function writeGravity(model: MjModel, magnitude: number): void {
  const gravity = model.opt.gravity as Float64Array;
  gravity[0] = 0;
  gravity[1] = 0;
  gravity[2] = -Math.abs(magnitude);
}

export function readGravity(model: MjModel): number {
  return Math.abs((model.opt.gravity as Float64Array)[2]!);
}

export class GravityRegistry {
  private readonly targets = new Map<string, ModelSource>();
  private readonly listeners = new Set<Listener>();
  private readonly targetListeners = new Set<TargetsListener>();
  private currentId: GravityId = 'earth';

  get current(): GravityPreset {
    return gravityPreset(this.currentId);
  }

  /**
   * Adds a simulation under a name and gives its model the current gravity now. Returns
   * the function that takes it out again. A second register under the same name replaces it.
   */
  register(name: string, model: ModelSource): () => void {
    this.targets.set(name, model);
    const now = model();
    if (now) writeGravity(now, this.current.value);
    this.targetsChanged();
    return () => {
      if (this.targets.get(name) !== model) return;
      this.targets.delete(name);
      this.targetsChanged();
    };
  }

  /** Gives a newly compiled model the current gravity, before it steps. */
  applyTo(model: MjModel): void {
    writeGravity(model, this.current.value);
  }

  /** Writes the gravity on every registered simulation and tells the listeners. */
  set(id: GravityId): GravityPreset {
    this.currentId = gravityPreset(id).id;
    for (const source of this.targets.values()) {
      const model = source();
      if (model) writeGravity(model, this.current.value);
    }
    for (const listener of this.listeners) listener(this.current);
    return this.current;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called whenever a simulation registers or unregisters (the gravity itself is unchanged). */
  onTargetsChange(listener: TargetsListener): () => void {
    this.targetListeners.add(listener);
    return () => this.targetListeners.delete(listener);
  }

  private targetsChanged(): void {
    for (const listener of this.targetListeners) listener();
  }

  /** Each registered simulation and the gravity its model holds right now, in m/s^2. */
  report(): { name: string; gravity_m_s2: number | null }[] {
    return [...this.targets].map(([name, source]) => {
      const model = source();
      return { name, gravity_m_s2: model ? readGravity(model) : null };
    });
  }
}

/** The page's one registry. Simulations register here; the menu calls setGravity. */
export const gravity = new GravityRegistry();

export function setGravity(id: GravityId): GravityPreset {
  return gravity.set(id);
}

export function registerGravityTarget(name: string, model: ModelSource): () => void {
  return gravity.register(name, model);
}

export function applyGravityTo(model: MjModel): void {
  gravity.applyTo(model);
}
