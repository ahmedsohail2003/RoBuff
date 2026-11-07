// The voice console: hold-to-talk (button or the V key) with the browser's speech recognition
// when it has one, a text box always, the offline grammar, and the captions. The grammar runs
// first and in the browser, so "stop" never waits on the network. Only lines the grammar does
// not know go to Gemini, and only when the key server says Gemini is live.
// Safety: voice and Gemini can set the stop latch but can never clear it; only the Resume
// button does. While stopped, voice commands that would move the arm are refused.

import type { App } from '../app';
import { sayGravityValue } from '../objects/format';
import { objectBrain, type ObjectBrain } from '../objects/objectBrain';
import { GRIPPER_SITE } from '../sim/armXml';
import { gravity, setGravity, type GravityPreset } from '../sim/gravity';
import type { Vec3 } from '../sim/simulation';
import type { InputSource } from '../input/handState';
import { HELP_LINE, parseCommand, type VoiceAction } from './grammar';
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
}

const STOPPED_LINE = 'I am stopped. Voice cannot clear a stop: press Resume on screen.';

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
  private readonly caption: HTMLElement;
  private readonly heard: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly talk: HTMLButtonElement;
  private readonly handBack: HTMLButtonElement;
  private readonly home: Vec3 | null;
  /** The hand (or mouse) source voice took the arm from, kept to give back. */
  private parked: InputSource | null = null;
  private recognition: RecognitionLike | null = null;
  private listening = false;

  constructor(
    parent: HTMLElement,
    private readonly app: App,
    private readonly brain: ObjectBrain = objectBrain,
    private readonly voice: ConsoleVoice = consoleVoice,
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
    badges.append(this.brainBadge, this.voiceBadge, this.micBadge);
    this.root.appendChild(badges);

    this.talk = el('button', { type: 'button', class: 'talk', 'data-testid': 'voice-talk', 'aria-label': 'Hold to talk (or hold V)' }, 'Hold to talk (or hold V)');
    this.talk.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.startListening();
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel'] as const) this.talk.addEventListener(type, () => this.stopListening());
    this.root.appendChild(this.talk);

    const form = el('form');
    this.input = el('input', { type: 'text', placeholder: 'Or type: stop, Moon, give me a comet ice shard', 'aria-label': 'Type a command', 'data-testid': 'voice-text' });
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
    this.handBack = el('button', { type: 'button', class: 'hand-back', hidden: '' }, 'Give the arm back to the hand');
    this.handBack.addEventListener('click', () => this.giveBack());
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
  }

  /** One spoken or typed line, end to end. */
  async command(text: string): Promise<CommandResult> {
    const action = parseCommand(text);
    this.heard.textContent = `Heard: "${text}"`;
    const result: CommandResult = { text, action, by: 'grammar', said: null, network: false, simTime: this.app.sim.time, stoppedAt: null, atMs: performance.now(), stoppedAtMs: null };
    this.results.push(result);
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
        return this.say('Stopped. Every joint and the jaw hold. Press Resume on screen to go on.', 'stop', { fixed: true, interrupt: true });
      }
      case 'resume':
        return this.say(stopped ? STOPPED_LINE : 'I am not stopped.', 'info', { fixed: true });
      case 'home':
        if (stopped) return this.say(STOPPED_LINE, 'refusal', { fixed: true });
        if (!this.home) return this.say('I do not know where home is in this scene.', 'info');
        this.takeArm();
        this.app.loop.controller.setTarget(this.home);
        return this.say('Going home.', 'info', { fixed: true });
      case 'grip':
        if (stopped) return this.say(STOPPED_LINE, 'refusal', { fixed: true });
        this.takeArm();
        this.app.loop.controller.setGrip(action.open ? 0 : 1);
        return this.say(action.open ? 'Opening the jaw.' : 'Closing the jaw.', 'info', { fixed: true });
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

  /** Voice takes the arm from the hand so its command is not overwritten next tick. */
  private takeArm(): void {
    const source = this.app.loop.source;
    if (!source) return;
    this.parked = source;
    this.app.loop.source = null;
    this.handBack.hidden = false;
    this.handBack.textContent = `Give the arm back to the ${source.kind === 'webcam' ? 'hand' : source.kind}`;
  }

  private giveBack(): void {
    if (this.parked && !this.app.loop.source) this.app.loop.source = this.parked;
    this.parked = null;
    this.handBack.hidden = true;
  }

  private startListening(): void {
    if (this.listening) return;
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
  voiceBadges(): { brain: string; voice: string; mic: string };
  /** Logged Gemini calls (live gate). */
  brainCalls(): ObjectBrain['calls'];
}

declare module '../test-hooks' {
  interface SimHook extends Partial<VoiceHook> {}
}

/** The one init call for M5: the voice console, the health check, and (dev and test builds) the hooks. */
export function mountVoice(app: App, withHooks: boolean): VoiceConsole {
  const params = new URLSearchParams(location.search);
  consoleVoice.muted = params.get('mute') === '1';
  const panel = new VoiceConsole(document.body, app);
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
      }),
      brainCalls: () => objectBrain.calls.map((c) => ({ ...c })),
    };
    Object.defineProperties(window.__sim, Object.getOwnPropertyDescriptors(hooks));
  }
  return panel;
}
