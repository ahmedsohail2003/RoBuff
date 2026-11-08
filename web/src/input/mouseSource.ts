import { CONTROL_GAINS } from '../control/gains';
import type { HandState, InputSource } from './handState';

const DEPTH_STEP = 0.05;
const START_DEPTH = 0.4;
/** Pointer travel is scaled about the middle of the view, so the net mouse gain is CONTROL_GAINS.mouse. */
const POINTER_SCALE = CONTROL_GAINS.mouse / CONTROL_GAINS.hand;

/** Pointer position over the view (0..1) to the image position the hand mapping takes. */
export function pointerToImage(fraction: number): number {
  return 0.5 + (fraction - 0.5) * POINTER_SCALE;
}

/** A left press and release closer than this (CSS px) counts as a click, not a drag. */
export const CLICK_SLOP_PX = 5;

/** True when a left press at down and its release at up make a click (no drag between). */
export function isClick(down: { x: number; y: number }, up: { x: number; y: number }): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) <= CLICK_SLOP_PX;
}

/**
 * Fallback without a camera. The pointer over the view sets image x, y (the arm stays put
 * while a button is held, so a right drag can orbit the camera); W and S move the depth;
 * a left click on the view or G toggles the grip. It reports no landmarks.
 */
export class MouseSource implements InputSource {
  readonly kind = 'mouse';
  private x: number | null = null;
  private y = 0.5;
  private depth = START_DEPTH;
  private closed = false;
  private clicks = 0;
  private press: { x: number; y: number; id: number } | null = null;
  private readonly abort = new AbortController();

  constructor(
    element: HTMLElement,
    readonly note: string | null = null,
  ) {
    const signal = this.abort.signal;
    element.addEventListener(
      'pointermove',
      (event) => {
        if (event.buttons !== 0) return;
        const rect = element.getBoundingClientRect();
        this.x = pointerToImage((event.clientX - rect.left) / Math.max(1, rect.width));
        this.y = pointerToImage((event.clientY - rect.top) / Math.max(1, rect.height));
      },
      { signal },
    );
    element.addEventListener(
      'pointerdown',
      (event) => {
        this.press = event.button === 0 ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
      },
      { signal },
    );
    element.addEventListener(
      'pointerup',
      (event) => {
        const press = this.press;
        this.press = null;
        if (event.button !== 0 || !press || press.id !== event.pointerId) return;
        if (!isClick(press, { x: event.clientX, y: event.clientY })) return;
        this.closed = !this.closed;
        this.clicks++;
      },
      { signal },
    );
    window.addEventListener(
      'keydown',
      (event) => {
        const key = event.key.toLowerCase();
        if (key === 'w') this.depth = Math.min(1, this.depth + DEPTH_STEP);
        else if (key === 's') this.depth = Math.max(0, this.depth - DEPTH_STEP);
        else if (key === 'g') this.closed = !this.closed;
      },
      { signal },
    );
  }

  poll(tMs: number): HandState | null {
    if (this.x === null) return null;
    return { palm: [this.x, this.y, this.depth], pinch: this.closed ? 1 : 0, confidence: 1, tMs };
  }

  reset(): void {
    this.x = null;
    this.depth = START_DEPTH;
    this.closed = false;
  }

  describe(): Record<string, unknown> {
    return { tracking: this.x !== null, depth: this.depth, closed: this.closed, clicks: this.clicks, note: this.note };
  }

  dispose(): void {
    this.abort.abort();
  }
}
