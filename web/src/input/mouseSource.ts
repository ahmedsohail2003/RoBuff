import type { HandState, InputSource } from './handState';

const DEPTH_STEP = 0.05;
const START_DEPTH = 0.4;

/**
 * Fallback without a camera. The pointer over the view sets image x, y (the arm stays put
 * while a button is held, so dragging still orbits the camera); W and S move the depth;
 * G toggles the grip. It reports no landmarks.
 */
export class MouseSource implements InputSource {
  readonly kind = 'mouse';
  private x: number | null = null;
  private y = 0.5;
  private depth = START_DEPTH;
  private closed = false;
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
        this.x = (event.clientX - rect.left) / Math.max(1, rect.width);
        this.y = (event.clientY - rect.top) / Math.max(1, rect.height);
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
    return { tracking: this.x !== null, depth: this.depth, closed: this.closed, note: this.note };
  }

  dispose(): void {
    this.abort.abort();
  }
}
