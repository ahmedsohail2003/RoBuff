import type { Landmark } from './handState';
import { palmSize } from './landmarks';

/** Finger chains from the knuckle row out to the tip, by MediaPipe landmark number. */
const FINGERS: ReadonlyArray<readonly number[]> = [
  [1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];
/** Finger width at the knuckle, as a fraction of palm size (thumb, index, middle, ring, pinky). */
const FINGER_WIDTH = [0.26, 0.21, 0.22, 0.2, 0.17];
const PALM_OUTLINE = [0, 1, 2, 5, 9, 13, 17];

export interface DrawHandOptions {
  skin?: string;
  shade?: string;
  background?: string;
}

/**
 * Paints a flat, skin-coloured hand (palm, forearm, tapered fingers) over 21 landmarks in
 * image units, so a test can make a camera picture without a photograph. The landmarks are
 * the synthetic hand's, so the picture is ours; what the tracker reads back from it is
 * whatever it finds.
 */
export function drawHand(g: CanvasRenderingContext2D, landmarks: readonly Landmark[], width: number, height: number, options: DrawHandOptions = {}): void {
  const skin = options.skin ?? '#d8a27f';
  const shade = options.shade ?? '#b9805d';
  g.fillStyle = options.background ?? '#cfd4d8';
  g.fillRect(0, 0, width, height);
  const px = (i: number): [number, number] => [landmarks[i]![0] * width, landmarks[i]![1] * height];
  // Palm size is in units of image height.
  const size = palmSize(landmarks, width / height) * height;
  g.lineCap = 'round';
  g.lineJoin = 'round';

  // Forearm: from the wrist, away from the middle knuckle.
  const [wx, wy] = px(0);
  const [mx, my] = px(9);
  const len = Math.hypot(wx - mx, wy - my) || 1;
  const [ux, uy] = [(wx - mx) / len, (wy - my) / len];
  g.strokeStyle = skin;
  g.lineWidth = size * 0.85;
  g.beginPath();
  g.moveTo(wx, wy);
  g.lineTo(wx + ux * size * 3, wy + uy * size * 3);
  g.stroke();

  // Palm.
  g.fillStyle = skin;
  g.beginPath();
  PALM_OUTLINE.forEach((i, k) => {
    const [x, y] = px(i);
    if (k === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  });
  g.closePath();
  g.fill();
  g.lineWidth = size * 0.3;
  g.stroke();

  // Fingers, tapering toward the tip, each with a darker edge so they read as separate.
  FINGERS.forEach((chain, f) => {
    const base = FINGER_WIDTH[f]! * size;
    for (const [colour, extra] of [[shade, size * 0.04], [skin, 0]] as const) {
      g.strokeStyle = colour;
      for (let s = 0; s < chain.length - 1; s++) {
        const last = s === chain.length - 2;
        const [ax, ay] = px(chain[s]!);
        const [bx, by] = px(chain[s + 1]!);
        g.lineWidth = base * (1 - 0.12 * s) + extra;
        g.beginPath();
        // The tip landmark sits near the fingertip's centre; extend past it to the end of the finger.
        const k = last ? 1.25 : 1;
        g.moveTo(ax, ay);
        g.lineTo(ax + (bx - ax) * k, ay + (by - ay) * k);
        g.stroke();
      }
    }
  });
}
