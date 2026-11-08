// The plain-text states of the core loop: status strip, camera start screen, hand lost,
// the Space stop and the hand-to-arm range. The console look comes later (M7).

import type { App } from '../app';
import { handRangeText } from '../control/handMapping';
import { drawHand } from '../input/drawHand';
import type { HandState, InputSource } from '../input/handState';
import { syntheticLandmarks } from '../input/syntheticHand';
import type { TrackerState, WebcamSource } from '../input/webcamSource';
import { showNotice } from '../render/notice';
import { isStopKey, StopLatch } from '../safety/latch';

export type InputKind = InputSource['kind'];

/** Below this confidence the control loop ignores the hand (same as handMapping's MIN_CONFIDENCE). */
const TRACKING_CONFIDENCE = 0.5;

/**
 * Which input to start with. ?input=webcam|synthetic|mouse wins. With no ?input, the webcam
 * when the browser lists a camera, else the mouse. Listing devices needs no permission.
 */
export async function chooseInputKind(search: string, devices?: () => Promise<Pick<MediaDeviceInfo, 'kind'>[]>): Promise<{ kind: InputKind; why: string }> {
  const value = new URLSearchParams(search).get('input');
  if (value === 'webcam' || value === 'synthetic' || value === 'mouse') return { kind: value, why: 'set by ?input' };
  const list = devices ?? (() => navigator.mediaDevices?.enumerateDevices?.() ?? Promise.resolve([]));
  try {
    const found = (await list()).some((device) => device.kind === 'videoinput');
    return found ? { kind: 'webcam', why: 'a camera was found' } : { kind: 'mouse', why: 'no camera found' };
  } catch {
    return { kind: 'mouse', why: 'cameras could not be listed' };
  }
}

/** The on-screen line about the hand, or null when there is nothing to say. */
export function handBanner(kind: InputKind | null, webcamState: string | null, hand: HandState | null): string | null {
  if (kind !== 'webcam' || webcamState !== 'running') return null;
  if (!hand) return 'show one hand to the camera';
  if (hand.confidence < TRACKING_CONFIDENCE) return 'hand lost, arm holding';
  return null;
}

export interface StatusNumbers {
  version: string;
  input: string;
  trackingMs: number | null;
  physicsMs: number;
  fps: number;
  grip: string;
  stopped: boolean;
}

/** One plain status line: tracking ms, physics ms, fps, input kind, grip state. */
export function statusLine(n: StatusNumbers): string {
  const tracking = n.trackingMs === null ? 'tracking -' : `tracking ${n.trackingMs.toFixed(0)} ms`;
  const parts = [n.version, n.input, tracking, `physics ${n.physicsMs.toFixed(1)} ms`, `${n.fps.toFixed(0)} fps`, `grip ${n.grip}`];
  if (n.stopped) parts.push('STOPPED');
  return parts.join(' | ');
}

/** What the start screen says about the hand model while it loads and warms up. */
export function trackerLine(state: TrackerState, warmupMs: number | null): string {
  switch (state) {
    case 'idle':
    case 'loading':
      return 'Hand tracking: loading the model...';
    case 'warming-up':
      return 'Hand tracking: warming up (the page can pause for a few seconds)...';
    case 'warm':
      return `Hand tracking: tracking warm (first run took ${((warmupMs ?? 0) / 1000).toFixed(1)} s)`;
    case 'failed':
      return 'Hand tracking: the model did not load. The mouse still works.';
  }
}

/** What the mouse does, for the status line. */
export const MOUSE_HINT = 'move to steer, W/S reach, left click or G grip, right drag orbits';

function describeInput(app: App): string {
  const source = app.loop.source;
  if (!source) return 'input: direct commands';
  const info = source.describe();
  if (source.kind === 'synthetic') return `input: synthetic hand, ${String(info.phase ?? 'starting')}`;
  if (source.kind === 'webcam') return `input: webcam, ${String(info.state)}`;
  if (info.note) return `input: ${String(info.note)}`;
  return `input: mouse (${MOUSE_HINT})`;
}

function gripWord(app: App): string {
  const grip = app.loop.controller.status().appliedGrip;
  if (grip === null) return 'open';
  return grip >= 0.5 ? 'closed' : 'open';
}

const STYLE = `
#hand-state { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); padding: 8px 14px; background: #fff3cd; border: 1px solid #b58900; border-radius: 4px; font-size: 15px; }
#stop-banner { position: fixed; z-index: 20; left: 50%; top: 40%; transform: translate(-50%, -50%); max-width: 520px; padding: 10px 14px; background: #fff; border: 2px solid #c00; border-radius: 4px; font-size: 15px; display: flex; gap: 12px; align-items: center; }
#stop-banner strong { color: #c00; }
#stop-banner button, #camera-intro button { font: inherit; padding: 4px 12px; }
#hand-range { position: fixed; right: 12px; bottom: 198px; max-width: 360px; padding: 4px 8px; background: rgba(255,255,255,.85); border-radius: 4px; font-size: 12px; }
#camera-intro { position: fixed; z-index: 20; left: 50%; top: 96px; transform: translateX(-50%); max-width: 460px; padding: 12px 16px; background: #fff; border: 1px solid #357; border-radius: 4px; font-size: 14px; }
#camera-intro p { margin: 0 0 10px; }
#camera-intro .buttons { display: flex; gap: 8px; }
#hand-state[hidden], #stop-banner[hidden], #hand-range[hidden] { display: none; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text) node.textContent = text;
  return node;
}

export interface StateHook {
  /** True while the stop latch is set: no commands reach the arm. */
  readonly stopped: boolean;
  /** Sets the stop latch, as the Space key does. */
  stop(): void;
  /** Clears it, as the Resume button does. */
  clearStop(): void;
  /** What the state elements on screen say now. */
  screenStates(): { status: string; handState: string | null; stopBanner: string | null; handRange: string | null; cameraIntro: string | null };
  /**
   * A 640 x 480 PNG data URL of the synthetic hand painted as a picture (no photograph),
   * for the fake-camera and detection tests. palm is image x, y and depth 0..1.
   */
  syntheticHandPicture(palm: [number, number, number], pinch: number): string;
}

declare module '../test-hooks' {
  interface SimHook extends Partial<StateHook> {}
}

/**
 * Wires the states into the page. Call once after the app starts; call frame() every
 * animation frame. useMouse switches the input to the mouse with a note.
 */
export class AppStates {
  readonly stop = new StopLatch();
  private shownStatus = '';
  private readonly handState = el('div', { id: 'hand-state', role: 'status' });
  private readonly stopBanner = el('div', { id: 'stop-banner', role: 'alert' });
  private readonly handRange = el('div', { id: 'hand-range' });

  constructor(
    private readonly app: App,
    private readonly version: string,
    private readonly status: HTMLElement,
    private readonly useMouse: (note: string | null) => void,
  ) {
    if (!document.getElementById('states-style')) document.head.appendChild(el('style', { id: 'states-style' }, STYLE));
    app.loop.stopLatch = this.stop;

    this.handState.hidden = true;
    this.stopBanner.hidden = true;
    const resume = el('button', { type: 'button', id: 'stop-clear' }, 'Resume');
    resume.addEventListener('click', () => this.stop.clear());
    this.stopBanner.append(el('strong', {}, 'STOPPED'), el('span', {}, 'Space stopped the arm. No commands are sent; every joint and the jaw hold.'), resume);
    this.handRange.textContent = handRangeText();
    document.body.append(this.handState, this.stopBanner, this.handRange);

    window.addEventListener('keydown', (event) => {
      if (!isStopKey(event, event.target)) return;
      // Space would also press a focused button (Resume included); here it only ever stops.
      event.preventDefault();
      if (!event.repeat) this.stop.stop('space key', app.sim.time);
    });
    this.stop.onChange((stopped) => {
      this.stopBanner.hidden = !stopped;
      if (stopped) resume.focus({ preventScroll: true });
    });
  }

  /**
   * The start screen for the webcam: why the camera is wanted, the hand model warming up
   * meanwhile, and the mouse as the other choice. Nothing asks for the camera until
   * "Use camera" is pressed.
   */
  showCameraIntro(source: WebcamSource, startWebcam: () => void): void {
    document.getElementById('camera-intro')?.remove();
    const box = el('div', { id: 'camera-intro', role: 'dialog', 'aria-label': 'Camera' });
    box.append(
      el('p', {}, 'Robuff follows one hand with your camera: move your hand to steer the arm, pinch thumb and index finger to grip. The video stays on this computer; nothing is uploaded.'),
    );
    const line = el('p', { id: 'tracker-line' }, trackerLine(source.trackerState, source.warmupMs));
    box.append(line);
    const buttons = el('div', { class: 'buttons' });
    const useCamera = el('button', { type: 'button' }, 'Use camera');
    const mouse = el('button', { type: 'button' }, 'Use mouse instead');
    useCamera.addEventListener('click', () => {
      box.remove();
      startWebcam();
    });
    mouse.addEventListener('click', () => {
      box.remove();
      this.useMouse(`mouse (chosen on the start screen); ${MOUSE_HINT}`);
    });
    buttons.append(useCamera, mouse);
    box.append(buttons);
    document.body.append(box);
    const refresh = () => {
      line.textContent = trackerLine(source.trackerState, source.warmupMs);
    };
    source.prepare().then(refresh, refresh);
    const timer = setInterval(() => {
      refresh();
      if (!box.isConnected || source.trackerState === 'warm' || source.trackerState === 'failed') clearInterval(timer);
    }, 100);
  }

  /** Starts the camera; if there is none or it is refused, says so and offers the mouse. */
  async startWebcam(source: WebcamSource): Promise<void> {
    const state = await source.start();
    if (state === 'running') return;
    showNotice(`${source.message ?? 'The camera is not available.'} You can steer the arm with the mouse instead.`, [
      { label: 'Use mouse instead', run: () => this.useMouse(`mouse (camera unavailable); ${MOUSE_HINT}`) },
    ]);
  }

  frame(): void {
    const app = this.app;
    const source = app.loop.source;
    const info = source?.describe() ?? {};
    const trackingMs = source?.kind === 'webcam' && typeof info.medianInferenceMs === 'number' ? info.medianInferenceMs : null;
    const text = statusLine({
      version: this.version,
      input: describeInput(app),
      trackingMs,
      physicsMs: app.lastPhysicsMs,
      fps: app.fps,
      grip: gripWord(app),
      stopped: this.stop.stopped,
    });
    if (text !== this.shownStatus) this.status.textContent = this.shownStatus = text;

    const banner = handBanner(source?.kind ?? null, source?.kind === 'webcam' ? String(info.state) : null, app.loop.lastHand);
    this.handState.hidden = banner === null;
    if (banner !== null && this.handState.textContent !== banner) this.handState.textContent = banner;

    const showRange = source?.kind === 'webcam' || source?.kind === 'mouse';
    this.handRange.hidden = !showRange;
    if (showRange) {
      const range = handRangeText() + (app.loop.lastCommand?.clamped ? ' | at the edge: target pulled back in' : '');
      if (this.handRange.textContent !== range) this.handRange.textContent = range;
    }
  }

  /** Adds stopped, stop(), clearStop() and screenStates() to window.__sim (dev and test builds). */
  installHooks(): void {
    const target = window.__sim;
    if (!target) return;
    const shown = (node: HTMLElement | null) => (node && node.isConnected && node.checkVisibility() ? (node.textContent ?? '') : null);
    const latch = this.stop;
    const hooks: StateHook = {
      get stopped() {
        return latch.stopped;
      },
      stop: () => {
        latch.stop('test hook', this.app.sim.time);
      },
      clearStop: () => {
        latch.clear();
      },
      screenStates: () => ({
        status: this.status.textContent ?? '',
        handState: shown(this.handState),
        stopBanner: shown(this.stopBanner),
        handRange: shown(this.handRange),
        cameraIntro: shown(document.getElementById('camera-intro')),
      }),
      syntheticHandPicture: (palm, pinch) => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const g = canvas.getContext('2d');
        if (!g) throw new Error('no 2D canvas context');
        drawHand(g, syntheticLandmarks(palm, pinch), canvas.width, canvas.height);
        return canvas.toDataURL('image/png');
      },
    };
    Object.defineProperties(target, Object.getOwnPropertyDescriptors(hooks));
  }
}
