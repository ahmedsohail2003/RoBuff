// Wires the stop gesture (stopGesture.ts) into a running app: it taps the webcam's hand
// tracker for every hand found (before the delay line, so a Moon-mode stop is never late),
// sets the M1 stop latch, says on screen which stop is armed, and adds the debug hooks
// (dev and test builds) that replay synthetic hand streams through the same detector.
// One call from main.ts.

import type { HandLandmarkerResult } from '@mediapipe/tasks-vision';
import type { App } from '../app';
import type { Landmark, InputSource } from '../input/handState';
import { drawHand } from '../input/drawHand';
import { cubePickPlan } from '../input/scene';
import { syntheticLandmarks } from '../input/syntheticHand';
import type { HandTracker } from '../input/handTracker';
import { createHandTracker, handsFromUrl } from '../input/handTracker';
import { WebcamSource } from '../input/webcamSource';
import type { StopLatch } from './latch';
import {
  gesturePosed,
  handShape,
  holdFor,
  isOpenHand,
  mirrorHand,
  medianOf,
  REPLAY_FPS,
  replayStream,
  shouldFallBack,
  StopGestureDetector,
  TRACKING_LIMIT_MS,
  type GestureMode,
  type HandShape,
  type ReplayKind,
} from './stopGesture';

const STOP_REASON = 'stop gesture';
const TIMING_WINDOW = 30;

export interface StopGestureState {
  enabled: boolean;
  mode: GestureMode;
  holdS: number;
  /** Hands the webcam tracker looks for (1 or 2), or null without a webcam. */
  trackerHands: number | null;
  /** What the on-screen line says. */
  line: string;
  frames: number;
  posedFrames: number;
  heldS: number;
  fires: number;
  /** Frames where two hands were in view and the arm was held (two-hand mode only). */
  twoHandHolds: number;
  medianTrackingMs: number | null;
  fallbackReason: string | null;
  stopped: boolean;
  stopWhy: string | null;
  stopSince: number | null;
}

export interface ReplayReport {
  kind: ReplayKind;
  /** Labelled: these frames are drawn by code, not seen by a camera. */
  source: 'synthetic replay';
  seconds: number;
  frames: number;
  posedFrames: number;
  maxHeldS: number;
  fires: number;
  /** Simulated time at the start of the replay. */
  startSimS: number;
  /** Replay time of the sample on which the hold completed, or null. */
  fireAtS: number | null;
  /** Simulated seconds from the replay start to the moment the latch was set by the gesture, or null. */
  latchAfterS: number | null;
  /** Actuator commands read right after the gesture set the latch. */
  ctrlAtLatch: number[] | null;
  stoppedAtEnd: boolean;
  stopWhy: string | null;
}

export interface StopGestureHook {
  stopGesture(): StopGestureState;
  /**
   * Feeds a synthetic hand stream (REPLAY_FPS frames per simulated second) into the stop
   * gesture detector for this many simulated seconds; resolves with what it did.
   */
  replayStopGesture(kind: ReplayKind, seconds: number): Promise<ReplayReport>;
  /**
   * Paints synthetic hands (no photograph) into a 640 x 480 picture, runs the app's own
   * HandLandmarker on it looking for 2 hands, and reports what the stop gesture makes of
   * the landmarks MediaPipe returns. A check of the thresholds on tracker output; a painted
   * hand is not a real hand.
   */
  stopGestureOnPicture(kind: PictureKind): Promise<PictureCheck>;
}

export type PictureKind = 'two-open-hands' | 'one-open-hand' | 'one-pinched-hand' | 'open-and-pinched';

export interface PictureCheck {
  kind: PictureKind;
  source: 'painted synthetic hands, MediaPipe HandLandmarker';
  delegate: string;
  handsFound: number;
  scores: number[];
  open: boolean[];
  shapes: (HandShape | null)[];
  posed: boolean;
}

/** Palms and pinch amounts painted for each picture kind. */
const PICTURES: Record<PictureKind, { palm: [number, number, number]; pinch: number; left: boolean }[]> = {
  'two-open-hands': [
    { palm: [0.78, 0.55, 0.45], pinch: 0, left: false },
    { palm: [0.22, 0.55, 0.45], pinch: 0, left: true },
  ],
  'one-open-hand': [{ palm: [0.5, 0.55, 0.6], pinch: 0, left: false }],
  'one-pinched-hand': [{ palm: [0.5, 0.55, 0.6], pinch: 1, left: false }],
  'open-and-pinched': [
    { palm: [0.78, 0.55, 0.45], pinch: 1, left: false },
    { palm: [0.22, 0.55, 0.45], pinch: 0, left: true },
  ],
};

async function stopGestureOnPicture(kind: PictureKind): Promise<PictureCheck> {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('no 2D canvas context');
  PICTURES[kind].forEach((hand, i) => {
    const right = syntheticLandmarks(hand.palm, hand.pinch);
    drawHand(g, hand.left ? mirrorHand(right) : right, canvas.width, canvas.height, i === 0 ? {} : { background: 'rgba(0,0,0,0)' });
  });
  const tracker = await createHandTracker(2);
  try {
    let result: HandLandmarkerResult | null = null;
    const start = performance.now();
    for (let run = 0; run < 3; run++) result = tracker.landmarker.detectForVideo(canvas, start + run);
    const hands = result!.landmarks.map((points) => points.map((q) => [q.x, q.y, q.z] as Landmark));
    const aspect = canvas.width / canvas.height;
    return {
      kind,
      source: 'painted synthetic hands, MediaPipe HandLandmarker',
      delegate: tracker.delegate,
      handsFound: hands.length,
      scores: result!.handedness.map((h) => h[0]?.score ?? 0),
      open: hands.map((hand) => isOpenHand(hand, aspect)),
      shapes: hands.map((hand) => handShape(hand, aspect)),
      posed: gesturePosed(hands, 'two-hands', aspect),
    };
  } finally {
    tracker.landmarker.close();
  }
}

declare module '../test-hooks' {
  interface SimHook extends Partial<StopGestureHook> {}
}

const STYLE = `
#stop-gesture { position: fixed; left: 668px; bottom: 12px; max-width: 300px; z-index: 5; padding: 6px 10px; background: rgba(255,255,255,.9); border: 1px solid #888; border-radius: 4px; font-size: 12px; }
#stop-gesture.holding { border-color: #c00; }
`;

/** Banner sentences by who set the latch; the banner itself is M1's (ui/states.ts). */
function bannerSentence(why: string | null, mode: GestureMode, synthetic: boolean): string | null {
  if (why === STOP_REASON) {
    const pose = mode === 'two-hands' ? 'both hands open' : 'one open palm, experimental';
    const from = synthetic ? ', from a synthetic replay, not a camera,' : '';
    return `The stop gesture (${pose})${from} stopped the arm. No commands are sent; every joint and the jaw hold.`;
  }
  if (why === 'voice') return 'A voice "stop" stopped the arm. No commands are sent; every joint and the jaw hold.';
  return null;
}

export function mountStopGesture(app: App, source: InputSource | null, withHooks: boolean): void {
  const latch: StopLatch | null = app.loop.stopLatch;
  const webcam = source instanceof WebcamSource ? source : null;
  const wanted = handsFromUrl(location.search) === 2;
  const detector = new StopGestureDetector('two-hands');
  let fallbackReason: string | null = null;
  let heldS = 0;
  let twoHandHolds = 0;
  let firedBySynthetic = false;
  const trackingMs: number[] = [];
  let replay: { kind: ReplayKind; stream: (t: number) => Landmark[][]; startS: number; seconds: number; next: number; report: ReplayReport; done: (r: ReplayReport) => void } | null = null;

  const fire = (): void => {
    if (!latch) return;
    firedBySynthetic = replay !== null;
    if (latch.stop(STOP_REASON, app.sim.time) && replay) {
      replay.report.latchAfterS = app.sim.time - replay.startS;
      replay.report.ctrlAtLatch = app.sim.getCtrl();
    }
  };

  // ---- The webcam: every hand MediaPipe finds, timed, before WebcamSource maps the best one ----
  const tap = (tracker: HandTracker): void => {
    const landmarker = tracker.landmarker;
    const original = landmarker.detectForVideo.bind(landmarker) as (image: unknown, timestamp: number) => HandLandmarkerResult;
    const tapped = (image: unknown, timestamp: number): HandLandmarkerResult => {
      const t0 = performance.now();
      const result = original(image, timestamp);
      const elapsed = performance.now() - t0;
      if (replay) return result;
      trackingMs.push(elapsed);
      if (trackingMs.length > TIMING_WINDOW) trackingMs.shift();
      if (detector.mode === 'two-hands' && shouldFallBack(trackingMs, 2)) {
        fallbackReason = `two-hand tracking took ${(medianOf(trackingMs) ?? 0).toFixed(0)} ms a frame (limit ${TRACKING_LIMIT_MS} ms)`;
        detector.mode = 'one-palm';
        detector.reset();
        trackingMs.length = 0;
        void landmarker.setOptions({ numHands: 1 }).catch(() => {});
      }
      const hands = result.landmarks.map((points) => points.map((q) => [q.x, q.y, q.z] as Landmark));
      const aspect = webcam!.video.videoWidth / Math.max(1, webcam!.video.videoHeight) || 1;
      const update = detector.update(hands, performance.now() / 1000, aspect);
      heldS = update.heldS;
      if (update.fired) fire();
      // Two hands in view: hold the arm (as if the hand were lost), so raising the second hand
      // and opening the pinching one cannot move the arm or open the jaw before the latch sets.
      if (detector.mode === 'two-hands' && hands.length >= 2) {
        twoHandHolds++;
        return { ...result, landmarks: [], worldLandmarks: [], handedness: [], handednesses: [] } as HandLandmarkerResult;
      }
      return result;
    };
    (landmarker as unknown as { detectForVideo: typeof tapped }).detectForVideo = tapped;
  };
  const enabled = wanted && latch !== null && (webcam === null || webcam.numHands === 2);
  if (enabled && webcam) webcam.prepare().then(tap, () => {});

  // ---- What the screen says ----
  if (!document.getElementById('stop-gesture-style')) {
    const style = document.createElement('style');
    style.id = 'stop-gesture-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  const box = document.createElement('div');
  box.id = 'stop-gesture';
  box.setAttribute('role', 'status');
  box.dataset.testid = 'stop-gesture';
  document.body.append(box);

  const lineNow = (): string => {
    if (!latch) return 'Stop gesture: not available (no stop latch). ';
    if (!enabled) return 'Stop gesture: off (add ?hands=2 to turn it on). Space stops the arm.';
    const hold = holdFor(detector.mode).toFixed(1);
    const pose = detector.mode === 'two-hands' ? `both hands open, all fingers out, for ${hold} s` : `one open palm, fingers fanned, for ${hold} s (experimental)`;
    let text = `Stop gesture: ${pose}. Space also stops.`;
    if (fallbackReason) text += ` Fell back to one palm: ${fallbackReason}.`;
    if (replay) text += ` [synthetic replay: ${replay.kind}]`;
    else if (!webcam || webcam.state !== 'running') text += ' Needs the camera.';
    if (heldS > 0 && !latch.stopped) text += ` Holding ${heldS.toFixed(1)} / ${hold} s.`;
    return text;
  };

  const banner = (): HTMLElement | null => document.querySelector<HTMLElement>('#stop-banner span');
  const m1Sentence = banner()?.textContent ?? null;
  latch?.onChange((stopped) => {
    const span = banner();
    if (!span || !stopped) return;
    span.textContent = bannerSentence(latch.why, detector.mode, firedBySynthetic) ?? m1Sentence ?? span.textContent;
  });

  // ---- Replays on simulated time, and the screen line, once per animation frame ----
  let lastUi = 0;
  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    if (replay) {
      const r = replay;
      const t = app.sim.time - r.startS;
      while (r.next / REPLAY_FPS <= Math.min(t, r.seconds) + 1e-9) {
        const at = r.next / REPLAY_FPS;
        const update = detector.update(r.stream(at), at, 1);
        heldS = update.heldS;
        if (update.fired) {
          r.report.fireAtS ??= at;
          fire();
        }
        r.next++;
      }
      if (t >= r.seconds) {
        Object.assign(r.report, {
          frames: detector.frames,
          posedFrames: detector.posedFrames,
          maxHeldS: detector.maxHeldS,
          fires: detector.fires,
          stoppedAtEnd: latch?.stopped ?? false,
          stopWhy: latch?.why ?? null,
        });
        replay = null;
        detector.reset();
        heldS = 0;
        r.done(r.report);
      }
    }
    if (now - lastUi < 100) return;
    lastUi = now;
    const text = lineNow();
    if (box.textContent !== text) box.textContent = text;
    box.classList.toggle('holding', heldS > 0);
  };
  requestAnimationFrame(frame);

  if (!withHooks || !window.__sim) return;
  const hooks: StopGestureHook = {
    stopGesture: () => ({
      enabled,
      mode: detector.mode,
      holdS: holdFor(detector.mode),
      trackerHands: webcam ? webcam.numHands : null,
      line: box.textContent ?? '',
      frames: detector.frames,
      posedFrames: detector.posedFrames,
      heldS,
      fires: detector.fires,
      twoHandHolds,
      medianTrackingMs: medianOf(trackingMs),
      fallbackReason,
      stopped: latch?.stopped ?? false,
      stopWhy: latch?.why ?? null,
      stopSince: latch?.since ?? null,
    }),
    replayStopGesture: (kind, seconds) =>
      new Promise<ReplayReport>((resolve, reject) => {
        if (replay) return reject(new Error('a replay is already running'));
        if (!enabled) return reject(new Error('the stop gesture is off (needs ?hands=2)'));
        const plan = (() => {
          try {
            return cubePickPlan(app.sim);
          } catch {
            return { objectCenter: [0, -0.22, 0.015] as [number, number, number], objectHalfWidth: 0.015, start: [0, -0.2, 0.15] as [number, number, number] };
          }
        })();
        detector.reset();
        const startS = app.sim.time;
        replay = {
          kind,
          stream: replayStream(kind, plan),
          startS,
          seconds,
          next: 0,
          done: resolve,
          report: {
            kind,
            source: 'synthetic replay',
            seconds,
            frames: 0,
            posedFrames: 0,
            maxHeldS: 0,
            fires: 0,
            startSimS: startS,
            fireAtS: null,
            latchAfterS: null,
            ctrlAtLatch: null,
            stoppedAtEnd: false,
            stopWhy: null,
          },
        };
      }),
    stopGestureOnPicture,
  };
  Object.defineProperties(window.__sim, Object.getOwnPropertyDescriptors(hooks));
}
