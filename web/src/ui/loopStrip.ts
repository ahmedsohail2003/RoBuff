// The Sense -> Understand -> Act strip at the top of the viewport. Each stage shows live
// values and lights up while it is doing something: Sense while a hand is being read,
// Understand while a pinch changes, the guardrail checks a request or the ghost error is
// live, Act while the arm or jaw moves or the console voice speaks. Every value comes from
// the running app; nothing here is a placeholder.

export type StageName = 'sense' | 'understand' | 'act';

/** One snapshot of what the loop is doing, gathered by the console every 100 ms. */
export interface LoopReading {
  input: 'webcam' | 'synthetic' | 'mouse' | null;
  /** Camera frames per second, measured from the video frames the tracker received. */
  cameraFps: number | null;
  /** Median hand-model inference time. */
  trackingMs: number | null;
  webcamState: string | null;
  /** A hand with confidence >= 0.5 this frame. */
  handSeen: boolean;
  /** The webcam had a hand and lost it: the arm holds. */
  handLost: boolean;
  pinch: 'open' | 'closed' | null;
  pinchRatio: number | null;
  /** The object panel's last verdict (PASS, ADJUSTED, REFUSED, ...), or null before any request. */
  guardrail: string | null;
  guardrailBusy: boolean;
  /** Where object specs come from now. */
  specSource: string;
  /** Ghost error in mm while the ghost is on and has history; null otherwise. */
  ghostErrorMm: number | null;
  ghostLevel: string | null;
  ghostOn: boolean;
  /** Moon modes: what the operator sees is 1.28 s old. */
  delayed: boolean;
  stopped: boolean;
  stopWhy: string | null;
  /** Gripper speed of the live (truth) arm, mm per simulated second. */
  gripperSpeedMmS: number;
  jaw: 'open' | 'closed';
  jawMoving: boolean;
  /** The console voice is speaking, or a caption went up in the last few seconds. */
  speaking: boolean;
  lastLine: string | null;
  /** ?mute=1: lines are captioned, never spoken. */
  voiceMuted: boolean;
}

export interface StageView {
  active: boolean;
  /** 'stopped' and 'holding' get their own colour. */
  state: 'normal' | 'stopped' | 'holding';
  text: string;
}

/** The arm counts as moving above this gripper speed. */
export const MOVING_MM_S = 5;

function senseText(r: LoopReading): string {
  switch (r.input) {
    case 'webcam': {
      if (r.webcamState !== 'running') return `camera ${r.webcamState ?? 'idle'}`;
      const fps = r.cameraFps === null ? 'camera - fps' : `camera ${r.cameraFps.toFixed(0)} fps`;
      const ms = r.trackingMs === null ? 'tracking -' : `tracking ${r.trackingMs.toFixed(0)} ms`;
      const hand = r.handLost ? 'hand lost' : r.handSeen ? 'hand seen' : 'no hand';
      return `${fps} · ${ms} · ${hand}`;
    }
    case 'synthetic':
      return 'synthetic hand (scripted test input) · 21 landmarks';
    case 'mouse':
      return r.handSeen ? 'mouse pointer (no camera)' : 'mouse: move over the scene';
    default:
      return 'direct commands (no hand input)';
  }
}

function understandText(r: LoopReading): string {
  const parts: string[] = [];
  if (r.pinch === null) parts.push('pinch -');
  else parts.push(`pinch ${r.pinch}${r.pinchRatio === null ? '' : ` (${r.pinchRatio.toFixed(2)})`}`);
  parts.push(r.guardrailBusy ? 'guardrail checking...' : `guardrail ${r.guardrail ?? '-'}`);
  parts.push(`spec ${r.specSource}`);
  if (r.ghostOn) parts.push(r.ghostErrorMm === null ? 'ghost err waiting' : `ghost err ${r.ghostErrorMm.toFixed(1)} mm`);
  return parts.join(' · ');
}

function actText(r: LoopReading): string {
  if (r.stopped) return `ARM STOPPED${r.stopWhy ? ` (${r.stopWhy})` : ''} · jaw held ${r.jaw}`;
  const arm = r.handLost ? 'arm holding (hand lost)' : r.gripperSpeedMmS >= MOVING_MM_S ? `arm moving ${r.gripperSpeedMmS.toFixed(0)} mm/s` : 'arm still';
  const parts = [arm, `jaw ${r.jaw}${r.jawMoving ? ' (moving)' : ''}`];
  if (r.delayed) parts.push('seen 1.28 s late');
  const said = r.voiceMuted ? 'caption (muted)' : 'speaking';
  parts.push(r.speaking ? `${said}${r.lastLine ? `: "${r.lastLine}"` : ''}` : 'voice quiet');
  return parts.join(' · ');
}

/**
 * The three stages for one reading. pinchChangedRecently comes from the caller, which
 * keeps the time of the last pinch change.
 */
export function stageViews(r: LoopReading, pinchChangedRecently = false): Record<StageName, StageView> {
  return {
    sense: { active: r.handSeen, state: r.handLost ? 'holding' : 'normal', text: senseText(r) },
    understand: {
      active: pinchChangedRecently || r.guardrailBusy || (r.ghostOn && r.ghostErrorMm !== null),
      state: 'normal',
      text: understandText(r),
    },
    act: {
      active: !r.stopped && (r.gripperSpeedMmS >= MOVING_MM_S || r.jawMoving || r.speaking),
      state: r.stopped ? 'stopped' : r.handLost ? 'holding' : 'normal',
      text: actText(r),
    },
  };
}

const LABEL: Record<StageName, string> = { sense: 'SENSE', understand: 'UNDERSTAND', act: 'ACT' };
const HINT: Record<StageName, string> = {
  sense: 'What the input sees: camera rate and hand-model time',
  understand: 'What the software makes of it: pinch, the object guardrail, where specs come from, the ghost error',
  act: 'What the simulated arm does, and whether the console is speaking',
};

/** The strip's DOM. update() is cheap when nothing changed. */
export class LoopStrip {
  readonly element: HTMLElement;
  private readonly stages = new Map<StageName, { box: HTMLElement; value: HTMLElement }>();
  private lastPinch: string | null = null;
  private pinchChangedAt = -Infinity;
  last: Record<StageName, StageView> | null = null;

  constructor(parent: HTMLElement) {
    const strip = (this.element = document.createElement('section'));
    strip.id = 'loop-strip';
    strip.dataset.testid = 'loop-strip';
    strip.setAttribute('aria-label', 'Sense, understand, act');
    (['sense', 'understand', 'act'] as const).forEach((name, i) => {
      if (i > 0) {
        const arrow = document.createElement('span');
        arrow.className = 'arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '→';
        strip.appendChild(arrow);
      }
      const box = document.createElement('div');
      box.className = 'stage';
      box.dataset.stage = name;
      box.dataset.testid = `stage-${name}`;
      box.title = HINT[name];
      const label = document.createElement('div');
      label.className = 'name';
      label.textContent = LABEL[name];
      const value = document.createElement('div');
      value.className = 'value';
      box.append(label, value);
      strip.appendChild(box);
      this.stages.set(name, { box, value });
    });
    parent.appendChild(strip);
  }

  update(reading: LoopReading, nowMs: number): Record<StageName, StageView> {
    const pinch = reading.pinch;
    if (pinch !== this.lastPinch) {
      if (this.lastPinch !== null && pinch !== null) this.pinchChangedAt = nowMs;
      this.lastPinch = pinch;
    }
    const views = stageViews(reading, nowMs - this.pinchChangedAt < 800);
    for (const [name, view] of Object.entries(views) as [StageName, StageView][]) {
      const parts = this.stages.get(name)!;
      if (parts.value.textContent !== view.text) parts.value.textContent = view.text;
      parts.box.dataset.active = String(view.active);
      parts.box.dataset.state = view.state;
    }
    this.last = views;
    return views;
  }
}
