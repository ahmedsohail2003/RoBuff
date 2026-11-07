// The object panel: describe an object or pick a preset, then watch the receipt tick as each
// stage runs, with a jaw gauge, a mass bar and the verdict. Specs come from the offline
// keyword mock, and the panel says so: no Gemini call is made.

import type { App } from '../app';
import { say } from '../objects/format';
import { HAND_BAND, HARD_BAND } from '../objects/limits';
import type { Receipt } from '../objects/receipt';
import { SlotRenderer } from '../render/objectMesh';
import type { Mujoco } from '../sim/mujocoRuntime';
import { ObjectRequests, type RequestProgress, type StageState } from '../sim/objectRequest';
import { fetchModelFiles, ObjectSlot } from '../sim/objectSlot';
import { gravity, type GravityPreset } from '../sim/gravity';
import { physicsOnlyFilesAsync } from '../sim/physicsScene';
import { installObjectHooks } from './objectHooks';

export interface PanelPreset {
  id: string;
  label: string;
  /** What is sent to the offline mock: a preset id or free text. */
  text: string;
}

export const PANEL_PRESETS: readonly PanelPreset[] = [
  { id: 'bennu', label: 'Bennu-like C-type sample', text: 'bennu-sample' },
  { id: 's-type', label: 'S-type chip', text: 's-type-chip' },
  { id: 'cubesat', label: 'CubeSat panel', text: 'cubesat-panel' },
  { id: 'ice', label: 'Comet ice shard', text: 'comet-ice-shard' },
  { id: 'texas', label: 'An asteroid the size of Texas', text: 'an asteroid the size of Texas' },
  { id: 'iron', label: 'Solid iron, 60 mm', text: 'solid iron, 60 mm' },
];

const STYLE = `
#object-panel { position: fixed; top: 12px; right: 12px; width: 340px; max-height: calc(100vh - 220px); overflow-y: auto;
  background: rgba(10, 14, 28, 0.94); color: #e6e9f2; border: 1px solid #2b3557; border-radius: 8px; padding: 12px 14px;
  font: 13px/1.4 system-ui, sans-serif; box-shadow: 0 4px 18px rgba(0,0,0,.35); z-index: 5; }
#object-panel h2 { font-size: 14px; margin: 0 0 6px; letter-spacing: .02em; display: flex; justify-content: space-between; align-items: center; }
#object-panel .mock { font-size: 11px; font-weight: 600; color: #1b1300; background: #f2c14e; border-radius: 3px; padding: 1px 6px; }
#object-panel form { display: flex; gap: 6px; margin: 6px 0; }
#object-panel input { flex: 1; min-width: 0; font: inherit; padding: 5px 7px; border-radius: 4px; border: 1px solid #3a466e; background: #121a33; color: inherit; }
#object-panel button { font: inherit; color: inherit; background: #1d2850; border: 1px solid #3a466e; border-radius: 4px; padding: 4px 8px; cursor: pointer; }
#object-panel button:hover:not(:disabled) { background: #2a3870; }
#object-panel button:disabled { opacity: .5; cursor: default; }
#object-panel .presets { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-bottom: 8px; }
#object-panel .presets button { text-align: left; font-size: 12px; }
#object-panel .verdict { font-size: 18px; font-weight: 700; margin: 6px 0; }
#object-panel .verdict[data-verdict="PASS"], #object-panel .verdict[data-verdict="ADJUSTED"] { color: #7ee2a8; }
#object-panel .verdict[data-verdict="REFUSED"] { color: #ff8a80; }
#object-panel .gauge-label { font-size: 11px; color: #aab3cc; margin-top: 6px; }
#object-panel .bar { position: relative; height: 14px; background: #121a33; border: 1px solid #3a466e; border-radius: 3px; margin-top: 2px; overflow: hidden; }
#object-panel .band { position: absolute; top: 0; bottom: 0; }
#object-panel .band.hard { background: rgba(126, 226, 168, .18); }
#object-panel .band.hand { background: rgba(126, 226, 168, .38); }
#object-panel .marker { position: absolute; top: -2px; bottom: -2px; width: 3px; background: #f2c14e; }
#object-panel .fill { position: absolute; left: 0; top: 0; bottom: 0; background: #6aa9ff; }
#object-panel .fill.over { background: #ff8a80; }
#object-panel .limit { position: absolute; top: 0; bottom: 0; width: 1px; background: #e6e9f2; opacity: .7; }
#object-panel ol { list-style: none; padding: 0; margin: 8px 0 0; }
#object-panel li { display: grid; grid-template-columns: 18px 1fr; gap: 4px; padding: 3px 0; border-top: 1px solid #1f2847; }
#object-panel li .icon { font-weight: 700; }
#object-panel li[data-state="ok"] .icon { color: #7ee2a8; }
#object-panel li[data-state="adjusted"] .icon { color: #f2c14e; }
#object-panel li[data-state="note"] .icon { color: #8fb4ff; }
#object-panel li[data-state="refused"] .icon { color: #ff8a80; }
#object-panel li[data-state="running"] .icon { color: #aab3cc; }
#object-panel li .code { font-size: 10px; color: #8890a8; letter-spacing: .04em; }
#object-panel .why { color: #aab3cc; font-size: 12px; margin: 4px 0; }
`;

const ICON: Record<StageState, string> = { pending: '·', running: '…', ok: '✓', note: 'i', adjusted: '↔', refused: '✗' };
/** Gauge scales: jaw width 0-80 mm, mass 0-400 g. */
const JAW_SCALE_MM = 80;
const MASS_SCALE_G = 400;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function pct(value: number, scale: number): string {
  return `${Math.max(0, Math.min(100, (value / scale) * 100)).toFixed(2)}%`;
}

export class ObjectPanel {
  readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly verdict: HTMLElement;
  private readonly why: HTMLElement;
  /** The friction line re-run after a gravity change, for the last request. */
  private readonly recheck: HTMLElement;
  private readonly jawLabel: HTMLElement;
  private readonly jawMarker: HTMLElement;
  private readonly massLabel: HTMLElement;
  private readonly massFill: HTMLElement;
  private readonly list: HTMLOListElement;

  constructor(
    parent: HTMLElement,
    private readonly requests: ObjectRequests,
  ) {
    if (!document.getElementById('object-panel-style')) document.head.appendChild(el('style', { id: 'object-panel-style' }, STYLE));
    this.root = el('section', { id: 'object-panel', 'aria-label': 'Object fabricator' });
    const title = el('h2', {}, 'Object fabricator');
    title.appendChild(el('span', { class: 'mock', 'data-testid': 'offline-mock', title: 'Specs come from a keyword parser in the browser. No Gemini call is made.' }, 'offline mock, no Gemini'));
    this.root.appendChild(title);

    const form = el('form');
    this.input = el('input', { type: 'text', placeholder: 'Describe an object', 'aria-label': 'Describe an object', 'data-testid': 'object-text' });
    // Keys typed here must not steer the arm (the mouse source listens for W, S and G).
    this.input.addEventListener('keydown', (event) => event.stopPropagation());
    const make = el('button', { type: 'submit', 'data-testid': 'object-make' }, 'Make it');
    form.append(this.input, make);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.input.value.trim();
      if (text) void this.request(text);
    });
    this.buttons.push(make);
    this.root.appendChild(form);

    const presets = el('div', { class: 'presets' });
    for (const preset of PANEL_PRESETS) {
      const button = el('button', { type: 'button', 'data-preset': preset.id }, preset.label);
      button.addEventListener('click', () => void this.request(preset.text));
      this.buttons.push(button);
      presets.appendChild(button);
    }
    this.root.appendChild(presets);

    this.verdict = el('div', { class: 'verdict', 'data-testid': 'object-verdict', 'aria-live': 'polite' }, 'Pick a preset or describe an object.');
    this.why = el('div', { class: 'why' });
    this.recheck = el('div', { class: 'why', 'data-testid': 'friction-recheck', hidden: '' });
    this.root.append(this.verdict, this.why, this.recheck);

    this.jawLabel = el('div', { class: 'gauge-label' }, `Jaw: works ${say(HARD_BAND.w_min * 1000)}-${say(HARD_BAND.w_max * 1000)} mm, hand-flown ${say(HAND_BAND.w_min * 1000)}-${say(HAND_BAND.w_max * 1000)} mm`);
    const jaw = el('div', { class: 'bar', 'data-testid': 'jaw-gauge' });
    jaw.append(
      this.band('hard', HARD_BAND.w_min * 1000, HARD_BAND.w_max * 1000),
      this.band('hand', HAND_BAND.w_min * 1000, HAND_BAND.w_max * 1000),
    );
    this.jawMarker = el('div', { class: 'marker', hidden: '' });
    jaw.appendChild(this.jawMarker);
    this.massLabel = el('div', { class: 'gauge-label' }, `Mass: hand-flown limit ${say(HAND_BAND.m_max * 1000)} g, hard limit ${say(HARD_BAND.m_max * 1000)} g`);
    const mass = el('div', { class: 'bar', 'data-testid': 'mass-bar' });
    this.massFill = el('div', { class: 'fill' });
    this.massFill.style.width = '0%';
    mass.append(this.massFill, this.limitLine(HAND_BAND.m_max * 1000), this.limitLine(HARD_BAND.m_max * 1000));
    this.root.append(this.jawLabel, jaw, this.massLabel, mass);

    this.list = el('ol', { 'data-testid': 'receipt-list' });
    this.root.appendChild(this.list);
    parent.appendChild(this.root);
  }

  async request(text: string): Promise<void> {
    if (this.requests.busy) return;
    this.recheck.hidden = true;
    this.setBusy(true);
    try {
      await this.requests.run(text, (progress) => this.render(progress));
    } catch (error) {
      this.verdict.dataset.verdict = 'REFUSED';
      this.verdict.textContent = `Something broke: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.setBusy(false);
    }
  }

  render(progress: RequestProgress): void {
    const receipt = progress.receipt;
    this.list.replaceChildren(
      ...progress.stages.map((stage) => {
        const item = el('li', { 'data-state': stage.state, 'data-code': stage.code });
        const body = el('div');
        body.append(el('div', { class: 'code' }, stage.code), el('div', {}, stage.text));
        item.append(el('span', { class: 'icon', 'aria-hidden': 'true' }, ICON[stage.state]), body);
        return item;
      }),
    );
    if (progress.done && progress.verdict) {
      this.verdict.dataset.verdict = progress.verdict;
      const words = { PASS: 'PASS: lifted in simulation', ADJUSTED: 'ADJUSTED, then lifted in simulation', REFUSED: 'REFUSED', READY_FOR_LIFT_TEST: 'Not proven: the lift test did not run' }[progress.verdict];
      this.verdict.textContent = words;
    } else {
      delete this.verdict.dataset.verdict;
      this.verdict.textContent = 'Checking...';
    }
    this.why.textContent = receipt ? `${receipt.spec.why} Simulated arm only; a real arm is unverified.` : '';
    this.gauges(receipt);
  }

  /** Re-runs the guardrail's friction line for the last request at a new gravity and shows it. */
  showFrictionAt(preset: GravityPreset): void {
    const result = this.requests.frictionAt(preset.value);
    if (!result) {
      this.recheck.hidden = true;
      return;
    }
    this.recheck.hidden = false;
    this.recheck.dataset.code = result.code;
    this.recheck.textContent = `Friction check re-run at ${preset.label}: ${result.code === 'SLIPS' ? 'SLIPS' : 'FRICTION_OK'}. ${result.text}`;
  }

  private gauges(receipt: Receipt | null): void {
    const width = receipt?.rest?.narrow_width_mm ?? receipt?.narrow_width_mm ?? null;
    if (width === null) {
      this.jawMarker.hidden = true;
    } else {
      this.jawMarker.hidden = false;
      this.jawMarker.style.left = `calc(${pct(width, JAW_SCALE_MM)} - 1px)`;
    }
    const asked = receipt ? Math.min(receipt.requested_size_mm[0], receipt.requested_size_mm[1]) : null;
    this.jawLabel.textContent =
      `Jaw: object ${width === null ? 'n/a' : `${say(width)} mm`}` +
      (asked !== null && width !== null && Math.abs(asked - width) > 1 ? ` (asked about ${say(asked)} mm)` : '') +
      `; works ${say(HARD_BAND.w_min * 1000)}-${say(HARD_BAND.w_max * 1000)}, hand-flown ${say(HAND_BAND.w_min * 1000)}-${say(HAND_BAND.w_max * 1000)} mm`;
    const grams = receipt?.mass_kg !== null && receipt?.mass_kg !== undefined ? receipt.mass_kg * 1000 : null;
    this.massFill.style.width = grams === null ? '0%' : pct(grams, MASS_SCALE_G);
    this.massFill.classList.toggle('over', grams !== null && receipt !== null && grams > receipt.band.m_max * 1000);
    this.massLabel.textContent = `Mass: ${grams === null ? 'n/a' : `${say(grams)} g`}; limits ${say(HAND_BAND.m_max * 1000)} g hand-flown, ${say(HARD_BAND.m_max * 1000)} g hard`;
  }

  private band(kind: 'hard' | 'hand', fromMm: number, toMm: number): HTMLElement {
    const band = el('div', { class: `band ${kind}` });
    band.style.left = pct(fromMm, JAW_SCALE_MM);
    band.style.width = pct(toMm - fromMm, JAW_SCALE_MM);
    return band;
  }

  private limitLine(grams: number): HTMLElement {
    const line = el('div', { class: 'limit' });
    line.style.left = pct(grams, MASS_SCALE_G);
    return line;
  }

  private setBusy(busy: boolean): void {
    for (const button of this.buttons) button.disabled = busy;
    this.root.dataset.busy = String(busy);
  }
}

/** Builds the object slot, the request runner, the renderer and the panel for a running app. */
export async function mountObjectPanel(app: App, mujoco: Mujoco, withHooks: boolean): Promise<ObjectPanel> {
  // Recompiling the full arm takes seconds; the physics-only copy compiles in about a tenth of a second.
  const files = await physicsOnlyFilesAsync(await fetchModelFiles());
  const slot = new ObjectSlot(mujoco, files, app.loop);
  const group = app.viewport.bodyGroup(app.sim.model.nbody - 1);
  if (!group) throw new Error('the viewport has no group for the slot body');
  const renderer = new SlotRenderer(group);
  const requests = new ObjectRequests(mujoco, slot, { onOccupant: (receipt) => renderer.show(receipt) });
  const panel = new ObjectPanel(document.body, requests);
  gravity.onChange((preset) => panel.showFrictionAt(preset));
  if (withHooks) installObjectHooks(app, requests, panel, renderer);
  return panel;
}
