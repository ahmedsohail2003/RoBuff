import type { App } from './app';
import type { ControllerStatus } from './control/armController';
import type { HandState } from './input/handState';
import { createHandTracker, handsFromResult } from './input/handTracker';
import { palmSize, pinchRatio } from './input/landmarks';
import { CUBE_BODY } from './input/scene';
import type { HandOverlay } from './render/handOverlay';
import type { ContactReport, Vec3 } from './sim/simulation';
import { screenAxes } from './control/voiceMotion';
import { operatorSource } from './delay/dualSim';
import { VoiceSource } from './input/voiceSource';

export interface SimHook {
  readonly ready: boolean;
  readonly simTime: number;
  readonly renderFrames: number;
  readonly physicsSteps: number;
  readonly lastPhysicsMs: number;
  readonly fps: number;
  /** Simulated seconds per wall second. Writable. */
  speed: number;
  /** The last target given to the controller, before clamping and smoothing. */
  readonly target: Vec3 | null;
  getBodyPos(name: string): Vec3 | null;
  getSitePos(name: string): Vec3 | null;
  getJointPos(): number[];
  getCtrl(): number[];
  /** Drives the gripper site toward a world point. Detaches the input source. */
  setTarget(target: Vec3): void;
  /** 0 is fully open, 1 is fully closed. Detaches the input source. */
  setGrip(grip: number): void;
  /** Clear gap between the jaw tips, in metres. */
  gripperOpening(): number;
  /** Keyframe reset; the cube can be placed elsewhere first. The input source restarts. */
  reset(cubePosition?: Vec3): void;
  /** Which input source is active and how far along it is. */
  input(): Record<string, unknown> & { kind: string | null };
  controller(): ControllerStatus;
  contacts(bodyName: string): ContactReport[];
  renderStats(): { gpu: string; drawCalls: number; triangles: number };
  /** The HandState the control loop used last, from whichever source. */
  hand(): HandState | null;
  /** Frames drawn in the picture-in-picture hand view. */
  readonly handViewFrames: number;
  /**
   * Runs the app's own HandLandmarker setup (local WASM and model, VIDEO mode) on an image
   * URL, and reports what it found and how long inference took.
   */
  detectHandsInImage(url: string, numHands?: number): Promise<ImageDetection>;
  /** The voice source in the operator's seat (inside the Moon delay when there is one), or null when the hand has the arm. */
  voiceMotion(): VoiceMotionState | null;
  /** The camera's azimuth and the floor directions voice uses for left/right and toward/away. */
  screen(): { azimuth: number; right: Vec3; away: Vec3 };
}

export interface VoiceMotionState {
  owner: 'voice';
  state: string;
  goal: Vec3;
  grip: number;
  label: string;
  phase: string | null;
  clamped: boolean;
  parkedKind: string | null;
  busy: boolean;
}

export interface ImageDetection {
  delegate: string;
  gpuError: string | null;
  modelLoadMs: number;
  imageWidth: number;
  imageHeight: number;
  /** Per run, in ms. The first includes one-off setup. */
  inferenceMs: number[];
  hands: { landmarkCount: number; score: number; finite: boolean; pinchRatio: number; palmSize: number }[];
}

declare global {
  interface Window {
    __sim?: SimHook;
  }
}

async function detectHandsInImage(url: string, numHands = 2): Promise<ImageDetection> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const tracker = await createHandTracker(numHands);
  try {
    const inferenceMs: number[] = [];
    let hands: ReturnType<typeof handsFromResult> = [];
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      hands = handsFromResult(tracker.landmarker.detectForVideo(image, start + run));
      inferenceMs.push(performance.now() - start);
    }
    return {
      delegate: tracker.delegate,
      gpuError: tracker.gpuError,
      modelLoadMs: tracker.createMs,
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      inferenceMs,
      hands: hands.map((hand) => ({
        landmarkCount: hand.landmarks.length,
        score: hand.score,
        finite: hand.landmarks.every((point) => point.every(Number.isFinite)),
        pinchRatio: pinchRatio(hand.landmarks, image.naturalWidth / image.naturalHeight),
        palmSize: palmSize(hand.landmarks, image.naturalWidth / image.naturalHeight),
      })),
    };
  } finally {
    tracker.landmarker.close();
  }
}

export function installTestHooks(app: App, overlay: HandOverlay): void {
  const loop = app.loop;
  window.__sim = {
    ready: true,
    get simTime() {
      return app.sim.time;
    },
    get renderFrames() {
      return app.renderFrames;
    },
    get physicsSteps() {
      return app.sim.physicsSteps;
    },
    get lastPhysicsMs() {
      return app.lastPhysicsMs;
    },
    get fps() {
      return app.fps;
    },
    get speed() {
      return app.speed;
    },
    set speed(value: number) {
      app.speed = value;
    },
    get target() {
      return loop.controller.status().target;
    },
    getBodyPos: (name) => app.sim.getBodyPos(name),
    getSitePos: (name) => app.sim.getSitePos(name),
    getJointPos: () => app.sim.getJointPos(),
    getCtrl: () => app.sim.getCtrl(),
    setTarget: (target) => app.setTarget(target),
    setGrip: (grip) => app.setGrip(grip),
    gripperOpening: () => app.sim.gripperOpening(),
    reset: (cubePosition) => loop.reset(cubePosition ? (sim) => sim.placeFreeBody(CUBE_BODY, cubePosition) : undefined),
    input: () => ({ kind: loop.source?.kind ?? null, ...(loop.source?.describe() ?? {}) }),
    controller: () => loop.controller.status(),
    contacts: (bodyName) => app.sim.contactsOf(bodyName),
    renderStats: () => app.viewport.stats(),
    hand: () => loop.lastHand,
    get handViewFrames() {
      return overlay.framesDrawn;
    },
    detectHandsInImage,
    voiceMotion: () => {
      const seat = operatorSource(loop);
      if (!(seat instanceof VoiceSource)) return null;
      return { owner: 'voice', state: seat.state, goal: [...seat.goal] as Vec3, grip: seat.grip, label: seat.label, phase: seat.phase, clamped: seat.clamped, parkedKind: seat.parked?.kind ?? null, busy: seat.busy };
    },
    screen: () => {
      const azimuth = app.viewport.azimuth;
      const axes = screenAxes(azimuth);
      return { azimuth, right: axes.right, away: axes.away };
    },
  };
}
