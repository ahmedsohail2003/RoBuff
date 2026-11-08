import { App } from './app';
import { ArmController } from './control/armController';
import { ControlLoop } from './control/controlLoop';
import { ArmIk } from './control/ik';
import { createInputSource } from './input/createSource';
import { handsFromUrl } from './input/handTracker';
import { MouseSource } from './input/mouseSource';
import { WebcamSource } from './input/webcamSource';
import { handSeat } from './input/voiceSource';
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
import { AppStates, chooseInputKind } from './ui/states';
import { mountSpaceAndGravity } from './ui/gravityMenu';
import { mountDelay } from './delay/mountDelay';
import { mountConsole } from './ui/console';
import { mountVoice } from './voice/pushToTalk';
import { mountLiveTalk } from './voice/liveTalk';
import { mountStopGesture } from './safety/mountStopGesture';

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

async function main(): Promise<void> {
  const status = element('status');
  const viewportElement = element('viewport');
  try {
    const mujoco = await loadMujocoRuntime();
    const model = await loadModel(mujoco);
    const sim = new Simulation(mujoco, model);
    const loop = new ControlLoop(sim, new ArmController(sim, new ArmIk(mujoco, model, GRIPPER_SITE)));
    // Webcam by default when a camera exists (M1 step 8); ?input= overrides.
    const choice = await chooseInputKind(location.search);
    loop.source =
      choice.kind === 'webcam'
        ? new WebcamSource(handsFromUrl(location.search))
        : createInputSource(choice.kind, viewportElement, () => cubePickPlan(sim));
    const useMouse = (note: string | null): void => {
      loop.source?.dispose();
      loop.source = new MouseSource(viewportElement, note);
    };

    const overlay = new HandOverlay(document.body);
    const version = `MuJoCo ${mujoco.mj_versionString()}`;
    let states: AppStates | null = null;
    const app = new App(loop, new Viewport(viewportElement, mujoco, model), () => {
      states?.frame();
      // The hand behind the seat: unwrapped from the Moon delay and from a voice takeover.
      const source = handSeat(loop);
      app.viewport.setOrbitButton(source?.kind === 'mouse' ? 'right' : 'left');
      overlay.canvas.hidden = !source || source.kind === 'mouse' || loop.source?.kind === 'voice';
      if (!overlay.canvas.hidden) {
        overlay.draw(loop.lastHand, source instanceof WebcamSource ? source.video : null, source!.kind === 'webcam' ? 'camera' : 'virtual hand');
      }
    });
    app.speed = speedFromUrl(location.search);
    const appStates = (states = new AppStates(app, version, status, useMouse));
    app.start();
    if (import.meta.env.DEV || import.meta.env.MODE === 'test') installTestHooks(app, overlay);
    if (import.meta.env.DEV || import.meta.env.MODE === 'test') appStates.installHooks();
    const webcam = loop.source;
    if (webcam instanceof WebcamSource) {
      // The console's "Turn on camera" button reloads with ?autostart=1: the person already chose the camera.
      if (new URLSearchParams(location.search).get('autostart') === '1') void appStates.startWebcam(webcam);
      else appStates.showCameraIntro(webcam, () => void appStates.startWebcam(webcam));
    }
    mountSpaceAndGravity(app, import.meta.env.DEV || import.meta.env.MODE === 'test');
    const delayRig = mountDelay(app, mujoco, import.meta.env.DEV || import.meta.env.MODE === 'test');
    mountLiveTalk(mountVoice(app, import.meta.env.DEV || import.meta.env.MODE === 'test', mujoco), app, import.meta.env.DEV || import.meta.env.MODE === 'test');
    mountStopGesture(app, webcam, import.meta.env.DEV || import.meta.env.MODE === 'test');
    mountConsole(app, delayRig, import.meta.env.DEV || import.meta.env.MODE === 'test');
    mountObjectPanel(app, mujoco, import.meta.env.DEV || import.meta.env.MODE === 'test').catch((error: unknown) => {
      showNotice(`The object panel could not start: ${error instanceof Error ? error.message : String(error)}`);
    });
  } catch (error) {
    status.textContent = `Could not start the simulator: ${error instanceof Error ? error.message : String(error)}`;
    throw error;
  }
}

void main();
