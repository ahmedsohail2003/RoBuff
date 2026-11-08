// The mission console (M7): one calm dark layout. The 3D viewport fills the left, the console
// column holds every panel on the right, and the Sense -> Understand -> Act strip runs along
// the top of the viewport. The panels keep their own logic in their own modules; this file
// only moves their roots into console slots as they appear, adds the strip, the first-run
// hint, the caption bar, the hand-lost freeze and stop frames, the G and M keys, and the
// starfield drift (zero when the system asks for reduced motion).

import '../styles.css';
import type { App } from '../app';
import type { DelayRig } from '../delay/dualSim';
import { GRIPPER_SITE } from '../sim/armXml';
import { GRAVITY_PRESETS, gravity } from '../sim/gravity';
import { objectBrain } from '../objects/objectBrain';
import { consoleVoice } from '../voice/speak';
import { handBanner } from './states';
import { LoopStrip, type LoopReading, type StageName, type StageView } from './loopStrip';

/** Starfield drift about the vertical, radians per wall second. 0 under reduced motion. */
export const STAR_DRIFT_RAD_S = 0.01;
const HINT_KEY = 'aftergrip-first-run-hint-seen';
const CAPTION_SHOW_MS = 6000;
const SPEAKING_WINDOW_MS = 4000;

export const HINT_LINES = [
  'Move your hand (or the mouse) over the camera view to steer; pinch thumb and index finger to grip.',
  'Space stops the arm at once and holds every joint and the jaw; only the Resume button clears it.',
  'G changes gravity, M changes mode (Direct, Moon), hold V to talk. Everything here is a simulation.',
] as const;

/** Panel roots made by other modules, and the console slot each one goes into. */
const SLOTTED: Record<string, string> = {
  'left-stack': 'slot-mode',
  'object-panel': 'slot-objects',
  'gravity-menu': 'slot-gravity',
  'voice-panel': 'slot-voice',
  'stop-gesture': 'slot-safety',
};

export interface ConsoleState {
  reducedMotion: boolean;
  starDriftRadS: number;
  starRotation: number | null;
  strip: Record<StageName, StageView> | null;
  slotted: Record<string, boolean>;
  hintShown: boolean;
  frozen: boolean;
  caption: string | null;
}

export interface ConsoleHook {
  consoleState(): ConsoleState;
}

declare module '../test-hooks' {
  interface SimHook extends Partial<ConsoleHook> {}
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as { tagName?: string; isContentEditable?: boolean } | null;
  const tag = element?.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element?.isContentEditable === true;
}

function hintSeen(): boolean {
  if (new URLSearchParams(location.search).get('hint') === '1') return false;
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

/** The one init call for M7. rig is the delay rig from mountDelay (null if it is not mounted). */
export function mountConsole(app: App, rig: DelayRig | null, withHooks: boolean): void {
  document.body.classList.add('console-layout');

  // The console column.
  const aside = el('aside', { id: 'console', 'aria-label': 'Mission console' });
  const header = el('header', { class: 'console-head' });
  const title = el('h1', {}, 'Robuff');
  title.appendChild(el('span', { class: 'sub' }, 'mission console · simulation'));
  const keys = el('p', { class: 'keys', 'data-testid': 'console-keys' });
  keys.innerHTML =
    '<kbd>Space</kbd> stop · <kbd>G</kbd> gravity · <kbd>M</kbd> mode · <kbd>V</kbd> hold to talk · <kbd>Tab</kbd> moves through controls, <kbd>Enter</kbd> presses one';
  const keysNote = el('p', { class: 'keys-note', 'data-testid': 'console-keys-note', hidden: '' }, 'Mouse input: G is the grip key, so change gravity in the menu.');
  const trial = new URLSearchParams(location.search).get('trial') === '1';
  const trialToggle = el('button', { type: 'button', id: 'trial-toggle', 'data-testid': 'trial-toggle', 'aria-pressed': String(trial) }, trial ? 'Trial mode on: leave' : 'Trial mode (logged trials)');
  trialToggle.title = 'Reloads the page with or without the trial HUD (?trial=1).';
  trialToggle.addEventListener('click', () => {
    const params = new URLSearchParams(location.search);
    if (trial) params.delete('trial');
    else params.set('trial', '1');
    location.search = params.toString();
  });
  header.append(title, keys, keysNote, trialToggle);
  aside.appendChild(header);

  let hintShown = false;
  if (!hintSeen()) {
    hintShown = true;
    const hint = el('section', { id: 'first-run-hint', 'aria-label': 'First run hint', 'data-testid': 'first-run-hint' });
    const list = el('ol');
    for (const line of HINT_LINES) list.appendChild(el('li', {}, line));
    const done = el('button', { type: 'button' }, 'Got it');
    done.addEventListener('click', () => {
      try {
        localStorage.setItem(HINT_KEY, '1');
      } catch {
        // Private mode: the hint just comes back next time.
      }
      hint.remove();
      hintShown = false;
    });
    hint.append(list, done);
    aside.appendChild(hint);
  }

  const slot = (id: string, heading: string | null): void => {
    const box = el('div', { id, class: 'slot' });
    if (heading) box.appendChild(el('h2', { class: 'slot-head' }, heading));
    aside.appendChild(box);
  };
  slot('slot-mode', 'Mode: Earth-Moon delay');
  slot('slot-objects', null);
  slot('slot-gravity', null);
  slot('slot-voice', null);
  slot('slot-safety', null);
  document.body.appendChild(aside);

  // The strip and the caption bar sit over the viewport.
  const strip = new LoopStrip(document.body);
  const captionBar = el('div', { id: 'caption-bar', 'data-testid': 'caption-bar', 'aria-live': 'polite', hidden: '' });
  document.body.appendChild(captionBar);

  // Move panel roots into their slots now and whenever a module adds one later.
  const slotted: Record<string, boolean> = {};
  const adopt = (): void => {
    for (const [id, slotId] of Object.entries(SLOTTED)) {
      const node = document.getElementById(id);
      const target = document.getElementById(slotId);
      if (node && target && node.parentElement !== target) target.appendChild(node);
      slotted[id] = !!node && node.parentElement === target;
    }
  };
  adopt();
  new MutationObserver(adopt).observe(document.body, { childList: true });
  // The viewport only resizes on window resize; it is narrower now.
  window.dispatchEvent(new Event('resize'));

  // Captions: the latest console line, at the bottom of the viewport.
  let captionText: string | null = null;
  let captionAt = -Infinity;
  consoleVoice.onCaption((caption) => {
    captionText = caption.text;
    captionAt = performance.now();
    captionBar.textContent = caption.text;
    captionBar.hidden = false;
  });

  // G cycles gravity (not while the mouse is the input: there G is the grip), M cycles mode.
  window.addEventListener('keydown', (event) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === 'g' && app.loop.source?.kind !== 'mouse') {
      const index = GRAVITY_PRESETS.findIndex((p) => p.id === gravity.current.id);
      gravity.set(GRAVITY_PRESETS[(index + 1) % GRAVITY_PRESETS.length]!.id);
    } else if (key === 'm') {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('#delay-panel [data-delay-mode]')];
      if (buttons.length === 0 || buttons.some((b) => b.disabled)) return;
      const index = buttons.findIndex((b) => b.getAttribute('aria-pressed') === 'true');
      buttons[(index + 1) % buttons.length]!.click();
    }
  });

  // Starfield drift, off under reduced motion.
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const stars = app.viewport.scene.getObjectByName('starfield') ?? null;
  const drift = (): number => (motionQuery.matches ? 0 : STAR_DRIFT_RAD_S);

  // Readings for the strip.
  let lastStripMs = -Infinity;
  let lastFrameMs: number | null = null;
  let camWindow = { t: performance.now(), frames: 0 };
  let cameraFps: number | null = null;
  let lastGripper: { t: number; p: [number, number, number] } | null = null;
  let gripperSpeed = 0;
  let lastGrip: number | null = null;
  let jawMoving = false;
  let frozen = false;

  const reading = (now: number): LoopReading => {
    const source = app.loop.source;
    const info = source?.describe() ?? {};
    const hand = app.loop.lastHand;
    if (source?.kind === 'webcam') {
      const frames = typeof info.videoFrames === 'number' ? info.videoFrames : 0;
      if (now - camWindow.t >= 1000) {
        cameraFps = ((frames - camWindow.frames) * 1000) / (now - camWindow.t);
        camWindow = { t: now, frames };
      }
    } else {
      cameraFps = null;
    }
    const sim = app.sim;
    const p = sim.getSitePos(GRIPPER_SITE);
    if (p && lastGripper && sim.time > lastGripper.t) {
      const dt = sim.time - lastGripper.t;
      gripperSpeed = (Math.hypot(p[0] - lastGripper.p[0], p[1] - lastGripper.p[1], p[2] - lastGripper.p[2]) / dt) * 1000;
    } else if (p && lastGripper && sim.time < lastGripper.t) {
      gripperSpeed = 0;
    }
    if (p && (!lastGripper || sim.time !== lastGripper.t)) lastGripper = { t: sim.time, p: [p[0], p[1], p[2]] };
    const grip = app.loop.controller.status().appliedGrip;
    jawMoving = grip !== null && lastGrip !== null && Math.abs(grip - lastGrip) > 1e-4;
    lastGrip = grip;
    const webcamState = source?.kind === 'webcam' ? String(info.state) : null;
    const banner = handBanner(source?.kind ?? null, webcamState, hand);
    const verdictEl = document.querySelector<HTMLElement>('[data-testid="object-verdict"]');
    const panel = document.getElementById('object-panel');
    const error = rig?.ghostOn ? rig.error() : null;
    const synthSpeaking = typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking;
    const recent = now - captionAt < SPEAKING_WINDOW_MS;
    const line = captionText && captionText.length > 48 ? `${captionText.slice(0, 46)}…` : captionText;
    return {
      input: source?.kind ?? null,
      cameraFps,
      trackingMs: source?.kind === 'webcam' && typeof info.medianInferenceMs === 'number' ? info.medianInferenceMs : null,
      webcamState,
      handSeen: !!hand && hand.confidence >= 0.5,
      handLost: banner === 'hand lost, arm holding',
      pinch: hand ? (hand.pinch >= 0.5 ? 'closed' : 'open') : null,
      pinchRatio: hand?.pinchRatio ?? null,
      guardrail: verdictEl?.dataset.verdict ?? null,
      guardrailBusy: panel?.dataset.busy === 'true',
      specSource: objectBrain.live ? 'Gemini 3.8 Flash (live)' : 'offline mock (no key)',
      ghostErrorMm: error ? error.gripper_mm : null,
      ghostLevel: error ? error.level : null,
      ghostOn: rig?.ghostOn ?? false,
      delayed: rig?.moon ?? false,
      stopped: app.loop.stopLatch?.stopped ?? false,
      stopWhy: app.loop.stopLatch?.why ?? null,
      gripperSpeedMmS: gripperSpeed,
      jaw: grip !== null && grip >= 0.5 ? 'closed' : 'open',
      jawMoving,
      speaking: synthSpeaking || recent,
      lastLine: synthSpeaking || recent ? line : null,
      voiceMuted: consoleVoice.muted,
    };
  };

  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    const dt = lastFrameMs === null ? 0 : Math.min(100, now - lastFrameMs) / 1000;
    lastFrameMs = now;
    if (stars) stars.rotation.z += drift() * dt;
    if (now - lastStripMs < 100) return;
    lastStripMs = now;
    const r = reading(now);
    strip.update(r, now);
    frozen = r.handLost;
    document.body.classList.toggle('hand-lost', r.handLost);
    document.body.classList.toggle('arm-stopped', r.stopped);
    document.body.classList.toggle('delayed', r.delayed);
    keysNote.hidden = r.input !== 'mouse';
    if (!captionBar.hidden && now - captionAt > CAPTION_SHOW_MS) captionBar.hidden = true;
  };
  requestAnimationFrame(frame);

  if (withHooks && window.__sim) {
    const hooks: ConsoleHook = {
      consoleState: () => ({
        reducedMotion: motionQuery.matches,
        starDriftRadS: drift(),
        starRotation: stars ? stars.rotation.z : null,
        strip: strip.last,
        slotted: { ...slotted },
        hintShown,
        frozen,
        caption: captionBar.hidden ? null : captionBar.textContent,
      }),
    };
    Object.defineProperties(window.__sim, Object.getOwnPropertyDescriptors(hooks));
  }
}
