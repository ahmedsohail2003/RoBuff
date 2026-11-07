import type { HandState, Landmark } from '../input/handState';

/** The 21-point hand skeleton: each finger from the wrist, plus the knuckle line. */
const BONES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];

const WIDTH = 240;
const HEIGHT = 180;

/**
 * Picture-in-picture view of what the tracker sees: the camera frame (if there is one)
 * and the landmarks, mirrored like a selfie so moving right looks like moving right.
 */
export class HandOverlay {
  readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  framesDrawn = 0;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'hand-view';
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    this.canvas.setAttribute('aria-label', 'Hand tracking view');
    parent.appendChild(this.canvas);
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('no 2D canvas context');
    this.context = context;
  }

  draw(hand: HandState | null, video: HTMLVideoElement | null, label: string): void {
    const g = this.context;
    g.save();
    g.fillStyle = '#20242b';
    g.fillRect(0, 0, WIDTH, HEIGHT);
    g.translate(WIDTH, 0);
    g.scale(-1, 1);
    if (video && video.readyState >= 2) g.drawImage(video, 0, 0, WIDTH, HEIGHT);
    if (hand?.landmarks) this.drawHand(hand.landmarks, hand.pinch >= 0.5);
    g.restore();

    const tracking = hand ? (hand.confidence >= 0.5 ? 'tracking' : 'hand lost, holding') : 'no hand yet';
    const pinch = hand ? (hand.pinch >= 0.5 ? 'closed' : 'open') : '-';
    g.fillStyle = 'rgba(0, 0, 0, 0.55)';
    g.fillRect(0, HEIGHT - 20, WIDTH, 20);
    g.fillStyle = '#fff';
    g.font = '12px system-ui, sans-serif';
    g.fillText(`${label} | ${tracking} | grip ${pinch}`, 6, HEIGHT - 6);
    this.framesDrawn++;
  }

  private drawHand(landmarks: readonly Landmark[], closed: boolean): void {
    const g = this.context;
    const at = (i: number): [number, number] => [landmarks[i]![0] * WIDTH, landmarks[i]![1] * HEIGHT];
    g.strokeStyle = '#7fd6ff';
    g.lineWidth = 2;
    g.beginPath();
    for (const [a, b] of BONES) {
      const [ax, ay] = at(a);
      const [bx, by] = at(b);
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
    }
    g.stroke();
    landmarks.forEach((_, i) => {
      const [x, y] = at(i);
      g.fillStyle = i === 4 || i === 8 ? (closed ? '#ff6b6b' : '#ffd166') : '#ffffff';
      g.beginPath();
      g.arc(x, y, i === 4 || i === 8 ? 4 : 2.5, 0, Math.PI * 2);
      g.fill();
    });
  }
}
