// The gravity menu (bottom left): five settings, each with its value and where the value
// comes from. Picking one writes gravity live on every registered simulation. On Bennu it
// also shows the escape speed next to the rock's live speed, and says when the rock is gone.
// mountSpaceAndGravity is the one call main.ts makes for this milestone: the space scene,
// the simulation label, the menu, and (dev and test builds) the debug hooks.

import type { App } from '../app';
import { applySpaceScene } from '../render/spaceScene';
import { say, sayGravityValue } from '../objects/format';
import {
  BENNU_ESCAPE_M_S,
  GRAVITY_PRESETS,
  LOW_GRAVITY_NOTE,
  LOW_GRAVITY_NOTE_BELOW,
  gravity,
  registerGravityTarget,
  type GravityId,
  type GravityPreset,
} from '../sim/gravity';
import { PAD_XY } from '../sim/objectSlot';
import type { Simulation } from '../sim/simulation';
import { installGravityHooks } from './gravityHooks';
import { mountSimulationLabel } from './simulationLabel';

/** The rock counts as gone once it is this far from the pad and faster than escape speed. */
export const ESCAPE_SPHERE_M = 1.5;

const STYLE = `
#gravity-menu { position: fixed; left: 12px; bottom: 12px; width: 330px; z-index: 5; padding: 10px 12px;
  background: rgba(10, 14, 28, 0.94); color: #e6e9f2; border: 1px solid #2b3557; border-radius: 8px;
  font: 12px/1.4 system-ui, sans-serif; box-shadow: 0 4px 18px rgba(0,0,0,.35); }
#gravity-menu h2 { font-size: 13px; margin: 0 0 6px; }
#gravity-menu button { display: grid; grid-template-columns: 58px 74px 1fr; gap: 6px; width: 100%; text-align: left; align-items: baseline;
  font: inherit; color: inherit; background: #121a33; border: 1px solid #2b3557; border-radius: 4px; padding: 4px 6px; margin: 3px 0; cursor: pointer; }
#gravity-menu button:hover { background: #1d2850; }
#gravity-menu button[aria-pressed="true"] { border-color: #8fb4ff; background: #1d2850; }
#gravity-menu .name { font-weight: 700; }
#gravity-menu .value { font-variant-numeric: tabular-nums; }
#gravity-menu .source { color: #aab3cc; font-size: 11px; }
#gravity-menu .readout, #gravity-menu .escape, #gravity-menu .lowg { margin-top: 6px; color: #aab3cc; }
#gravity-menu .escape { color: #e6e9f2; font-variant-numeric: tabular-nums; }
#gravity-menu .escape[data-gone="true"] { color: #ff8a80; font-weight: 700; }
`;

export interface EscapeReadout {
  /** The slot body (the cube, or the spawned object): it is the last body in every scene. */
  bodyName: string;
  speed_m_s: number;
  distance_m: number;
  gone: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The last body's linear speed and its distance from the pad, from its free joint. */
export function slotBodyMotion(sim: Simulation): { bodyName: string; speed_m_s: number; distance_m: number } | null {
  const model = sim.model;
  const body = model.nbody - 1;
  const joint = (model.body_jntadr as Int32Array)[body]!;
  if (joint < 0) return null;
  const dadr = (model.jnt_dofadr as Int32Array)[joint]!;
  const data = sim.mjData;
  const qvel = data.qvel as Float64Array;
  const xpos = data.xpos as Float64Array;
  const speed = Math.hypot(qvel[dadr]!, qvel[dadr + 1]!, qvel[dadr + 2]!);
  const distance = Math.hypot(xpos[3 * body]! - PAD_XY[0], xpos[3 * body + 1]! - PAD_XY[1], xpos[3 * body + 2]!);
  return { bodyName: `#${body}`, speed_m_s: speed, distance_m: distance };
}

export class GravityMenu {
  readonly root: HTMLElement;
  escape: EscapeReadout | null = null;
  private readonly buttons = new Map<GravityId, HTMLButtonElement>();
  private readonly readout: HTMLElement;
  private readonly escapeLine: HTMLElement;
  private readonly lowG: HTMLElement;
  private gone = false;

  constructor(
    parent: HTMLElement,
    private readonly app: App,
  ) {
    if (!document.getElementById('gravity-menu-style')) document.head.appendChild(el('style', { id: 'gravity-menu-style' }, STYLE));
    this.root = el('section', { id: 'gravity-menu', 'aria-label': 'Gravity' });
    this.root.appendChild(el('h2', {}, 'Gravity (simulated)'));
    for (const preset of GRAVITY_PRESETS) {
      const button = el('button', { type: 'button', 'data-gravity': preset.id, 'aria-pressed': 'false' });
      button.append(
        el('span', { class: 'name' }, preset.label),
        el('span', { class: 'value' }, `${sayGravityValue(preset.value)} m/s2`),
        el('span', { class: 'source' }, preset.source),
      );
      button.addEventListener('click', () => {
        gravity.set(preset.id);
        button.blur();
      });
      this.buttons.set(preset.id, button);
      this.root.appendChild(button);
    }
    this.readout = el('div', { class: 'readout', 'data-testid': 'gravity-readout', 'aria-live': 'polite' });
    this.escapeLine = el('div', { class: 'escape', 'data-testid': 'escape-readout', hidden: '' });
    this.lowG = el('div', { class: 'lowg', 'data-testid': 'low-gravity-note', hidden: '' }, LOW_GRAVITY_NOTE);
    this.root.append(this.readout, this.escapeLine, this.lowG);
    parent.appendChild(this.root);

    gravity.onChange((preset) => this.show(preset));
    // The ghost registers and unregisters on its own: keep the "written to N simulations" count true.
    // A microtask later, because a simulation registers just before its model is stored.
    gravity.onTargetsChange(() => queueMicrotask(() => this.showReadout(gravity.current)));
    this.show(gravity.current);
    requestAnimationFrame(this.frame);
  }

  private show(preset: GravityPreset): void {
    for (const [id, button] of this.buttons) button.setAttribute('aria-pressed', String(id === preset.id));
    this.showReadout(preset);
    this.lowG.hidden = !(preset.value < LOW_GRAVITY_NOTE_BELOW);
    this.gone = false;
    this.updateEscape();
  }

  /** The "Now: ..." line: the setting and every registered simulation's gravity. */
  private showReadout(preset: GravityPreset): void {
    const sims = gravity.report();
    const values = sims.map((s) => `${s.name} ${s.gravity_m_s2 === null ? 'n/a' : sayGravityValue(s.gravity_m_s2)}`).join(', ');
    this.readout.textContent = `Now: ${preset.label}, ${sayGravityValue(preset.value)} m/s2, written to ${sims.length} simulation${sims.length === 1 ? '' : 's'} (${values}).`;
    this.readout.dataset.current = preset.id;
  }

  private readonly frame = (): void => {
    requestAnimationFrame(this.frame);
    this.updateEscape();
  };

  /** Bennu only: escape speed against the rock's live speed; "that rock is gone" once it leaves the sphere above escape speed. */
  private updateEscape(): void {
    if (gravity.current.id !== 'bennu') {
      this.escapeLine.hidden = true;
      this.escape = null;
      return;
    }
    const motion = slotBodyMotion(this.app.sim);
    if (!motion) {
      this.escapeLine.hidden = true;
      this.escape = null;
      return;
    }
    if (motion.distance_m > ESCAPE_SPHERE_M && motion.speed_m_s > BENNU_ESCAPE_M_S) this.gone = true;
    else if (motion.distance_m <= ESCAPE_SPHERE_M) this.gone = false;
    this.escape = { ...motion, gone: this.gone };
    const speed = `Bennu escape speed about ${BENNU_ESCAPE_M_S.toFixed(2)} m/s (calculated, spin ignored). Rock: ${(motion.speed_m_s * 100).toFixed(1)} cm/s, ${say(Math.round(motion.distance_m * 100))} cm from the pad.`;
    const text = this.gone ? `${speed} That rock is gone.` : speed;
    if (this.escapeLine.textContent !== text) this.escapeLine.textContent = text;
    this.escapeLine.hidden = false;
    this.escapeLine.dataset.gone = String(this.gone);
  }
}

/** The one init call for M3: space scene, simulation label, gravity on the live simulation, the menu, and the hooks. */
export function mountSpaceAndGravity(app: App, withHooks: boolean): GravityMenu {
  const space = applySpaceScene(app.viewport);
  mountSimulationLabel();
  // A function, not the model: the object slot swaps the live model on every spawn.
  registerGravityTarget('live', () => app.sim.model);
  const menu = new GravityMenu(document.body, app);
  if (withHooks) installGravityHooks(app, menu, space);
  return menu;
}
