import { App } from './app';
import { ArmController } from './control/armController';
import { ControlLoop } from './control/controlLoop';
import { ArmIk } from './control/ik';
import { createInputSource, inputKindFromUrl } from './input/createSource';
import { MouseSource } from './input/mouseSource';
import { WebcamSource } from './input/webcamSource';
import { cubePickPlan } from './input/scene';
import { HandOverlay } from './render/handOverlay';
import { showNotice } from './render/notice';
import { Viewport } from './render/viewport';
import { GRIPPER_SITE } from './sim/armXml';
import { loadModel } from './sim/loadModel';
import { loadMujocoRuntime } from './sim/mujocoRuntime';
import { Simulation } from './sim/simulation';
import { installTestHooks } from './test-hooks';
import { mountObjectPanel } from './ui/objectPanel';
import { mountSpaceAndGravity } from './ui/gravityMenu';

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`index.html has no #${id}`);
  return found;
}

/** ?speed=N runs N simulated seconds per wall second, between 0.1 and 8. */
function speedFromUrl(search: string): number {
  const value = Number(new URLSearchParams(search).get('speed') ?? '1');
  return Number.isFinite(value) ? Math.min(8, Math.max(0.1, value)) : 1;
}

function describeInput(loop: ControlLoop): string {
  if (!loop.source) return 'input: direct commands';
  const info = loop.source.describe();
  if (loop.source.kind === 'synthetic') return `input: synthetic hand, ${String(info.phase ?? 'starting')}`;
  if (loop.source.kind === 'webcam') {
    const ms = typeof info.medianInferenceMs === 'number' ? `, ${info.medianInferenceMs.toFixed(0)} ms per frame` : '';
    return `input: webcam, ${String(info.state)}${ms}`;
  }
  if (info.note) return `input: ${String(info.note)}`;
  return 'input: mouse (move to steer, W/S reach, G grip)';
}

/** Starts the camera; if there is none or it is refused, says so and offers the mouse. */
async function startWebcam(source: WebcamSource, useMouse: (note: string | null) => void): Promise<void> {
  const state = await source.start();
  if (state === 'running') return;
  showNotice(`${source.message ?? 'The camera is not available.'} You can steer the arm with the mouse instead.`, [
    { label: 'Use mouse instead', run: () => useMouse('mouse (camera unavailable); move to steer, W/S reach, G grip') },
  ]);
}

async function main(): Promise<void> {
  const status = element('status');
  const viewportElement = element('viewport');
  try {
    const mujoco = await loadMujocoRuntime();
    const model = await loadModel(mujoco);
    const sim = new Simulation(mujoco, model);
    const loop = new ControlLoop(sim, new ArmController(sim, new ArmIk(mujoco, model, GRIPPER_SITE)));
    loop.source = createInputSource(inputKindFromUrl(location.search), viewportElement, () => cubePickPlan(sim));
    const useMouse = (note: string | null): void => {
      loop.source?.dispose();
      loop.source = new MouseSource(viewportElement, note);
    };
    if (loop.source instanceof WebcamSource) void startWebcam(loop.source, useMouse);

    const overlay = new HandOverlay(document.body);
    const version = `MuJoCo ${mujoco.mj_versionString()}`;
    let shown = '';
    const app = new App(loop, new Viewport(viewportElement, mujoco, model), () => {
      const text = `${version} | ${describeInput(loop)}`;
      if (text !== shown) status.textContent = shown = text;
      const source = loop.source;
      overlay.canvas.hidden = !source || source.kind === 'mouse';
      if (!overlay.canvas.hidden) {
        overlay.draw(loop.lastHand, source instanceof WebcamSource ? source.video : null, source!.kind === 'webcam' ? 'camera' : 'virtual hand');
      }
    });
    app.speed = speedFromUrl(location.search);
    app.start();
    if (import.meta.env.DEV || import.meta.env.MODE === 'test') installTestHooks(app, overlay);
    mountSpaceAndGravity(app, import.meta.env.DEV || import.meta.env.MODE === 'test');
    mountObjectPanel(app, mujoco, import.meta.env.DEV || import.meta.env.MODE === 'test').catch((error: unknown) => {
      showNotice(`The object panel could not start: ${error instanceof Error ? error.message : String(error)}`);
    });
  } catch (error) {
    status.textContent = `Could not start the simulator: ${error instanceof Error ? error.message : String(error)}`;
    throw error;
  }
}

void main();
