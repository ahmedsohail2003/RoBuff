import type { Vec3 } from '../sim/simulation';

/** One hand landmark in MediaPipe's layout: x, y normalized to the image (y down), z relative depth. */
export type Landmark = [number, number, number];

/**
 * What every input source produces. The control path after this is the same for all of them.
 * palm: x, y in image coordinates (0..1, y down) and z a depth estimate (0 far .. 1 near camera).
 */
export interface HandState {
  /** The 21 MediaPipe hand landmarks, when the source has them. */
  landmarks?: Landmark[];
  palm: Vec3;
  /** 0 is an open hand, 1 is thumb and index pressed together. */
  pinch: number;
  /** Thumb-to-index distance over palm size, before the hysteresis latch, when landmarks exist. */
  pinchRatio?: number;
  /** 0..1. Below the controller's threshold the arm holds its pose. */
  confidence: number;
  tMs: number;
}

export interface InputSource {
  readonly kind: 'webcam' | 'synthetic' | 'mouse';
  /** Latest hand state at simulated time tMs, or null if there is none to act on. */
  poll(tMs: number): HandState | null;
  /** Restart from the beginning, after the simulation resets. */
  reset(): void;
  /** Source-specific progress, for the debug hook and the status line. */
  describe(): Record<string, unknown>;
  dispose(): void;
}
