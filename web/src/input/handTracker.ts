import { HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';
import type { RawHand } from './handMapper';

const BASE = import.meta.env.BASE_URL;

/** Served from public/: the WASM is copied from the pinned npm package, the model is checked in. */
export const MEDIAPIPE_FILES = {
  wasmLoaderPath: `${BASE}mediapipe/wasm/vision_wasm_internal.js`,
  wasmBinaryPath: `${BASE}mediapipe/wasm/vision_wasm_internal.wasm`,
  model: `${BASE}mediapipe/hand_landmarker.task`,
} as const;

export type Delegate = 'GPU' | 'CPU';

export interface HandTracker {
  landmarker: HandLandmarker;
  delegate: Delegate;
  /** Why the GPU delegate was not used, if it failed. */
  gpuError: string | null;
  createMs: number;
}

/** HandLandmarker in VIDEO mode from the local files. Tries the GPU delegate, then the CPU. */
export async function createHandTracker(numHands = 1): Promise<HandTracker> {
  const fileset = { wasmLoaderPath: MEDIAPIPE_FILES.wasmLoaderPath, wasmBinaryPath: MEDIAPIPE_FILES.wasmBinaryPath };
  const start = performance.now();
  let gpuError: string | null = null;
  for (const delegate of ['GPU', 'CPU'] as const) {
    try {
      const landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MEDIAPIPE_FILES.model, delegate },
        runningMode: 'VIDEO',
        numHands,
      });
      return { landmarker, delegate, gpuError, createMs: performance.now() - start };
    } catch (error) {
      if (delegate === 'CPU') throw error;
      gpuError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error('unreachable');
}

/**
 * Hands in a result as RawHand. The score is the handedness classifier's score for the
 * hand; MediaPipe has already dropped hands below its presence threshold (0.5 by default).
 */
export function handsFromResult(result: HandLandmarkerResult): RawHand[] {
  return result.landmarks.map((points, i) => ({
    landmarks: points.map((point) => [point.x, point.y, point.z] as [number, number, number]),
    score: result.handedness[i]?.[0]?.score ?? 0,
  }));
}

/** The most confident hand, or null. */
export function bestHand(hands: readonly RawHand[]): RawHand | null {
  return hands.reduce<RawHand | null>((best, hand) => (!best || hand.score > best.score ? hand : best), null);
}
