// The console voice. Every spoken line is captioned first, at once, whatever happens to the
// audio. Audio is ElevenLabs eleven_flash_v2_5 through the key server when /api/health says it
// is configured, otherwise the browser's own speechSynthesis, otherwise captions only.
// Fixed lines (GO, "wait for truth", gravity changes) may be served from the server's disk
// cache; the caption says "cached" when they were.

import type { Receipt } from '../objects/receipt';
import { VoiceComposer } from '../objects/messages';

export type LineKind = 'receipt' | 'refusal' | 'go' | 'wait' | 'gravity' | 'stop' | 'info';
export type Via = 'elevenlabs' | 'elevenlabs (cached)' | 'browser voice' | 'captions only';

export interface Caption {
  id: number;
  text: string;
  kind: LineKind;
  /** Where the audio came from; set once known. */
  via: Via | null;
  /** performance.now() when the line was asked for. */
  atMs: number;
  /** ms from the request to the first audio playing (ElevenLabs only). */
  firstAudioMs: number | null;
  error: string | null;
}

export interface SayOptions {
  /** Same words every time: the server may cache the audio. */
  fixed?: boolean;
  /** Cut off whatever is speaking or queued (used for stop). */
  interrupt?: boolean;
}

/** The server takes at most this many characters per TTS call. */
export const TTS_CHUNK_CHARS = 160;
export const VOICE_BADGE = { live: 'voice: ElevenLabs (live)', offline: 'voice: browser (offline)' } as const;
const HISTORY = 50;

/** Splits a line at sentence or word breaks into pieces of at most max characters. */
export function chunkLine(text: string, max = TTS_CHUNK_CHARS): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    const piece = word.length > max ? word.slice(0, max) : word;
    const next = current ? `${current} ${piece}` : piece;
    if (next.length > max) {
      out.push(current);
      current = piece;
    } else {
      current = next;
      if (/[.!?]$/.test(piece) && current.length > max * 0.6) {
        out.push(current);
        current = '';
      }
    }
  }
  if (current) out.push(current);
  return out.filter(Boolean);
}

export class ConsoleVoice {
  /** True when the key server has ElevenLabs configured. */
  live = false;
  /** No audio at all, captions only (?mute=1). */
  muted = false;
  readonly captions: Caption[] = [];
  private nextId = 1;
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  private audio: HTMLAudioElement | null = null;
  private readonly listeners = new Set<(caption: Caption) => void>();
  /** Lines said and not yet finished playing (or skipped). Above 0 means the console is speaking. */
  private pending = 0;
  private readonly speakingListeners = new Set<(speaking: boolean) => void>();

  badge(): string {
    return this.live ? VOICE_BADGE.live : VOICE_BADGE.offline;
  }

  /** True from the moment a line is said until its audio has ended (live talk pauses its ears meanwhile). */
  get speaking(): boolean {
    return this.pending > 0;
  }

  /** Called with true when the console starts speaking and false when it has gone quiet. */
  onSpeakingChange(listener: (speaking: boolean) => void): () => void {
    this.speakingListeners.add(listener);
    return () => this.speakingListeners.delete(listener);
  }

  private countSpeaking(delta: 1 | -1): void {
    const was = this.pending > 0;
    this.pending = Math.max(0, this.pending + delta);
    if (was !== this.pending > 0) for (const listener of this.speakingListeners) listener(this.pending > 0);
  }

  onCaption(listener: (caption: Caption) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Captions the line now and queues its audio. Returns the caption, which fills in via later. */
  say(text: string, kind: LineKind = 'info', options: SayOptions = {}): Caption {
    const caption: Caption = { id: this.nextId++, text, kind, via: null, atMs: performance.now(), firstAudioMs: null, error: null };
    this.captions.push(caption);
    if (this.captions.length > HISTORY) this.captions.shift();
    if (options.interrupt) this.cutOff();
    const generation = this.generation;
    this.emit(caption);
    this.countSpeaking(1);
    this.queue = this.queue
      .then(() => (generation === this.generation ? this.play(caption, options) : undefined))
      .catch(() => undefined)
      .finally(() => this.countSpeaking(-1));
    return caption;
  }

  private cutOff(): void {
    this.generation++;
    this.audio?.pause();
    this.audio = null;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.queue = Promise.resolve();
  }

  private emit(caption: Caption): void {
    for (const listener of this.listeners) listener(caption);
  }

  private async play(caption: Caption, options: SayOptions): Promise<void> {
    if (this.muted) {
      caption.via = 'captions only';
    } else if (this.live) {
      try {
        await this.playElevenLabs(caption, options);
      } catch (error) {
        caption.error = `ElevenLabs failed (${error instanceof Error ? error.message : String(error)}); browser voice used`;
        await this.playBrowser(caption);
      }
    } else {
      await this.playBrowser(caption);
    }
    this.emit(caption);
  }

  private async playElevenLabs(caption: Caption, options: SayOptions): Promise<void> {
    const generation = this.generation;
    let cachedAll = true;
    for (const piece of chunkLine(caption.text)) {
      if (generation !== this.generation) return;
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: piece, fixed: options.fixed === true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (res.headers.get('x-voice-cache') !== 'hit') cachedAll = false;
      const url = URL.createObjectURL(await res.blob());
      if (generation !== this.generation) {
        URL.revokeObjectURL(url);
        return;
      }
      const audio = (this.audio = new Audio(url));
      await new Promise<void>((resolve, reject) => {
        audio.addEventListener('playing', () => {
          if (caption.firstAudioMs === null) caption.firstAudioMs = performance.now() - caption.atMs;
          caption.via = cachedAll ? 'elevenlabs (cached)' : 'elevenlabs';
          this.emit(caption);
        });
        audio.addEventListener('ended', () => resolve());
        audio.addEventListener('pause', () => resolve());
        audio.addEventListener('error', () => reject(new Error('audio would not play')));
        audio.play().catch(reject);
      }).finally(() => URL.revokeObjectURL(url));
    }
    caption.via = cachedAll ? 'elevenlabs (cached)' : 'elevenlabs';
  }

  private playBrowser(caption: Caption): Promise<void> {
    if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') {
      caption.via = 'captions only';
      return Promise.resolve();
    }
    caption.via = 'browser voice';
    const utterance = new SpeechSynthesisUtterance(caption.text);
    utterance.rate = 1.05;
    return new Promise<void>((resolve) => {
      // Some machines have no voices and never fire end; do not hold the queue for long.
      const timer = setTimeout(resolve, 400 + caption.text.length * 90);
      utterance.onend = utterance.onerror = () => {
        clearTimeout(timer);
        resolve();
      };
      speechSynthesis.speak(utterance);
    });
  }
}

/** The page's one console voice. Other features (the delay mode's GO and "wait for truth") call speakLine. */
export const consoleVoice = new ConsoleVoice();

/** The speaking-state hook live talk uses so it never hears RoBuff's own voice. */
export interface SpeakingState {
  readonly speaking: boolean;
  onSpeakingChange(listener: (speaking: boolean) => void): () => void;
}

export function speakLine(text: string, kind: LineKind = 'info', options: SayOptions = {}): Caption {
  return consoleVoice.say(text, kind, options);
}

/** The page's one composer: it remembers the last line and whether the jaw limit was said. */
const receiptVoice = new VoiceComposer();

/**
 * The spoken summary of a finished object request: a short line that names the object, its size
 * and mass, and the lift verdict, in rotating phrasings; never the same line twice in a row, and
 * the jaw limit at most once a session unless a width refusal needs it. The on-screen receipt
 * keeps every detail.
 */
export function receiptLine(receipt: Receipt, spawned: boolean): { text: string; kind: LineKind } {
  return receiptVoice.compose(receipt, spawned);
}
