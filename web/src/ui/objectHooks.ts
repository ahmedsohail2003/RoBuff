// Debug hooks for the object slot, added to window.__sim in dev and test builds only.

import type { App } from '../app';
import type { PickPlan } from '../input/pickScript';
import { SyntheticSource } from '../input/syntheticSource';
import type { SlotRenderer } from '../render/objectMesh';
import { outcomeSummary, type ObjectRequests } from '../sim/objectRequest';
import { receiptSummary } from '../objects/receipt';
import type { ObjectPanel } from './objectPanel';
import type { SkinLayerState } from '../render/objectSkin';
import type { SkinCall } from '../render/skinSource';
import { skinBrain } from '../render/skinSource';
import type { SkinControls } from './skinControls';

export interface ObjectHook {
  /** Runs a request (preset id or free text) through the panel and resolves with the outcome, receipt as JSON. */
  spawnObject(textOrPresetId: string): Promise<Record<string, unknown>>;
  /** The last request's receipt as JSON, or null. */
  readonly lastReceipt: Record<string, unknown> | null;
  /** The last request's whole outcome: stages, timings, lift runs. */
  readonly lastOutcome: Record<string, unknown> | null;
  /** The body now in the object slot ('cube' until something is spawned). */
  readonly objectBodyName: string;
  /** Starts S2's scripted synthetic pick, aimed at the object where it rests now. Returns the plan. */
  pickObject(): PickPlan;
  /** What the viewport draws for the spawned object, or null. */
  objectRender(): { vertices: number; triangles: number; material: string } | null;
  readonly objectBusy: boolean;
  /** Paints the current object (or the parts a phrase names) through the skin box. Resolves with the status line. */
  skinObject(text: string, part?: string | null): Promise<string>;
  /** Takes the skin off the current object (or the parts a phrase names). */
  removeSkin(part?: string | null): Promise<string>;
  /** The skins drawn now, read back from the three.js mesh, or null while the cube is in the slot. */
  skinState(): SkinLayerState | null;
  /** Every skin request this page made: source, model, cache, size and time. */
  skinCalls(): SkinCall[];
}

declare module '../test-hooks' {
  interface SimHook extends Partial<ObjectHook> {}
}

export function installObjectHooks(app: App, requests: ObjectRequests, panel: ObjectPanel, renderer: SlotRenderer, skins: SkinControls): void {
  const target = window.__sim;
  if (!target) return;
  const hooks: ObjectHook = {
    spawnObject: async (text) => {
      await panel.request(text);
      if (!requests.last) throw new Error('the request did not finish');
      return outcomeSummary(requests.last);
    },
    get lastReceipt() {
      return requests.last ? receiptSummary(requests.last.receipt) : null;
    },
    get lastOutcome() {
      return requests.last ? outcomeSummary(requests.last) : null;
    },
    get objectBodyName() {
      return requests.slot.bodyName;
    },
    pickObject: () => {
      const plan = requests.slot.pickPlan();
      app.loop.source?.dispose();
      app.loop.source = new SyntheticSource(() => plan);
      return plan;
    },
    objectRender: () => renderer.stats(),
    get objectBusy() {
      return requests.busy;
    },
    skinObject: (text, part) => skins.request({ text, part: part ?? null }),
    removeSkin: (part) => skins.remove(part ?? null),
    skinState: () => renderer.skinState(),
    skinCalls: () => skinBrain.calls.map((c) => ({ ...c })),
  };
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(hooks));
}
