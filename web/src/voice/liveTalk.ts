// Live talk: hands-free voice, like a phone call with mission control. One button turns on the
// browser's continuous speech recognition; it restarts itself when the browser ends a session,
// and it stops listening while RoBuff speaks so it never hears its own voice.
// Every final line goes through the offline grammar first, exactly as hold-to-talk does, so
// "stop" acts at once with no network call. Only a line the grammar does not know goes to the
// key server's POST /api/chat (Gemini 3.8 Flash), whose { reply, action } is run through the
// same handlers the grammar uses (a spawn goes through the object panel: guardrail and lift test).

import type { App } from '../app';
import { say } from '../objects/format';
import { MATERIALS } from '../objects/materials';
import { objectBrain } from '../objects/objectBrain';
import { gravity, isGravityId, type GravityId } from '../sim/gravity';
import { parseCommand, type VoiceAction } from './grammar';
import type { VoiceConsole } from './pushToTalk';
import { consoleVoice, type Caption, type SpeakingState } from './speak';

export const LIVE_BADGE = { live: 'Live talk: Gemini 3.8 Flash (live)', offline: 'Live talk: offline (grammar only)' } as const;
export const REPLY_MAX_CHARS = 200;
/** The chat route gets this many earlier turns (one line each, operator or RoBuff). */
export const HISTORY_TURNS = 6;
export const CHAT_ACTIONS = ['spawn', 'gravity', 'mode', 'home', 'none'] as const;
/** The delay panel's modes (src/delay/dualSim.ts DELAY_MODES), the values a mode action may carry. */
export const MODE_VALUES = ['direct', 'moon_ghost_off', 'moon_ghost_on'] as const;
export const UNSUPPORTED_NOTE = "Live talk needs the browser's speech recognition, which this browser does not have. Type the command instead.";

export type ChatActionType = (typeof CHAT_ACTIONS)[number];
export type ModeValue = (typeof MODE_VALUES)[number];

// ---------------------------------------------------------------------------------------------
// The ears: continuous recognition that restarts itself and pauses while RoBuff speaks.

export interface LiveResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { transcript: string } | undefined;
}
export interface LiveRecognitionEvent {
  resultIndex?: number;
  results: ArrayLike<LiveResult>;
}
export interface LiveRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort?(): void;
  onresult: ((event: LiveRecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
export type LiveRecognitionCtor = new () => LiveRecognition;

export function findRecognition(scope: unknown = typeof window === 'undefined' ? {} : window): LiveRecognitionCtor | null {
  const w = scope as { SpeechRecognition?: LiveRecognitionCtor; webkitSpeechRecognition?: LiveRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type LiveState = 'off' | 'listening' | 'paused' | 'unsupported';

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Errors that will not go away by trying again: live talk turns off and says why. */
const FATAL_ERRORS: Record<string, string> = {
  'not-allowed': 'the microphone was not allowed',
  'service-not-allowed': "the browser's speech service is not allowed here",
  'audio-capture': 'no microphone was found',
  'language-not-supported': 'English (US) speech is not supported here',
};
/** Errors that are part of normal listening: Chrome ends a silent session with no-speech. */
const QUIET_ERRORS = new Set(['no-speech', 'aborted']);

export interface LiveListenerOptions {
  Recognition: LiveRecognitionCtor | null;
  speaking: SpeakingState;
  /** One final transcript. What it returns is handed back by hear(). */
  onFinal: (text: string) => unknown;
  onState?: (state: LiveState, note: string | null) => void;
  timers?: Timers;
  /** Wait before restarting after the browser ends a session; doubles on each failure. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Turns live talk off after this many failed starts or errors in a row. */
  maxFailures?: number;
  /** Wait after RoBuff stops speaking before listening again, so the tail of its voice is not heard. */
  resumeAfterSpeechMs?: number;
}

export class LiveListener {
  state: LiveState = 'off';
  note: string | null = null;
  /** Recognition sessions started so far (each restart is one). */
  starts = 0;
  private enabled = false;
  private rec: LiveRecognition | null = null;
  private timer: unknown = null;
  private failures = 0;
  private unsubscribe: (() => void) | null = null;
  private readonly timers: Timers;

  constructor(private readonly options: LiveListenerOptions) {
    this.timers = options.timers ?? realTimers;
    if (!options.Recognition) this.state = 'unsupported';
  }

  get on(): boolean {
    return this.enabled;
  }

  get supported(): boolean {
    return this.options.Recognition !== null;
  }

  /** Turns live talk on. False (and the state 'unsupported') when the browser has no recognition. */
  start(): boolean {
    if (!this.options.Recognition) {
      this.setState('unsupported', UNSUPPORTED_NOTE);
      return false;
    }
    if (this.enabled) return true;
    this.enabled = true;
    this.failures = 0;
    this.unsubscribe = this.options.speaking.onSpeakingChange((speaking) => (speaking ? this.pause() : this.resumeSoon()));
    if (this.options.speaking.speaking) this.pause();
    else this.open();
    return true;
  }

  /** Turns everything off: no recognition, no timers, no speaking listener. */
  stop(note: string | null = null): void {
    this.enabled = false;
    this.clearTimer();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.close();
    this.setState(this.options.Recognition ? 'off' : 'unsupported', note);
  }

  toggle(): boolean {
    if (this.enabled) this.stop();
    else this.start();
    return this.enabled;
  }

  /**
   * One final transcript, from the recognition or from the test hook. Ignored (null) when live
   * talk is off or paused while RoBuff speaks, as the real microphone would be.
   */
  hear(text: string): unknown {
    const line = text.trim();
    if (!this.enabled || this.state !== 'listening' || !line) return null;
    this.failures = 0;
    return this.options.onFinal(line) ?? true;
  }

  private open(): void {
    this.clearTimer();
    const Ctor = this.options.Recognition;
    if (!this.enabled || !Ctor || this.options.speaking.speaking) return;
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (event) => {
      if (rec !== this.rec) return;
      for (let i = event.resultIndex ?? 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result?.isFinal) this.hear(result[0]?.transcript ?? '');
      }
    };
    rec.onerror = (event) => {
      if (rec !== this.rec) return;
      const fatal = FATAL_ERRORS[event.error];
      if (fatal) {
        this.stop(`Live talk turned off: ${fatal}. Type the command instead.`);
        return;
      }
      if (!QUIET_ERRORS.has(event.error)) {
        this.failures++;
        this.note = `Speech recognition: ${event.error}; trying again.`;
      }
    };
    rec.onend = () => {
      if (rec !== this.rec) return;
      this.rec = null;
      if (this.enabled && this.state !== 'paused') this.restartLater();
    };
    this.rec = rec;
    try {
      rec.start();
      this.starts++;
      this.setState('listening', this.note);
    } catch (error) {
      this.rec = null;
      this.failures++;
      this.note = `Speech recognition would not start: ${error instanceof Error ? error.message : String(error)}`;
      this.restartLater();
    }
  }

  private restartLater(): void {
    const max = this.options.maxFailures ?? 6;
    if (this.failures >= max) {
      this.stop(`Live talk turned off: speech recognition failed ${this.failures} times in a row (${this.note ?? 'no reason given'}). Type instead.`);
      return;
    }
    const base = this.options.backoffMs ?? 300;
    const wait = Math.min(this.options.maxBackoffMs ?? 5000, base * 2 ** this.failures);
    this.clearTimer();
    this.timer = this.timers.set(() => this.open(), wait);
  }

  private pause(): void {
    if (!this.enabled) return;
    this.clearTimer();
    this.close();
    this.setState('paused', null);
  }

  private resumeSoon(): void {
    if (!this.enabled) return;
    this.clearTimer();
    this.timer = this.timers.set(() => this.open(), this.options.resumeAfterSpeechMs ?? 400);
  }

  private close(): void {
    const rec = this.rec;
    this.rec = null;
    if (!rec) return;
    try {
      if (rec.abort) rec.abort();
      else rec.stop();
    } catch {
      // Already ended.
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private setState(state: LiveState, note: string | null): void {
    this.state = state;
    this.note = note;
    this.options.onState?.(state, note);
  }
}

// ---------------------------------------------------------------------------------------------
// The mouth, warmed up. The first sound a page plays makes Chrome start its audio output, which
// took about 0.4 s here (last TTS byte to "playing": 468 ms for the first reply, 73 to 169 ms for
// later ones) and can take far longer on a loaded machine. Playing a short silent clip at the
// Talk live click, which is a user gesture, pays that cost before the first reply instead.

/** A silent 16-bit mono PCM WAV file of the given length. */
export function silentWav(ms = 60, sampleRate = 8000): Uint8Array {
  const samples = Math.max(1, Math.round((sampleRate * ms) / 1000));
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  return bytes; // the samples are already zero: silence
}

export interface Playable {
  play(): Promise<void>;
}

let warmed = false;

/**
 * Plays a silent clip once per page so the browser's audio output is running before RoBuff's
 * first spoken reply. Call it from a click. False when it did nothing (muted, already warm, or no
 * Audio here).
 */
export function warmAudioOutput(muted: boolean, make?: (url: string) => Playable): boolean {
  if (muted || warmed) return false;
  const factory = make ?? (typeof Audio === 'undefined' ? null : (url: string) => new Audio(url));
  if (!factory || typeof URL === 'undefined' || typeof Blob === 'undefined') return false;
  warmed = true;
  const url = URL.createObjectURL(new Blob([silentWav() as BlobPart], { type: 'audio/wav' }));
  const done = () => URL.revokeObjectURL(url);
  try {
    factory(url).play().then(done, done);
  } catch {
    done();
  }
  return true;
}

/** Tests only: forget that the page was warmed. */
export function resetAudioWarmth(): void {
  warmed = false;
}

// ---------------------------------------------------------------------------------------------
// The guardrail's own offer, taken up. When it refuses an object only for its weight it says so,
// names the smaller size that would be light enough and says "Ask for that". In a spoken
// conversation live talk asks for that once, out loud, and the smaller request goes through the
// same guardrail and simulated lift test, so nothing is passed that the checks did not pass.

export interface LighterSize {
  /** The guardrail's size, rounded down so the request is never heavier than the one it named. */
  mm: number;
  /** The mass the guardrail said that size would have. */
  grams: number;
  /** The material's label, as the refusal said it ("Solid aluminium"). */
  material: string;
}

const LIGHTER_RE = /At ([\d,]+(?:\.\d+)?) millimetres across it would be ([\d,]+(?:\.\d+)?) grams\. Ask for that/;

/** Reads a weight refusal's suggestion from the line RoBuff said; null for any other line. */
export function lighterSize(said: string | null): LighterSize | null {
  if (!said) return null;
  const match = LIGHTER_RE.exec(said);
  if (!match) return null;
  const material = Object.values(MATERIALS).find((m) => said.includes(`${m.label} at this size is `));
  if (!material) return null;
  const exact = Number(match[1]!.replace(/,/g, ''));
  const mm = exact >= 10 ? Math.floor(exact) : Math.floor(exact * 10) / 10;
  if (!(mm > 0)) return null;
  return { mm, grams: Number(match[2]!.replace(/,/g, '')), material: material.label };
}

/** The follow-up request: the same thing, at the guardrail's size, in the same material. */
export function lighterRequest(description: string, size: LighterSize): string {
  return `${description}, ${say(size.mm)} millimetres across, in ${size.material.toLowerCase()}`;
}

/** What RoBuff says before it asks for the smaller one. It promises nothing: the checks decide. */
export function lighterBridge(size: LighterSize): string {
  return `So I'll ask for that: ${say(size.mm)} millimetres across, in ${size.material.toLowerCase()}, through the same checks.`;
}

// ---------------------------------------------------------------------------------------------
// The conversation: grammar first, then /api/chat for what the grammar does not know.

export interface ChatTurn {
  role: 'user' | 'robuff';
  text: string;
}
export interface ChatState {
  mode: string;
  gravity: GravityId;
  lastObject: string | null;
  stopped: boolean;
}
export interface ChatAction {
  type: ChatActionType;
  value?: string;
}
export interface ChatAnswer {
  reply: string;
  action: ChatAction;
  /** Gemini's own time as the key server measured it. */
  serverMs: number | null;
}

/** Checks the key server's answer again in the browser: a bad action becomes none, the reply is cut to 200 characters. */
export function parseChatAnswer(body: unknown): ChatAnswer {
  const b = (body ?? {}) as { reply?: unknown; action?: { type?: unknown; value?: unknown }; latency_ms?: unknown };
  const reply = typeof b.reply === 'string' ? b.reply.replace(/\s+/g, ' ').trim().slice(0, REPLY_MAX_CHARS) : '';
  if (!reply) throw new Error('the chat answer had no reply');
  const type = CHAT_ACTIONS.find((t) => t === b.action?.type) ?? 'none';
  const value = typeof b.action?.value === 'string' ? b.action.value.trim().slice(0, 200) : '';
  let action: ChatAction = { type: 'none' };
  if (type === 'spawn' && value) action = { type, value };
  else if (type === 'gravity' && isGravityId(value.toLowerCase())) action = { type, value: value.toLowerCase() };
  else if (type === 'mode' && (MODE_VALUES as readonly string[]).includes(value)) action = { type, value };
  else if (type === 'home') action = { type };
  return { reply, action, serverMs: typeof b.latency_ms === 'number' ? b.latency_ms : null };
}

/** What live talk can do: the same handlers the grammar's actions go through. */
export interface LiveRouter {
  /** Runs a grammar action exactly as hold-to-talk does. Resolves with what the console said. */
  grammar(text: string, action: VoiceAction): Promise<{ said: string | null }>;
  /** An object request through the object panel (guardrail, lift test, receipt). Resolves with what the console said last. */
  spawn(description: string, heard: string): Promise<{ said: string | null }>;
  gravity(id: GravityId, heard: string): Promise<unknown>;
  mode(value: ModeValue): unknown;
  home(heard: string): Promise<unknown>;
  /** Speaks a reply (ElevenLabs when live, else the browser voice) and captions it. */
  say(reply: string): Caption | null;
  state(): ChatState;
  /** True when the key server says Gemini is configured. */
  chatLive(): boolean;
}

export interface LiveTurn {
  text: string;
  /** grammar: the offline grammar acted; chat: Gemini answered; chat-failed: the chat call failed. */
  by: 'grammar' | 'chat' | 'chat-failed';
  grammar: VoiceAction['type'];
  action: ChatAction | null;
  reply: string | null;
  /** Browser round trip of POST /api/chat, ms. */
  chatMs: number | null;
  serverMs: number | null;
  error: string | null;
  /** performance.now() when the line was heard. */
  atMs: number;
  /** The reply's caption (its firstAudioMs fills in when the audio starts). */
  caption: Caption | null;
  /** Settles when an object spawn the reply started has finished, if any. */
  spawnDone: Promise<unknown> | null;
  /** The smaller request live talk made after a weight refusal, if it made one. */
  followUp: string | null;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class LiveChat {
  readonly history: ChatTurn[] = [];
  readonly turns: LiveTurn[] = [];

  constructor(
    private readonly router: LiveRouter,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs = 12_000,
  ) {}

  async handle(text: string): Promise<LiveTurn> {
    const parsed = parseCommand(text);
    const turn: LiveTurn = { text, by: 'grammar', grammar: parsed.type, action: null, reply: null, chatMs: null, serverMs: null, error: null, atMs: performance.now(), caption: null, spawnDone: null, followUp: null };
    this.turns.push(turn);
    if (parsed.type !== 'unknown' || !this.router.chatLive()) {
      // The grammar's own path, exactly as hold-to-talk: "stop" sets the latch before anything else.
      const done = await this.router.grammar(text, parsed);
      const said = parsed.type === 'object' ? await this.followUp(done.said, parsed.text, text, turn) : done.said;
      this.remember(text, said);
      return turn;
    }
    const state = this.router.state();
    const t0 = performance.now();
    let answer: ChatAnswer;
    try {
      const res = await this.fetchImpl('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, history: this.history.slice(-HISTORY_TURNS), state }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error((await res.text()).slice(0, 160) || `HTTP ${res.status}`);
      answer = parseChatAnswer(await res.json());
      turn.chatMs = performance.now() - t0;
    } catch (error) {
      turn.chatMs = performance.now() - t0;
      turn.by = 'chat-failed';
      turn.error = error instanceof Error ? error.message : String(error);
      const line = 'I could not reach the chat model just now, so I only know the offline commands. Say help for the list.';
      turn.caption = this.router.say(line);
      this.remember(text, line);
      return turn;
    }
    turn.by = 'chat';
    turn.action = answer.action;
    turn.reply = answer.reply;
    turn.serverMs = answer.serverMs;
    await this.dispatch(answer.action, text, turn);
    turn.caption = this.router.say(answer.reply);
    this.remember(text, answer.reply);
    return turn;
  }

  private async dispatch(action: ChatAction, heard: string, turn: LiveTurn): Promise<void> {
    switch (action.type) {
      case 'spawn':
        // Not awaited: the lift test takes seconds, and the object panel speaks the receipt when it is done.
        turn.spawnDone = this.router
          .spawn(action.value!, heard)
          .then((done) => this.followUp(done.said, action.value!, heard, turn))
          .catch(() => undefined);
        return;
      case 'gravity':
        await this.router.gravity(action.value as GravityId, heard);
        return;
      case 'mode':
        this.router.mode(action.value as ModeValue);
        return;
      case 'home':
        await this.router.home(heard);
        return;
      case 'none':
        return;
    }
  }

  /**
   * After an object request: if the guardrail refused it only for weight and named a lighter size,
   * says so and asks for that size once, through the same handler. Never twice, never when stopped.
   */
  private async followUp(said: string | null, description: string, heard: string, turn: LiveTurn): Promise<string | null> {
    const size = lighterSize(said);
    if (!size || turn.followUp !== null || this.router.state().stopped) return said;
    turn.followUp = lighterRequest(description, size);
    this.router.say(lighterBridge(size));
    const again = await this.router.grammar(heard, { type: 'object', text: turn.followUp });
    return again.said;
  }

  private remember(user: string, said: string | null): void {
    this.history.push({ role: 'user', text: user.slice(0, 240) });
    if (said) this.history.push({ role: 'robuff', text: said.slice(0, 240) });
    while (this.history.length > HISTORY_TURNS * 2) this.history.shift();
  }
}

// ---------------------------------------------------------------------------------------------
// Wiring for the page.

export interface LiveTurnSummary {
  text: string;
  by: LiveTurn['by'];
  grammar: string;
  action: ChatAction | null;
  reply: string | null;
  chatMs: number | null;
  serverMs: number | null;
  error: string | null;
  captionText: string | null;
  via: string | null;
  firstAudioMs: number | null;
  followUp: string | null;
}

function summary(turn: LiveTurn): LiveTurnSummary {
  return {
    text: turn.text,
    by: turn.by,
    grammar: turn.grammar,
    action: turn.action,
    reply: turn.reply,
    chatMs: turn.chatMs,
    serverMs: turn.serverMs,
    error: turn.error,
    captionText: turn.caption?.text ?? null,
    via: turn.caption?.via ?? null,
    firstAudioMs: turn.caption?.firstAudioMs ?? null,
    followUp: turn.followUp,
  };
}

export interface LiveHook {
  liveStart(): boolean;
  liveStop(): void;
  liveState(): { state: LiveState; note: string | null; starts: number; on: boolean; speaking: boolean };
  /** Injects one final transcript, as if the recognition heard it (headless Chrome has no microphone). Null when not listening. */
  liveHear(text: string): Promise<LiveTurnSummary | null>;
  liveTurns(): LiveTurnSummary[];
}

declare module '../test-hooks' {
  interface SimHook extends Partial<LiveHook> {}
}

function pressedMode(): string {
  return document.querySelector<HTMLElement>('#delay-panel [data-delay-mode][aria-pressed="true"]')?.dataset.delayMode ?? 'direct';
}

/** The one init call: the Talk live button's brain and ears, and (dev and test builds) the hooks. */
export function mountLiveTalk(panel: VoiceConsole, app: App, withHooks: boolean): { listener: LiveListener; chat: LiveChat } {
  const router: LiveRouter = {
    grammar: (text, action) => panel.runParsed(text, action, 'grammar', false),
    spawn: (description, heard) => panel.runParsed(heard, { type: 'object', text: description }, 'gemini', true),
    gravity: (id, heard) => panel.runParsed(heard, { type: 'gravity', id }, 'gemini', true),
    home: (heard) => panel.runParsed(heard, { type: 'home' }, 'gemini', true),
    mode: (value) => {
      // The same buttons the M key presses; they reset the scene and set Moon gravity for the delay modes.
      const button = document.querySelector<HTMLButtonElement>(`#delay-panel [data-delay-mode="${value}"]`);
      if (!button || button.disabled) return false;
      button.click();
      return true;
    },
    say: (reply) => consoleVoice.say(reply, 'info'),
    state: () => ({ mode: pressedMode(), gravity: gravity.current.id, lastObject: panel.lastObject, stopped: app.loop.stopLatch?.stopped === true }),
    chatLive: () => objectBrain.live,
  };
  const chat = new LiveChat(router);
  const listener = new LiveListener({
    Recognition: findRecognition(),
    speaking: consoleVoice,
    onFinal: (text) => chat.handle(text),
    onState: (state, note) => panel.showLive(state, note),
  });
  panel.attachLive(listener);
  if (withHooks && window.__sim) {
    const hooks: LiveHook = {
      liveStart: () => listener.start(),
      liveStop: () => listener.stop(),
      liveState: () => ({ state: listener.state, note: listener.note, starts: listener.starts, on: listener.on, speaking: consoleVoice.speaking }),
      liveHear: async (text) => {
        const pending = listener.hear(text);
        if (pending === null) return null;
        return summary(await (pending as Promise<LiveTurn>));
      },
      liveTurns: () => chat.turns.map(summary),
    };
    Object.defineProperties(window.__sim, Object.getOwnPropertyDescriptors(hooks));
  }
  return { listener, chat };
}
