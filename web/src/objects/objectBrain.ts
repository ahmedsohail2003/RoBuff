// The object brain: who turns a request into an object spec. Gemini 3.8 Flash through the
// key server when /api/health says it is configured, otherwise the offline keyword mock in
// the browser. The offline path never touches the network. Every answer says which one it was.

import { GRAVITY } from './limits';
import { specFromText } from './mock';
import { normalizeSpec, type ObjectSpec } from './spec';

export type GravityName = keyof typeof GRAVITY;
const isGravityName = (value: unknown): value is GravityName => typeof value === 'string' && Object.hasOwn(GRAVITY, value);

export type ServiceState = 'configured' | 'missing';

export interface ServerHealth {
  /** False when no key server answered (the usual case on a laptop with no key). */
  reachable: boolean;
  gemini: ServiceState;
  elevenlabs: ServiceState;
}

export const NO_SERVER: ServerHealth = { reachable: false, gemini: 'missing', elevenlabs: 'missing' };

/** Asks the key server what it has. Never throws: anything but a good answer means offline. */
export async function fetchHealth(timeoutMs = 2500): Promise<ServerHealth> {
  try {
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    if (!res.ok) return NO_SERVER;
    const body = (await res.json()) as Record<string, unknown>;
    if (body.ok !== true) return NO_SERVER;
    return {
      reachable: true,
      gemini: body.gemini === 'configured' ? 'configured' : 'missing',
      elevenlabs: body.elevenlabs === 'configured' ? 'configured' : 'missing',
    };
  } catch {
    return NO_SERVER;
  }
}

export type BrainIntent = 'spawn' | 'set_gravity' | 'home' | 'help' | 'none';

export interface SpecResult {
  source: 'gemini' | 'offline-mock';
  spec: ObjectSpec;
  matched: string[];
  clamps: string[];
  /** Wall-clock ms for the spec: the Gemini round trip, or the mock's own time. */
  latency_ms: number;
  /** Why the offline mock was used when the brain was live, or null. */
  note: string | null;
}

export interface IntentResult {
  source: 'gemini';
  intent: BrainIntent;
  gravity: GravityName | null;
  spec: ObjectSpec | null;
  clamps: string[];
  /** Browser-side round trip in ms. */
  latency_ms: number;
  /** Gemini's own time as the server measured it. */
  server_ms: number | null;
}

/** One logged Gemini call, for the live gate at Sitting 2. */
export interface BrainCall {
  text: string;
  ok: boolean;
  status: number | null;
  latency_ms: number;
  intent: BrainIntent | null;
  error: string | null;
}

export const BRAIN_BADGE = { live: 'object brain: Gemini 3.8 Flash (live)', offline: 'object brain: offline mock (no key)' } as const;

export class ObjectBrain {
  health: ServerHealth = NO_SERVER;
  readonly calls: BrainCall[] = [];
  /** Set by the object panel: runs one object request through the panel, receipt and all. */
  requestObject: ((text: string) => Promise<void>) | null = null;
  private readonly listeners = new Set<(brain: ObjectBrain) => void>();

  get live(): boolean {
    return this.health.reachable && this.health.gemini === 'configured';
  }

  badge(): string {
    return this.live ? BRAIN_BADGE.live : BRAIN_BADGE.offline;
  }

  async refresh(): Promise<ServerHealth> {
    this.health = await fetchHealth();
    for (const listener of this.listeners) listener(this);
    return this.health;
  }

  onChange(listener: (brain: ObjectBrain) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** One Gemini call through the key server. Throws when it fails; the caller falls back. */
  async ask(text: string): Promise<IntentResult> {
    const t0 = performance.now();
    const call: BrainCall = { text, ok: false, status: null, latency_ms: 0, intent: null, error: null };
    this.calls.push(call);
    try {
      const res = await fetch('/api/spec', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(12_000),
      });
      call.status = res.status;
      if (!res.ok) throw new Error((await res.text()).slice(0, 200) || `HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, unknown>;
      const intent = (['spawn', 'set_gravity', 'home', 'help', 'none'] as const).find((i) => i === body.intent) ?? 'none';
      const normalized = body.spec && typeof body.spec === 'object' ? normalizeSpec(body.spec) : null;
      call.ok = true;
      call.intent = intent;
      return {
        source: 'gemini',
        intent,
        gravity: isGravityName(body.gravity) ? body.gravity : null,
        spec: normalized?.spec ?? null,
        clamps: normalized?.clamps ?? [],
        latency_ms: (call.latency_ms = performance.now() - t0),
        server_ms: typeof body.latency_ms === 'number' ? body.latency_ms : null,
      };
    } catch (error) {
      call.latency_ms = performance.now() - t0;
      call.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /** A spec for an object request: Gemini when live, else (or when Gemini fails) the offline mock. */
  async specFor(text: string): Promise<SpecResult> {
    if (!this.live) return offline(text, null);
    // A preset keeps its fixed spec: no Gemini call.
    const preset = offline(text, 'A preset: its fixed spec, no Gemini call.');
    if (preset.matched.some((m) => m.startsWith('preset:'))) return preset;
    try {
      const answer = await this.ask(text);
      if (!answer.spec) return offline(text, `Gemini read this as "${answer.intent}", not an object, so the offline mock made the spec.`);
      return { source: 'gemini', spec: answer.spec, matched: [], clamps: answer.clamps, latency_ms: answer.latency_ms, note: null };
    } catch (error) {
      return offline(text, `Gemini failed (${error instanceof Error ? error.message : String(error)}), so the offline mock made the spec.`);
    }
  }
}

function offline(text: string, note: string | null): SpecResult {
  const t0 = performance.now();
  const mock = specFromText(text);
  return { source: 'offline-mock', spec: mock.spec, matched: mock.matched, clamps: mock.clamps, latency_ms: performance.now() - t0, note };
}

/** The page's one brain. The object panel and the voice console share it. */
export const objectBrain = new ObjectBrain();
