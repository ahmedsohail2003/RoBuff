import { HandMapper } from './handMapper';
import type { HandState, InputSource } from './handState';
import { bestHand, createHandTracker, handsFromResult, warmUp, type HandTracker } from './handTracker';

export type WebcamState = 'idle' | 'starting-camera' | 'loading-model' | 'running' | 'denied' | 'no-camera' | 'error';

/** The hand model, loaded and warmed before the camera starts. */
export type TrackerState = 'idle' | 'loading' | 'warming-up' | 'warm' | 'failed';

/** With no new detection for this long, the hand counts as lost and the arm holds. */
const STALE_MS = 400;
const TIMING_WINDOW = 120;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A plain-language reason for a getUserMedia failure, and which state it puts us in. */
function cameraFailure(error: unknown): { state: WebcamState; message: string } {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return { state: 'denied', message: 'Camera permission was denied.' };
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') {
    return { state: 'no-camera', message: name === 'NotReadableError' ? 'The camera is in use by another app.' : 'No camera was found.' };
  }
  return { state: 'error', message: `The camera could not start: ${error instanceof Error ? error.message : String(error)}` };
}

/**
 * Webcam hand tracking: getUserMedia, MediaPipe HandLandmarker in VIDEO mode on the main
 * thread, once per new video frame, then the shared HandMapper. Detection runs on wall
 * time, separate from physics; poll() hands the control loop the latest mapped state.
 */
export class WebcamSource implements InputSource {
  readonly kind = 'webcam';
  readonly video: HTMLVideoElement;
  state: WebcamState = 'idle';
  message: string | null = null;

  private tracker: HandTracker | null = null;
  trackerState: TrackerState = 'idle';
  /** How long the warm-up detection took, in ms. */
  warmupMs: number | null = null;
  private preparing: Promise<HandTracker> | null = null;
  private stream: MediaStream | null = null;
  private readonly mapper = new HandMapper();
  private latest: HandState | null = null;
  private lastVideoTime = -1;
  private lastDetectMs = -Infinity;
  private lastTimestamp = 0;
  private stopped = false;
  private readonly inferenceMs: number[] = [];
  private counts = { videoFrames: 0, detections: 0, framesWithHand: 0 };
  private firstDetectionMs: number | null = null;
  private lastScore: number | null = null;

  constructor(readonly numHands: 1 | 2 = 1) {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
  }

  /**
   * Loads the hand model and runs one warm-up detection, without the camera. Safe to call
   * more than once; start() waits for it. Rejects if the model will not load.
   */
  prepare(): Promise<HandTracker> {
    this.preparing ??= (async () => {
      this.trackerState = 'loading';
      try {
        const tracker = await createHandTracker(this.numHands);
        if (this.stopped) {
          tracker.landmarker.close();
          throw new Error('stopped');
        }
        this.trackerState = 'warming-up';
        // Let the page paint "warming up" before the call blocks the main thread.
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (this.stopped) {
          tracker.landmarker.close();
          throw new Error('stopped');
        }
        this.warmupMs = warmUp(tracker);
        this.tracker = tracker;
        this.trackerState = 'warm';
        return tracker;
      } catch (error) {
        this.trackerState = 'failed';
        throw error;
      }
    })();
    return this.preparing;
  }

  /** Starts camera and model. Resolves to the final state; it never throws. */
  async start(): Promise<WebcamState> {
    // The model loads while the camera permission is asked; its failure is reported below.
    this.prepare().catch(() => {});
    if (!navigator.mediaDevices?.getUserMedia) {
      return this.fail('no-camera', 'This page cannot use a camera here (it needs https or localhost).');
    }
    this.state = 'starting-camera';
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    } catch (error) {
      const { state, message } = cameraFailure(error);
      return this.fail(state, message);
    }
    if (this.stopped) return this.state;
    this.video.srcObject = this.stream;
    try {
      await this.video.play();
    } catch (error) {
      return this.fail('error', `The camera stream would not play: ${error instanceof Error ? error.message : String(error)}`);
    }

    this.state = 'loading-model';
    try {
      await this.prepare();
    } catch (error) {
      return this.fail('error', `The hand tracking model would not load: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.stopped) return this.state;
    this.state = 'running';
    this.scheduleNext();
    return this.state;
  }

  poll(tMs: number): HandState | null {
    if (!this.latest) return null;
    if (performance.now() - this.lastDetectMs > STALE_MS) return { palm: [...this.latest.palm], pinch: this.latest.pinch, confidence: 0, tMs };
    return this.latest;
  }

  reset(): void {
    this.mapper.reset();
    this.latest = null;
  }

  describe(): Record<string, unknown> {
    return {
      state: this.state,
      message: this.message,
      numHands: this.numHands,
      trackerState: this.trackerState,
      warmupMs: this.warmupMs,
      delegate: this.tracker?.delegate ?? null,
      gpuError: this.tracker?.gpuError ?? null,
      modelLoadMs: this.tracker?.createMs ?? null,
      videoWidth: this.video.videoWidth,
      videoHeight: this.video.videoHeight,
      ...this.counts,
      firstDetectionMs: this.firstDetectionMs,
      lastInferenceMs: this.inferenceMs.at(-1) ?? null,
      medianInferenceMs: median(this.inferenceMs),
      maxInferenceMs: this.inferenceMs.length ? Math.max(...this.inferenceMs) : null,
      inferenceSamples: this.inferenceMs.length,
      lastScore: this.lastScore,
      hand: this.latest,
      mapping: 'landmarks -> HandMapper',
      mapper: this.mapper.stats(),
    };
  }

  dispose(): void {
    this.stopped = true;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video.srcObject = null;
    this.tracker?.landmarker.close();
    this.tracker = null;
  }

  private fail(state: WebcamState, message: string): WebcamState {
    this.state = state;
    this.message = message;
    this.dispose();
    return state;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    if ('requestVideoFrameCallback' in this.video) this.video.requestVideoFrameCallback(() => this.onVideoFrame());
    else requestAnimationFrame(() => this.onVideoFrame());
  }

  private onVideoFrame(): void {
    if (this.stopped || !this.tracker) return;
    try {
      if (this.video.currentTime !== this.lastVideoTime && this.video.readyState >= 2) {
        this.lastVideoTime = this.video.currentTime;
        this.counts.videoFrames++;
        this.detect();
      }
    } catch (error) {
      this.fail('error', `Hand tracking stopped: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.scheduleNext();
  }

  private detect(): void {
    const tracker = this.tracker!;
    // VIDEO mode needs strictly increasing timestamps.
    const now = performance.now();
    const timestamp = Math.max(now, this.lastTimestamp + 1);
    this.lastTimestamp = timestamp;
    const result = tracker.landmarker.detectForVideo(this.video, timestamp);
    const elapsed = performance.now() - now;
    this.firstDetectionMs ??= elapsed;
    // The first call includes one-off GPU setup, so it is kept out of the timing window.
    if (this.counts.detections > 0) {
      this.inferenceMs.push(elapsed);
      if (this.inferenceMs.length > TIMING_WINDOW) this.inferenceMs.shift();
    }
    this.counts.detections++;
    const hand = bestHand(handsFromResult(result));
    if (hand) this.counts.framesWithHand++;
    this.lastScore = hand?.score ?? null;
    const aspect = this.video.videoWidth / Math.max(1, this.video.videoHeight) || 1;
    const state = this.mapper.update(hand, now, aspect);
    if (state) this.latest = state;
    this.lastDetectMs = performance.now();
  }
}
