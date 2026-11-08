// Live talk: hands-free voice, like a phone call with mission control. One button turns on the
// browser's continuous speech recognition; it restarts itself when the browser ends a session,
// and it stops listening while RoBuff speaks so it never hears its own voice.
// Every final line goes through the offline grammar first, exactly as hold-to-talk does, so
// "stop" acts at once with no network call. Only a line the grammar does not know goes to the
// key server's POST /api/chat (Gemini 3.8 Flash), whose { reply, actions } (at most 3, in order)
// run through the same handlers the grammar uses: moves, grip, pick, place and home go through the
// voice source in the operator's seat; a spawn goes through the object panel (guardrail, lift test).

import type { App } from '../app';
import { say } from '../objects/format';
import { MATERIALS } from '../objects/materials';
import { objectBrain } from '../objects/objectBrain';
import { gravity, isGravityId, type GravityId } from '../sim/gravity';
import { GRIPPER_SITE } from '../sim/armXml';
import { parseCommand, type VoiceAction } from './grammar';
import type { VoiceConsole } from './pushToTalk';
import { consoleVoice, type Caption, type SpeakingState } from './speak';

export const LIVE_BADGE = { live: 'Live talk: Gemini 3.8 Flash (live)', offline: 'Live talk: offline (grammar only)' } as const;
export const REPLY_MAX_CHARS = 200;
/** The chat route gets this many earlier turns (one line each, operator or RoBuff). */
export const HISTORY_TURNS = 6;
/** The same list as the key server's (server/index.mjs); a server test checks they match. */
export const CHAT_ACTIONS = ['move', 'grip', 'pick', 'place', 'release', 'home', 'gravity', 'mode', 'spawn', 'skin', 'unskin', 'none'] as const;
export const CHAT_MOVE_DIRECTIONS = ['left', 'right', 'up', 'down', 'forward', 'back', 'toward me', 'away from me'] as const;
export const CHAT_MAX_ACTIONS = 3;
/** Chat actions that move the arm or the jaw: never run while the stop latch is set. */
const ARM_ACTIONS: readonly string[] = ['move', 'grip', 'pick', 'place', 'release', 'home', 'spawn'];
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
  /** What is in the object slot now (not just the last request). */
  object?: { name: string; partNames: string[]; skin?: string } | null;
  /** True while voice holds the object in the jaw. */
  holding?: boolean;
  /** The gripper site, world cm, so the model can quote real numbers. */
  gripper_cm?: [number, number, number];
}
export interface ChatAction {
  type: ChatActionType;
  value?: string;
  part?: string;
}
export interface ChatAnswer {
  reply: string;
  /** The first action (older answers carry only this one). */
  action: ChatAction;
  /** Every action, in order, at most CHAT_MAX_ACTIONS. */
  actions: ChatAction[];
  /** Gemini's own time as the key server measured it. */
  serverMs: number | null;
}

/** One action checked again in the browser: anything it cannot run becomes none. */
export function cleanChatAction(raw: unknown): ChatAction {
  const a = (raw ?? {}) as { type?: unknown; value?: unknown; part?: unknown };
  const type = CHAT_ACTIONS.find((t) => t === a.type) ?? 'none';
  const value = typeof a.value === 'string' ? a.value.trim().slice(0, 200) : '';
  const part = typeof a.part === 'string' && a.part.trim() ? a.part.trim().slice(0, 24) : null;
  if (type === 'spawn' && value) return { type, value };
  if (type === 'gravity' && isGravityId(value.toLowerCase())) return { type, value: value.toLowerCase() };
  if (type === 'mode' && (MODE_VALUES as readonly string[]).includes(value)) return { type, value };
  if (type === 'home' || type === 'place' || type === 'release') return { type };
  if (type === 'move' && chatToVoice({ type, value })) return { type, value };
  if (type === 'grip' && (value === 'open' || value === 'close')) return { type, value };
  if (type === 'pick') return value ? { type, value: value.slice(0, 60) } : { type };
  if (type === 'skin' && value) return part ? { type, value: value.slice(0, 120), part } : { type, value: value.slice(0, 120) };
  if (type === 'unskin') return part ? { type, part } : { type };
  return { type: 'none' };
}

/** Checks the key server's answer again in the browser: bad actions are dropped, at most 3 are kept, the reply is cut to 200 characters. */
export function parseChatAnswer(body: unknown): ChatAnswer {
  const b = (body ?? {}) as { reply?: unknown; action?: unknown; actions?: unknown; latency_ms?: unknown };
  const reply = typeof b.reply === 'string' ? b.reply.replace(/\s+/g, ' ').trim().slice(0, REPLY_MAX_CHARS) : '';
  if (!reply) throw new Error('the chat answer had no reply');
  const raw: unknown[] = Array.isArray(b.actions) ? b.actions : b.action ? [b.action] : [];
  const kept = raw
    .slice(0, 6)
    .map(cleanChatAction)
    .filter((a) => a.type !== 'none')
    .slice(0, CHAT_MAX_ACTIONS);
  const actions: ChatAction[] = kept.length ? kept : [{ type: 'none' }];
  return { reply, action: actions[0]!, actions, serverMs: typeof b.latency_ms === 'number' ? b.latency_ms : null };
}

/** The grammar action a chat action means, or null for mode and none (mode clicks the delay panel). */
export function chatToVoice(action: ChatAction): VoiceAction | null {
  switch (action.type) {
    case 'move': {
      // The browser re-parses the phrase, so its own limits and directions always apply.
      const parsed = parseCommand(`move ${action.value ?? ''}`);
      return parsed.type === 'move' ? parsed : null;
    }
    case 'grip':
      return { type: 'grip', open: action.value === 'open' };
    case 'release':
      return { type: 'grip', open: true };
    case 'pick': {
      const target = (action.value ?? '').toLowerCase().replace(/^(?:the|a|an|that|this)\s+/, '').trim();
      return { type: 'pick', target: !target || /^(?:it|that|this|object|thing)$/.test(target) ? null : target };
    }
    case 'place':
      return { type: 'place' };
    case 'home':
      return { type: 'home' };
    case 'gravity':
      return isGravityId(action.value ?? '') ? { type: 'gravity', id: action.value as GravityId } : null;
    case 'spawn':
      return action.value ? { type: 'object', text: action.value } : null;
    case 'skin':
      return action.value ? { type: 'skin', look: action.value, part: action.part ?? null } : null;
    case 'unskin':
      return { type: 'unskin', part: action.part ?? null };
    case 'mode':
    case 'none':
      return null;
  }
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
  /**
   * Runs one chat action (as its grammar action) through the voice console's handlers. refused is
   * true when the handler refused it (stopped, out of reach, nothing held...): later actions are skipped.
   */
  act?(heard: string, action: VoiceAction): Promise<{ said: string | null; refused: boolean; caption: Caption | null }>;
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
  /** Every chat action, in order (null for grammar turns). */
  actions: ChatAction[] | null;
  /** The chat actions that ran before a refusal or a stop. */
  ran: ChatAction['type'][];
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
  /** The line being handled now, if any: lines other than stop wait their turn behind it. */
  private tail: Promise<unknown> | null = null;

  constructor(
    private readonly router: LiveRouter,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs = 12_000,
  ) {}

  /**
   * One heard line. A stop always runs at once, even while an earlier line is still running.
   * Every other line runs one at a time, so a quick grammar line never overtakes a chat line.
   */
  handle(text: string): Promise<LiveTurn> {
    const parsed = parseCommand(text);
    const atMs = performance.now();
    if (parsed.type === 'stop' || !this.tail) {
      const run = this.handleNow(text, parsed, atMs);
      if (parsed.type !== 'stop') this.track(run);
      return run;
    }
    const run = this.tail.then(() => this.handleNow(text, parsed, atMs));
    this.track(run);
    return run;
  }

  private track(run: Promise<LiveTurn>): void {
    const settled: Promise<unknown> = run.then(
      () => undefined,
      () => undefined,
    );
    this.tail = settled;
    void settled.then(() => {
      if (this.tail === settled) this.tail = null;
    });
  }

  private async handleNow(text: string, parsed: VoiceAction, atMs: number): Promise<LiveTurn> {
    const turn: LiveTurn = { text, by: 'grammar', grammar: parsed.type, action: null, actions: null, ran: [], reply: null, chatMs: null, serverMs: null, error: null, atMs, caption: null, spawnDone: null, followUp: null };
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
    turn.actions = answer.actions;
    turn.reply = answer.reply;
    turn.serverMs = answer.serverMs;
    const spoke = await this.dispatch(answer.actions, text, turn);
    // One line per turn: when an arm action said its own short line, Gemini's reply is not spoken too.
    turn.caption = spoke ?? this.router.say(answer.reply);
    this.remember(text, answer.reply);
    return turn;
  }

  /** Runs the actions in order. Stops at a refusal or a set stop latch. Returns the first line an arm action spoke, if any. */
  private async dispatch(actions: ChatAction[], heard: string, turn: LiveTurn): Promise<Caption | null> {
    let spoke: Caption | null = null;
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]!;
      if (action.type === 'none') continue;
      if (this.router.state().stopped && ARM_ACTIONS.includes(action.type)) break;
      turn.ran.push(action.type);
      if (action.type === 'mode') {
        this.router.mode(action.value as ModeValue);
        continue;
      }
      if (action.type === 'spawn') {
        // Not awaited when it is last: the lift test takes seconds, and the object panel speaks the receipt.
        const done = this.router
          .spawn(action.value!, heard)
          .then((d) => this.followUp(d.said, action.value!, heard, turn))
          .catch(() => undefined);
        turn.spawnDone = done;
        if (i < actions.length - 1) await done;
        continue;
      }
      if (!this.router.act) {
        // A router without the shared handler (older pages, tests): gravity and home only.
        if (action.type === 'gravity') await this.router.gravity(action.value as GravityId, heard);
        else if (action.type === 'home') await this.router.home(heard);
        continue;
      }
      const voice = chatToVoice(action);
      if (!voice) continue;
      const done = await this.router.act(heard, voice);
      if (ARM_ACTIONS.includes(action.type) || action.type === 'skin' || action.type === 'unskin') spoke ??= done.caption;
      if (done.refused) break;
    }
    return spoke;
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
  actions: ChatAction[] | null;
  ran: string[];
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
    actions: turn.actions,
    ran: [...turn.ran],
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
    act: async (heard, action) => {
      const before = consoleVoice.captions.length;
      const result = await panel.runParsed(heard, action, 'gemini', true);
      const lines = consoleVoice.captions.slice(before);
      return { said: result.said, refused: lines.some((c) => c.kind === 'refusal'), caption: lines[0] ?? null };
    },
    mode: (value) => {
      // The same buttons the M key presses; they reset the scene and set Moon gravity for the delay modes.
      const button = document.querySelector<HTMLButtonElement>(`#delay-panel [data-delay-mode="${value}"]`);
      if (!button || button.disabled) return false;
      button.click();
      return true;
    },
    say: (reply) => consoleVoice.say(reply, 'info'),
    state: () => {
      const occupant = panel.occupant();
      const site = app.sim.getSitePos(GRIPPER_SITE);
      return {
        mode: pressedMode(),
        gravity: gravity.current.id,
        lastObject: panel.lastObject,
        stopped: app.loop.stopLatch?.stopped === true,
        object: occupant ? { name: occupant.name, partNames: occupant.partNames } : null,
        holding: panel.holding !== null,
        ...(site ? { gripper_cm: site.map((v) => Math.round(v * 1000) / 10) as [number, number, number] } : {}),
      };
    },
    chatLive: () => objectBrain.live,
  };
  const chat = new LiveChat(router);
  // Typed and held lines the grammar does not know go to the same chat brain while it is live.
  panel.chatLine = (text) => chat.handle(text);
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
