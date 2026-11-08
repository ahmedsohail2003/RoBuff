// The voice console: hold-to-talk (button or the V key) with the browser's speech recognition
// when it has one, a text box always, the offline grammar, and the captions. The grammar runs
// first and in the browser, so "stop" never waits on the network. Only lines the grammar does
// not know go to Gemini, and only when the key server says Gemini is live.
// Safety: voice and Gemini can set the stop latch but can never clear it; only the Resume
// button does. While stopped, voice commands that would move the arm are refused.

import type { App } from '../app';
import { runDrop, runPick, runPlace, planPick, DROP_NO_CONTACT_S, type Holding, type MacroWorld } from '../control/armMacro';
import { currentGrip } from '../control/grip';
import { directionVector, directionWords, moveDuration, planMove, sayCm } from '../control/voiceMotion';
import { DelayedSource, operatorSource, setOperatorSource } from '../delay/dualSim';
import { sayGravityValue } from '../objects/format';
import { objectBrain, type ObjectBrain } from '../objects/objectBrain';
import { GRIPPER_SITE } from '../sim/armXml';
import { gravity, setGravity, type GravityPreset } from '../sim/gravity';
import { jawAngleForGapScratch, jawContacts, liveObject, slotBodyName } from '../sim/liveObject';
import type { Mujoco } from '../sim/mujocoRuntime';
import { JAW_ACTUATOR, type Vec3 } from '../sim/simulation';
import { trialBusy } from '../trials/runner';
import { VoiceSource } from '../input/voiceSource';
import { HELP_LINE, parseCommand, VOICE_PLACEHOLDER, type VoiceAction } from './grammar';
import { LIVE_BADGE, UNSUPPORTED_NOTE, warmAudioOutput, type LiveListener, type LiveState } from './liveTalk';
import { consoleVoice, type Caption, type ConsoleVoice } from './speak';

export type ToggleName = 'delay' | 'ghost';
/** A feature that voice can switch: returns the line to say. */
export type VoiceToggle = (on: boolean) => string;

const toggles = new Map<ToggleName, VoiceToggle>();

/** The delay mode (M4) registers its delay and ghost switches here. */
export function registerVoiceToggle(name: ToggleName, toggle: VoiceToggle): () => void {
  toggles.set(name, toggle);
  return () => {
    if (toggles.get(name) === toggle) toggles.delete(name);
  };
}

export interface CommandResult {
  text: string;
  action: VoiceAction;
  /** Who decided: the offline grammar, or Gemini for a line the grammar did not know. */
  by: 'grammar' | 'gemini';
  /** What the console said back, if anything. */
  said: string | null;
  /** True when the command waited on the network. */
  network: boolean;
  /** Simulated time when the command was handled, and when the stop latch was set (stop only). */
  simTime: number;
  stoppedAt: number | null;
  /** performance.now() when the command was handled, and when the stop latch was set (stop only). */
  atMs: number;
  stoppedAtMs: number | null;
  /** For a voice move: where it started and ended (world m), and whether the reach box shortened it. */
  motion?: { from: Vec3; goal: Vec3; clamped: boolean; outcome: string } | null;
}

/** What is in the object slot, as the object panel registers it (lane S) or as the scene shows it. */
export interface SlotOccupant {
  name: string;
  kind: string;
  partNames: string[];
  bodyName: string;
  busy: boolean;
  proven: boolean;
}

/** The skin and slot registry the object panel fills in. Until it does, voice says skins are not ready. */
interface SkinRegistry {
  currentObject?: () => SlotOccupant | null;
  skinObject?: (text: string, part?: string | null) => Promise<string>;
  clearSkin?: (part?: string | null) => Promise<string>;
}

const STOPPED_LINE = 'I am stopped. Voice cannot clear a stop: press Resume on screen.';
export const MOON_PICK_LINE = 'In the Moon modes I take moves, grip and home; switch to Direct for a pick.';
const TRIAL_LINE = 'A logged trial is running, so voice does not move the arm. It is yours after the trial.';
const REACH_LINE = 'That is as far as I can reach.';
/** Words that mean whatever is in the slot. */
const ANY_OBJECT = /^(?:it|object|thing|cube|test cube|block|rock|box|one)$/;

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const STYLE = `
#voice-panel { position: fixed; left: 356px; bottom: 12px; width: 300px; z-index: 5; padding: 10px 12px;
  background: rgba(10, 14, 28, 0.94); color: #e6e9f2; border: 1px solid #2b3557; border-radius: 8px;
  font: 12px/1.4 system-ui, sans-serif; box-shadow: 0 4px 18px rgba(0,0,0,.35); }
#voice-panel h2 { font-size: 13px; margin: 0 0 6px; }
#voice-panel .badges { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
#voice-panel .badge { font-size: 10.5px; border-radius: 3px; padding: 1px 6px; background: #f2c14e; color: #1b1300; font-weight: 600; }
#voice-panel .badge[data-live="true"] { background: #7ee2a8; color: #062012; }
#voice-panel .badge.mic { background: #2a3870; color: #e6e9f2; font-weight: 500; }
#voice-panel form { display: flex; gap: 6px; }
#voice-panel input { flex: 1; min-width: 0; font: inherit; padding: 5px 7px; border-radius: 4px; border: 1px solid #3a466e; background: #121a33; color: inherit; }
#voice-panel button { font: inherit; color: inherit; background: #1d2850; border: 1px solid #3a466e; border-radius: 4px; padding: 4px 8px; cursor: pointer; }
#voice-panel button.talk { width: 100%; margin-bottom: 6px; padding: 6px; }
#voice-panel button.talk[data-held="true"] { background: #7a2a2a; border-color: #ff8a80; }
#voice-panel .talk-row { display: flex; gap: 6px; margin-bottom: 6px; }
#voice-panel .talk-row button { flex: 1 1 0; min-width: 0; margin: 0; padding: 6px; }
#voice-panel button.live[aria-pressed="true"] { background: #173d2a; border-color: #7ee2a8; }
#voice-panel button.live[data-state="paused"] { background: #3a3015; border-color: #f2c14e; }
#voice-panel button:focus-visible { outline: 2px solid #8fb4ff; outline-offset: 2px; }
#voice-panel .live .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; background: #5d6788; }
#voice-panel .live[data-state="listening"] .dot { background: #7ee2a8; animation: live-pulse 1.2s ease-in-out infinite; }
#voice-panel .live[data-state="paused"] .dot { background: #f2c14e; }
@keyframes live-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.65); } }
@media (prefers-reduced-motion: reduce) { #voice-panel .live .dot { animation: none !important; } }
#voice-panel .live-note { color: #aab3cc; font-size: 11px; margin: -2px 0 6px; }
#voice-panel .live-note:empty { display: none; }
#voice-panel .caption { margin-top: 8px; min-height: 2.8em; font-size: 13px; }
#voice-panel .caption .via { color: #8890a8; font-size: 10.5px; margin-left: 4px; }
#voice-panel .heard { color: #aab3cc; font-size: 11px; margin-top: 4px; }
#voice-panel .hand-back[hidden] { display: none; }
#voice-panel .hand-back { margin-top: 6px; width: 100%; }
`;

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

export class VoiceConsole {
  readonly root: HTMLElement;
  readonly results: CommandResult[] = [];
  private readonly brainBadge: HTMLElement;
  private readonly voiceBadge: HTMLElement;
  private readonly micBadge: HTMLElement;
  private readonly liveBadge: HTMLElement;
  private readonly liveButton: HTMLButtonElement;
  private readonly liveLabel: HTMLElement;
  private readonly liveNote: HTMLElement;
  private live: LiveListener | null = null;
  /** The last object asked for by voice or live talk (sent to the chat route as state). */
  lastObject: string | null = null;
  private readonly caption: HTMLElement;
  private readonly heard: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly talk: HTMLButtonElement;
  private readonly handBack: HTMLButtonElement;
  private readonly home: Vec3 | null;
  /** What voice picked up and still holds, or null. */
  holding: Holding | null = null;
  /** Live talk sets this: typed and held lines the grammar does not know go to the same chat brain. */
  chatLine: ((text: string) => Promise<unknown>) | null = null;
  private macroBusy = false;
  private lastJawContactT: number | null = null;
  private lastDropCheckT = -Infinity;
  private recognition: RecognitionLike | null = null;
  private listening = false;

  constructor(
    parent: HTMLElement,
    private readonly app: App,
    private readonly brain: ObjectBrain = objectBrain,
    private readonly voice: ConsoleVoice = consoleVoice,
    private readonly mujoco: Mujoco | null = null,
  ) {
    if (!document.getElementById('voice-panel-style')) document.head.appendChild(el('style', { id: 'voice-panel-style' }, STYLE));
    // Where the gripper is at the keyframe pose, before any input moves it.
    this.home = app.sim.getSitePos(GRIPPER_SITE);
    this.root = el('section', { id: 'voice-panel', 'aria-label': 'Voice' });
    this.root.appendChild(el('h2', {}, 'Voice and commands'));
    const badges = el('div', { class: 'badges' });
    this.brainBadge = el('span', { class: 'badge', 'data-testid': 'brain-badge' });
    this.voiceBadge = el('span', { class: 'badge', 'data-testid': 'voice-badge' });
    const Ctor = recognitionCtor();
    this.micBadge = el(
      'span',
      { class: 'badge mic', 'data-testid': 'mic-badge', title: Ctor ? "The browser's speech recognition sends audio to its speech service: it needs the network." : '' },
      Ctor ? 'speech-to-text: browser (needs network)' : 'speech-to-text: not in this browser, type instead',
    );
    this.liveBadge = el('span', { class: 'badge', 'data-testid': 'live-badge' });
    badges.append(this.brainBadge, this.voiceBadge, this.micBadge, this.liveBadge);
    this.root.appendChild(badges);

    this.talk = el('button', { type: 'button', class: 'talk', 'data-testid': 'voice-talk', 'aria-label': 'Hold to talk (or hold V)' }, 'Hold to talk (or hold V)');
    this.talk.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.startListening();
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel'] as const) this.talk.addEventListener(type, () => this.stopListening());
    // Talk live: a toggle (Enter or a click), hands-free until pressed again.
    this.liveButton = el('button', {
      type: 'button',
      class: 'live',
      'data-testid': 'voice-live',
      'aria-pressed': 'false',
      'data-state': Ctor ? 'off' : 'unsupported',
      title: Ctor ? 'Hands-free: RoBuff listens until you press this again, and pauses while it speaks.' : UNSUPPORTED_NOTE,
    });
    this.liveLabel = el('span', { class: 'label' }, Ctor ? 'Talk live' : 'Talk live (not in this browser)');
    this.liveButton.append(el('span', { class: 'dot', 'aria-hidden': 'true' }), this.liveLabel);
    this.liveButton.addEventListener('click', () => this.toggleLive());
    const row = el('div', { class: 'talk-row' });
    row.append(this.talk, this.liveButton);
    this.liveNote = el('div', { class: 'live-note', 'data-testid': 'live-note', 'aria-live': 'polite' });
    this.root.append(row, this.liveNote);

    const form = el('form');
    this.input = el('input', { type: 'text', placeholder: VOICE_PLACEHOLDER, 'aria-label': 'Type a command', 'data-testid': 'voice-text' });
    // Keys typed here must not steer the arm (the mouse source listens for W, S and G).
    this.input.addEventListener('keydown', (event) => event.stopPropagation());
    form.append(this.input, el('button', { type: 'submit', 'data-testid': 'voice-send' }, 'Send'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.input.value.trim();
      this.input.value = '';
      if (text) void this.command(text);
    });
    this.root.appendChild(form);

    this.heard = el('div', { class: 'heard', 'data-testid': 'voice-heard' });
    this.caption = el('div', { class: 'caption', 'data-testid': 'caption', 'aria-live': 'polite' });
    this.handBack = el('button', { type: 'button', class: 'hand-back', 'data-testid': 'hand-back', hidden: '' }, 'Give the arm back to the hand');
    this.handBack.addEventListener('click', () => void this.giveBack());
    this.root.append(this.heard, this.caption, this.handBack);
    parent.appendChild(this.root);

    window.addEventListener('keydown', (event) => {
      if ((event.key === 'v' || event.key === 'V') && !event.repeat && !isTyping(event.target)) this.startListening();
    });
    window.addEventListener('keyup', (event) => {
      if (event.key === 'v' || event.key === 'V') this.stopListening();
    });

    voice.onCaption((caption) => this.showCaption(caption));
    brain.onChange(() => this.showBadges());
    this.showBadges();
    gravity.onChange((preset) => this.sayGravity(preset));
  }

  showBadges(): void {
    this.brainBadge.textContent = this.brain.badge();
    this.brainBadge.dataset.live = String(this.brain.live);
    this.voice.live = this.brain.health.reachable && this.brain.health.elevenlabs === 'configured';
    this.voiceBadge.textContent = this.voice.badge();
    this.voiceBadge.dataset.live = String(this.voice.live);
    this.liveBadge.textContent = this.brain.live ? LIVE_BADGE.live : LIVE_BADGE.offline;
    this.liveBadge.dataset.live = String(this.brain.live);
  }

  /** Live talk hands its ears to the panel once it is built. */
  attachLive(live: LiveListener): void {
    this.live = live;
    this.showLive(live.state, live.note);
  }

  /** The Talk live button's label, dot and note for a live-talk state. */
  showLive(state: LiveState, note: string | null): void {
    const label = { off: 'Talk live', listening: 'Live: listening...', paused: 'Live: paused while RoBuff speaks', unsupported: 'Talk live (not in this browser)' }[state];
    this.liveLabel.textContent = label;
    this.liveButton.dataset.state = state;
    const on = state === 'listening' || state === 'paused';
    this.liveButton.setAttribute('aria-pressed', String(on));
    this.liveButton.setAttribute('aria-label', on ? `${label} Press to turn live talk off.` : label);
    this.liveNote.textContent = note ?? '';
  }

  private toggleLive(): void {
    if (!this.live) {
      this.liveNote.textContent = 'Live talk is still loading.';
      return;
    }
    if (!this.live.supported) {
      this.showLive('unsupported', UNSUPPORTED_NOTE);
      this.input.focus();
      return;
    }
    // Turning on from a click: start the audio output now, so the first reply is not held up by it.
    if (!this.live.on) warmAudioOutput(this.voice.muted);
    this.live.toggle();
  }

  /** Runs one already-parsed action through the same handlers as a typed or held line, and records it. */
  async runParsed(text: string, action: VoiceAction, by: CommandResult['by'] = 'grammar', network = false): Promise<CommandResult> {
    this.heard.textContent = `Heard: "${text}"`;
    const result: CommandResult = { text, action, by, said: null, network, simTime: this.app.sim.time, stoppedAt: null, atMs: performance.now(), stoppedAtMs: null };
    this.results.push(result);
    result.said = await this.run(action, result);
    return result;
  }

  /** One spoken or typed line, end to end. */
  async command(text: string): Promise<CommandResult> {
    const action = parseCommand(text);
    this.heard.textContent = `Heard: "${text}"`;
    const result: CommandResult = { text, action, by: 'grammar', said: null, network: false, simTime: this.app.sim.time, stoppedAt: null, atMs: performance.now(), stoppedAtMs: null };
    this.results.push(result);
    if (action.type === 'unknown' && this.brain.live && this.chatLine) {
      // The same chat brain Talk live uses: it can move, grip, pick, place and skin, not just spawn.
      result.network = true;
      result.by = 'gemini';
      await this.chatLine(text);
      result.said = this.voice.captions[this.voice.captions.length - 1]?.text ?? null;
      return result;
    }
    if (action.type === 'unknown' && this.brain.live) {
      result.network = true;
      try {
        const answer = await this.brain.ask(text);
        result.by = 'gemini';
        if (answer.intent === 'spawn') result.action = { type: 'object', text };
        else if (answer.intent === 'set_gravity' && answer.gravity) result.action = { type: 'gravity', id: answer.gravity };
        else if (answer.intent === 'home') result.action = { type: 'home' };
        else if (answer.intent === 'help') result.action = { type: 'help' };
      } catch {
        // Gemini failed: fall through as unknown.
      }
    }
    result.said = await this.run(result.action, result);
    return result;
  }

  private async run(action: VoiceAction, result: CommandResult): Promise<string | null> {
    const latch = this.app.loop.stopLatch;
    const stopped = latch?.stopped === true;
    switch (action.type) {
      case 'stop': {
        if (!latch) return this.say('There is no stop latch in this build.', 'info');
        latch.stop('voice', this.app.sim.time);
        result.stoppedAt = latch.since;
        result.stoppedAtMs = performance.now();
        return this.say('Stopped. The arm holds where it is. Press Resume on screen to go on.', 'stop', { fixed: true, interrupt: true });
      }
      case 'resume':
        return this.say(stopped ? STOPPED_LINE : 'I am not stopped.', 'info', { fixed: true });
      case 'home': {
        if (stopped) return this.say(STOPPED_LINE, 'refusal', { fixed: true });
        if (trialBusy()) return this.say(TRIAL_LINE, 'refusal', { fixed: true });
        if (!this.home) return this.say('I do not know where home is in this scene.', 'info');
        const voice = this.takeVoice();
        const from = voice.endGoal();
        const said = this.say('Going home.', 'info', { fixed: true });
        const outcome = await voice.moveTo(this.home, moveDuration(Math.hypot(this.home[0] - from[0], this.home[1] - from[1], this.home[2] - from[2])), 'going home');
        result.motion = { from, goal: [...this.home] as Vec3, clamped: false, outcome };
        return said;
      }
      case 'grip': {
        if (stopped) return this.say(STOPPED_LINE, 'refusal', { fixed: true });
        if (trialBusy()) return this.say(TRIAL_LINE, 'refusal', { fixed: true });
        if (action.open && this.holding && !this.inMoon()) return this.runMacro('drop', result);
        const voice = this.takeVoice();
        const said = this.say(action.open ? 'Opening the jaw.' : 'Closing the jaw.', 'info', { fixed: true });
        if (action.open) this.holding = null;
        await voice.setGrip(action.open ? 0 : 1, action.open ? 'opening the jaw' : 'closing the jaw');
        return said;
      }
      case 'move':
        return this.move(action, result, stopped);
      case 'pick':
      case 'place':
        return this.runMacro(action.type, result, action.type === 'pick' ? action.target : null);
      case 'handBack':
        return this.giveBack();
      case 'skin':
      case 'unskin': {
        const registry = this.brain as ObjectBrain & SkinRegistry;
        const paint = registry.skinObject;
        const clear = registry.clearSkin;
        if (action.type === 'skin' ? !paint : !clear) return this.say('Skins are not ready yet.', 'info', { fixed: true });
        const occupant = this.occupant();
        // "paint the tesla red" means the whole Tesla: only a real part name is a part.
        const asked = action.part;
        const part = asked && occupant && !occupant.partNames.some((p) => p.toLowerCase().includes(asked.replace(/s$/, ''))) && this.namesObject(asked, occupant) ? null : asked;
        try {
          const line = action.type === 'skin' ? await paint!(action.look, part) : await clear!(part);
          return this.say(line, 'info');
        } catch (error) {
          return this.say(`The skin did not work: ${error instanceof Error ? error.message : String(error)}`, 'info');
        }
      }
      case 'gravity':
        // The gravity listener says the line, for the menu and for voice alike.
        setGravity(action.id);
        return this.voice.captions[this.voice.captions.length - 1]?.text ?? null;
      case 'delay':
      case 'ghost': {
        const toggle = toggles.get(action.type);
        if (!toggle) return this.say(`${action.type === 'delay' ? 'The Moon delay' : 'The ghost arm'} is not built in this version yet.`, 'info', { fixed: true });
        return this.say(toggle(action.on), 'info');
      }
      case 'help':
        return this.say(HELP_LINE, 'info', { fixed: true });
      case 'object': {
        const request = this.brain.requestObject;
        if (!request) return this.say('The object fabricator is still loading. Try again in a moment.', 'info');
        this.lastObject = action.text;
        // The object panel speaks the receipt when the request finishes.
        await request(action.text);
        return this.voice.captions[this.voice.captions.length - 1]?.text ?? null;
      }
      case 'unknown':
        return this.say(
          this.brain.live ? 'I did not understand that. Say help for the commands.' : 'I did not understand that. Offline I know a short list: say help.',
          'info',
          { fixed: true },
        );
    }
  }

  private say(text: string, kind: Parameters<ConsoleVoice['say']>[1], options: Parameters<ConsoleVoice['say']>[2] = {}): string {
    this.voice.say(text, kind, options);
    return text;
  }

  private sayGravity(preset: GravityPreset): void {
    const value = preset.value === 0 ? 'zero' : `${sayGravityValue(preset.value)} metres per second squared`;
    this.voice.say(`Gravity set to ${preset.label}: ${value}, simulated.`, 'gravity', { fixed: true });
  }

  /** The voice source in the operator's seat, or null when the hand or mouse has the arm. */
  voiceSource(): VoiceSource | null {
    const seat = operatorSource(this.app.loop);
    return seat instanceof VoiceSource && seat.state !== 'handed-back' ? seat : null;
  }

  /**
   * Voice takes the operator's seat (inside the Moon delay wrapper when there is one), parking
   * the hand or mouse source to give back later. So voice moves, grip and home are delayed and
   * ghosted in the Moon modes exactly like the hand.
   */
  private takeVoice(): VoiceSource {
    const existing = this.voiceSource();
    if (existing) return existing;
    const seat = operatorSource(this.app.loop);
    const parked = seat instanceof VoiceSource ? seat.parked : seat;
    const voice: VoiceSource = new VoiceSource(this.app.loop, {
      parked,
      onHandBack: (back) => {
        if (operatorSource(this.app.loop) === voice) setOperatorSource(this.app.loop, back);
        this.showHandBack();
        this.say('The arm is yours again.', 'info', { fixed: true });
      },
      onTick: (t) => this.watchDrop(t),
    });
    setOperatorSource(this.app.loop, voice);
    this.showHandBack();
    return voice;
  }

  private showHandBack(): void {
    const voice = this.voiceSource();
    this.handBack.hidden = !voice;
    if (voice) {
      const kind = voice.parked?.kind;
      this.handBack.textContent = `Give the arm back to the ${kind === 'webcam' ? 'hand' : (kind ?? 'hand')}`;
    }
  }

  /** "hand control" and the button: glide to the hand's target, keep the grip until the hand agrees, then hand over. */
  private giveBack(): string {
    const voice = this.voiceSource();
    if (!voice) {
      this.showHandBack();
      return this.say('The hand already has the arm.', 'info', { fixed: true });
    }
    if (!voice.parked) {
      setOperatorSource(this.app.loop, null);
      this.showHandBack();
      return this.say('There was no hand or mouse to give it to, so the arm just holds.', 'info', { fixed: true });
    }
    voice.handBack(this.holding !== null);
    return this.say(this.holding ? 'Handing the arm back. I keep the grip until your hand closes too.' : 'Handing the arm back. It glides to your hand.', 'info', { fixed: true });
  }

  private inMoon(): boolean {
    return this.app.loop.source instanceof DelayedSource;
  }

  /** What is in the slot: the panel's registry when it has one, else the body in the scene. */
  occupant(): SlotOccupant | null {
    const registry = this.brain as ObjectBrain & SkinRegistry;
    const current = registry.currentObject?.();
    if (current) return current;
    if (!this.mujoco) return null;
    const body = slotBodyName(this.mujoco, this.app.sim);
    if (!body) return null;
    const kind = body === 'cube' ? 'cube' : body.replace(/^slot_/, '');
    return { name: body === 'cube' ? 'test cube' : kind.replace(/_/g, ' '), kind, partNames: [], bodyName: body, busy: false, proven: true };
  }

  private namesObject(target: string, occupant: SlotOccupant): boolean {
    const t = target.toLowerCase().replace(/^(?:the|a|an)\s+/, '').trim();
    if (ANY_OBJECT.test(t) && (occupant.bodyName === 'cube' || t === 'it' || t === 'object' || t === 'thing' || t === 'one')) return true;
    const name = `${occupant.name} ${occupant.kind}`.toLowerCase().replace(/_/g, ' ');
    return t.split(' ').every((word) => name.includes(word.replace(/s$/, '')));
  }

  private async move(action: Extract<VoiceAction, { type: 'move' }>, result: CommandResult, stopped: boolean): Promise<string> {
    if (stopped) return this.say(STOPPED_LINE, 'refusal', { fixed: true });
    if (trialBusy()) return this.say(TRIAL_LINE, 'refusal', { fixed: true });
    if (action.cm > 30) return this.say('That is more than 30 centimetres. I move at most 30 at a time.', 'refusal', { fixed: true });
    if (action.cm < 0.5) return this.say('That is under half a centimetre, too small to move.', 'refusal', { fixed: true });
    const voice = this.takeVoice();
    const from = voice.endGoal();
    const unit = directionVector(action.direction, this.app.viewport.azimuth, from);
    const metres = action.cm / 100;
    const plan = planMove(from, [unit[0] * metres, unit[1] * metres, unit[2] * metres]);
    result.motion = { from, goal: plan.goal, clamped: plan.clamped, outcome: 'refused' };
    if (plan.distance < 0.002) return this.say(REACH_LINE, 'info', { fixed: true });
    const said = this.say(`Moving ${directionWords(action.direction)} ${sayCm(action.cm)}.`, 'info', { fixed: true });
    const outcome = await voice.moveTo(plan.goal, plan.durationS, `moving ${directionWords(action.direction)} ${sayCm(action.cm)}`);
    voice.clamped = plan.clamped;
    result.motion.outcome = outcome;
    if (outcome === 'done' && plan.clamped) return this.say(`${REACH_LINE} I moved ${sayCm(plan.distance * 100)}.`, 'info', { fixed: true });
    return said;
  }

  /** Pick, place and drop: the lift test's grasp on the live object, checked with MuJoCo's contacts. */
  private async runMacro(kind: 'pick' | 'place' | 'drop', result: CommandResult, target: string | null = null): Promise<string> {
    if (this.app.loop.stopLatch?.stopped) return this.say(STOPPED_LINE, 'refusal', { fixed: true });
    if (trialBusy()) return this.say(TRIAL_LINE, 'refusal', { fixed: true });
    if (this.inMoon()) return this.say(MOON_PICK_LINE, 'refusal', { fixed: true });
    if (this.macroBusy) return this.say('I am still busy with the last one.', 'refusal', { fixed: true });
    const occupant = this.occupant();
    const mujoco = this.mujoco;
    if (!occupant || !mujoco) return this.say('There is nothing to pick up here.', 'refusal', { fixed: true });
    if (occupant.busy) return this.say('Wait: the object is still being checked.', 'refusal', { fixed: true });
    if (kind !== 'pick' && !this.holding) return this.say('I am not holding anything.', 'refusal', { fixed: true });
    if (kind === 'pick') {
      if (this.holding) return this.say('I am already holding it. Say put it down or drop it.', 'refusal', { fixed: true });
      if (target && !this.namesObject(target, occupant)) {
        return this.say(`The slot has the ${occupant.name}, not a ${target}. Say pick it up for the ${occupant.name}, or ask me to make a ${target}.`, 'refusal');
      }
    }
    const body = occupant.bodyName;
    const voice = this.takeVoice();
    const world: MacroWorld = {
      run: (steps, label) => voice.runSteps(steps, label),
      read: () => liveObject(mujoco, this.app.sim, body),
      jaws: () => jawContacts(this.app.sim, body),
      grip: () => this.app.loop.controller.status().grip ?? currentGrip(this.app.sim, JAW_ACTUATOR),
      site: () => voice.endGoal(),
    };
    this.macroBusy = true;
    try {
      if (kind === 'pick') {
        const sim = this.app.sim;
        const [closed, open] = sim.jawRange();
        const plan = planPick(world.read(), { range: [closed, open], angleForGap: (gap) => jawAngleForGapScratch(mujoco, sim, gap) }, voice.endGoal());
        if (!plan.ok) return this.say(plan.refuse, 'refusal');
        this.say(occupant.bodyName === 'cube' ? 'Picking it up.' : `Picking up the ${occupant.name}.`, 'info', { fixed: true });
        const done = await runPick(world, plan);
        if (done.ok) {
          this.holding = done.holding;
          this.lastJawContactT = this.app.sim.time;
        }
        return this.say(done.line, done.ok ? 'info' : 'refusal');
      }
      const holding = this.holding!;
      this.say(kind === 'place' ? 'Putting it down.' : 'Dropping it.', 'info', { fixed: true });
      const done = kind === 'place' ? await runPlace(world, holding) : await runDrop(world);
      if (done.ok || !('cancelled' in done && done.cancelled)) this.holding = done.ok ? null : this.holding;
      return this.say(done.line, done.ok ? 'info' : 'refusal');
    } catch (error) {
      return this.say(`The ${kind} stopped: ${error instanceof Error ? error.message : String(error)}`, 'refusal');
    } finally {
      this.macroBusy = false;
      result.motion ??= { from: voice.goal, goal: voice.goal, clamped: false, outcome: kind };
    }
  }

  /** While voice holds something: no jaw contact for 0.1 s of simulated time means it slipped out. */
  private watchDrop(t: number): void {
    if (!this.holding || this.macroBusy || !this.mujoco || t - this.lastDropCheckT < 0.05) return;
    this.lastDropCheckT = t;
    let jaws: string[];
    try {
      jaws = jawContacts(this.app.sim, this.holding.body);
    } catch {
      this.holding = null;
      return;
    }
    if (jaws.length > 0 || this.lastJawContactT === null) {
      this.lastJawContactT = t;
      return;
    }
    if (t - this.lastJawContactT >= DROP_NO_CONTACT_S) {
      this.holding = null;
      this.lastJawContactT = null;
      this.say('I dropped it. Nothing is in the jaw now.', 'info', { fixed: true });
    }
  }

  private startListening(): void {
    if (this.listening) return;
    if (this.live?.on) {
      this.heard.textContent = 'Live talk is on: just speak. Press Talk live again to turn it off.';
      return;
    }
    const Ctor = recognitionCtor();
    if (!Ctor) {
      this.heard.textContent = 'Speech recognition is not in this browser: type the command.';
      this.input.focus();
      return;
    }
    this.listening = true;
    this.talk.dataset.held = 'true';
    this.talk.textContent = 'Listening... release to send';
    const recognition = (this.recognition = new Ctor());
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.continuous = true;
    let transcript = '';
    recognition.onresult = (event) => {
      transcript = Array.from(event.results)
        .map((r) => r[0]?.transcript ?? '')
        .join(' ')
        .trim();
      // A stop is acted on the moment it is heard, not on release.
      if (parseCommand(transcript).type === 'stop') void this.command(transcript);
    };
    recognition.onerror = (event) => {
      this.heard.textContent = `Speech recognition: ${event.error}. You can type the command.`;
    };
    recognition.onend = () => {
      this.resetTalk();
      if (transcript && parseCommand(transcript).type !== 'stop') void this.command(transcript);
      else if (!transcript) this.heard.textContent ||= 'Heard nothing.';
    };
    try {
      recognition.start();
    } catch (error) {
      this.heard.textContent = `Speech recognition would not start: ${error instanceof Error ? error.message : String(error)}`;
      this.resetTalk();
    }
  }

  private stopListening(): void {
    if (!this.listening) return;
    this.recognition?.stop();
  }

  private resetTalk(): void {
    this.listening = false;
    this.recognition = null;
    this.talk.dataset.held = 'false';
    this.talk.textContent = 'Hold to talk (or hold V)';
  }

  private showCaption(caption: Caption): void {
    // A line that finishes playing after a newer one was said must not cover it.
    if (caption !== this.voice.captions[this.voice.captions.length - 1]) return;
    const via = caption.via ? ` (${caption.via}${caption.error ? `; ${caption.error}` : ''})` : '';
    this.caption.replaceChildren(el('span', {}, caption.text), el('span', { class: 'via' }, via));
    this.caption.dataset.kind = caption.kind;
  }
}

export interface VoiceHook {
  /** Runs a line through the voice console as if typed. */
  voiceCommand(text: string): Promise<CommandResult>;
  voiceCaptions(): Caption[];
  /** Every command handled so far, typed, spoken or from voiceCommand. */
  voiceResults(): CommandResult[];
  voiceBadges(): { brain: string; voice: string; mic: string; live: string };
  /** Logged Gemini calls (live gate). */
  brainCalls(): ObjectBrain['calls'];
  /** The object in the slot as physics has it now, and whether voice holds it. */
  voiceObject(): { body: string; com: Vec3; lowest: number; jaws: string[]; holding: boolean } | null;
}

declare module '../test-hooks' {
  interface SimHook extends Partial<VoiceHook> {}
}

/** The one init call for M5: the voice console, the health check, and (dev and test builds) the hooks. */
export function mountVoice(app: App, withHooks: boolean, mujoco: Mujoco | null = null): VoiceConsole {
  const params = new URLSearchParams(location.search);
  consoleVoice.muted = params.get('mute') === '1';
  const panel = new VoiceConsole(document.body, app, objectBrain, consoleVoice, mujoco);
  void objectBrain.refresh();
  if (withHooks && window.__sim) {
    const hooks: VoiceHook = {
      voiceCommand: (text) => panel.command(text),
      voiceCaptions: () => consoleVoice.captions.map((c) => ({ ...c })),
      voiceResults: () => panel.results.map((r) => ({ ...r })),
      voiceBadges: () => ({
        brain: document.querySelector('[data-testid="brain-badge"]')?.textContent ?? '',
        voice: document.querySelector('[data-testid="voice-badge"]')?.textContent ?? '',
        mic: document.querySelector('[data-testid="mic-badge"]')?.textContent ?? '',
        live: document.querySelector('[data-testid="live-badge"]')?.textContent ?? '',
      }),
      brainCalls: () => objectBrain.calls.map((c) => ({ ...c })),
      voiceObject: () => {
        const occupant = panel.occupant();
        if (!occupant || !mujoco) return null;
        try {
          const obj = liveObject(mujoco, app.sim, occupant.bodyName);
          return { body: obj.body, com: obj.com, lowest: obj.lowest, jaws: jawContacts(app.sim, occupant.bodyName), holding: panel.holding !== null };
        } catch {
          return null;
        }
      },
    };
    Object.defineProperties(window.__sim, Object.getOwnPropertyDescriptors(hooks));
  }
  return panel;
}
