import { describe, expect, it } from 'vitest';
import type { VoiceAction } from './grammar';
import { HISTORY_TURNS, LiveChat, LiveListener, lighterRequest, lighterSize, parseChatAnswer, resetAudioWarmth, silentWav, warmAudioOutput, type ChatState, type LiveRecognition, type LiveRecognitionEvent, type LiveRouter, type Timers } from './liveTalk';
import { validate } from '../objects/guardrail';
import { VoiceComposer } from '../objects/messages';
import { isRefused } from '../objects/receipt';
import type { ObjectSpec } from '../objects/spec';
import { ConsoleVoice, type Caption } from './speak';

class FakeRecognition implements LiveRecognition {
  static made: FakeRecognition[] = [];
  static failStart = false;
  lang = '';
  continuous = false;
  interimResults = true;
  started = 0;
  aborted = 0;
  stopped = 0;
  onresult: ((event: LiveRecognitionEvent) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FakeRecognition.made.push(this);
  }
  start(): void {
    if (FakeRecognition.failStart) throw new Error('InvalidStateError');
    this.started++;
  }
  stop(): void {
    this.stopped++;
    this.onend?.();
  }
  abort(): void {
    this.aborted++;
    this.onend?.();
  }
  /** Emits results the way Chrome does: every result so far, with resultIndex at the new ones. */
  say(text: string, isFinal = true, resultIndex = 0, before: string[] = []): void {
    const results = [...before.map((t) => result(t, true)), result(text, isFinal)];
    this.onresult?.({ resultIndex, results });
  }
  end(): void {
    this.onend?.();
  }
  error(error: string): void {
    this.onerror?.({ error });
  }
}

function result(transcript: string, isFinal: boolean) {
  return Object.assign([{ transcript }], { isFinal });
}

class FakeTimers implements Timers {
  now = 0;
  private queue: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;
  set(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.queue.push({ at: this.now + ms, fn, id });
    return id;
  }
  clear(handle: unknown): void {
    this.queue = this.queue.filter((t) => t.id !== handle);
  }
  get pending(): number[] {
    return this.queue.map((t) => t.at - this.now);
  }
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at);
      const next = this.queue[0];
      if (!next || next.at > until) break;
      this.queue.shift();
      this.now = next.at;
      next.fn();
    }
    this.now = until;
  }
}

class FakeSpeaking {
  speaking = false;
  private listeners = new Set<(s: boolean) => void>();
  onSpeakingChange(listener: (s: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  set(value: boolean): void {
    this.speaking = value;
    for (const l of this.listeners) l(value);
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

function rig(options: { supported?: boolean } = {}) {
  FakeRecognition.made = [];
  FakeRecognition.failStart = false;
  const timers = new FakeTimers();
  const speaking = new FakeSpeaking();
  const heard: string[] = [];
  const states: string[] = [];
  const listener = new LiveListener({
    Recognition: options.supported === false ? null : FakeRecognition,
    speaking,
    timers,
    onFinal: (text) => {
      heard.push(text);
    },
    onState: (state) => states.push(state),
  });
  const last = () => FakeRecognition.made[FakeRecognition.made.length - 1]!;
  return { timers, speaking, heard, states, listener, last };
}

describe('LiveListener: continuous recognition', () => {
  it('starts continuous, final results only, en-US, and hears each final line once', () => {
    const { listener, last, heard } = rig();
    expect(listener.start()).toBe(true);
    const rec = last();
    expect(rec).toMatchObject({ continuous: true, interimResults: false, lang: 'en-US', started: 1 });
    expect(listener.state).toBe('listening');
    rec.say('make me a', false);
    rec.say('make me a tennis ball');
    rec.say('switch to Mars', true, 1, ['make me a tennis ball']);
    expect(heard).toEqual(['make me a tennis ball', 'switch to Mars']);
  });

  it('restarts after the browser ends a session, with a short backoff that grows on errors', () => {
    const { listener, last, timers } = rig();
    listener.start();
    last().end();
    expect(FakeRecognition.made).toHaveLength(1);
    expect(timers.pending).toEqual([300]);
    timers.advance(299);
    expect(FakeRecognition.made).toHaveLength(1);
    timers.advance(1);
    expect(FakeRecognition.made).toHaveLength(2);
    expect(last().started).toBe(1);
    expect(listener.state).toBe('listening');
    // A silent session (no-speech) is normal: the same short wait.
    last().error('no-speech');
    last().end();
    expect(timers.pending).toEqual([300]);
    timers.advance(300);
    // A network error doubles the wait.
    last().error('network');
    last().end();
    expect(timers.pending).toEqual([600]);
    timers.advance(600);
    expect(FakeRecognition.made).toHaveLength(4);
    expect(listener.starts).toBe(4);
  });

  it('pauses while RoBuff speaks (never hears itself) and resumes after', () => {
    const { listener, last, timers, speaking, heard, states } = rig();
    listener.start();
    const first = last();
    speaking.set(true);
    expect(first.aborted).toBe(1);
    expect(listener.state).toBe('paused');
    // The session that was cut off ends and says something late: ignored, and no restart.
    first.say('robuff talking to itself');
    first.end();
    expect(heard).toEqual([]);
    expect(timers.pending).toEqual([]);
    expect(listener.hear('typed into the hook while speaking')).toBeNull();
    speaking.set(false);
    expect(FakeRecognition.made).toHaveLength(1);
    timers.advance(400);
    expect(FakeRecognition.made).toHaveLength(2);
    expect(listener.state).toBe('listening');
    last().say('hello again');
    expect(heard).toEqual(['hello again']);
    expect(states).toEqual(['listening', 'paused', 'listening']);
  });

  it('starts paused when RoBuff is already speaking', () => {
    const { listener, speaking, timers } = rig();
    speaking.speaking = true;
    listener.start();
    expect(FakeRecognition.made).toHaveLength(0);
    expect(listener.state).toBe('paused');
    speaking.set(false);
    timers.advance(400);
    expect(FakeRecognition.made).toHaveLength(1);
  });

  it('turning it off stops everything', () => {
    const { listener, last, timers, speaking } = rig();
    listener.start();
    const rec = last();
    rec.end();
    expect(timers.pending).toHaveLength(1);
    listener.stop();
    expect(listener.state).toBe('off');
    expect(listener.on).toBe(false);
    expect(timers.pending).toEqual([]);
    expect(speaking.listenerCount).toBe(0);
    timers.advance(10_000);
    speaking.set(true);
    speaking.set(false);
    timers.advance(10_000);
    expect(FakeRecognition.made).toHaveLength(1);
    expect(listener.hear('stop')).toBeNull();
    // A running session is aborted on stop.
    listener.start();
    const second = last();
    listener.toggle();
    expect(second.aborted).toBe(1);
    expect(listener.state).toBe('off');
  });

  it('without speech recognition the button stays off and says why', () => {
    const { listener, states } = rig({ supported: false });
    expect(listener.state).toBe('unsupported');
    expect(listener.start()).toBe(false);
    expect(listener.on).toBe(false);
    expect(listener.note).toMatch(/does not have/);
    expect(states).toEqual(['unsupported']);
  });

  it('a refused microphone turns live talk off; repeated start failures give up', () => {
    const a = rig();
    a.listener.start();
    a.last().error('not-allowed');
    expect(a.listener.state).toBe('off');
    expect(a.listener.note).toMatch(/microphone was not allowed/);

    const b = rig();
    FakeRecognition.failStart = true;
    b.listener.start();
    for (let i = 0; i < 10; i++) b.timers.advance(10_000);
    expect(b.listener.state).toBe('off');
    expect(b.listener.note).toMatch(/failed 6 times/);
    expect(b.timers.pending).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

interface Calls {
  grammar: VoiceAction[];
  spawn: string[];
  gravity: string[];
  mode: string[];
  home: number;
  said: string[];
  fetches: { url: string; body: { text: string; history: unknown[]; state: ChatState } }[];
}

const STATE: ChatState = { mode: 'direct', gravity: 'earth', lastObject: null, stopped: false };

interface RigOptions {
  /** What the console said after each object request, in order (the receipt line). */
  objectLines?: string[];
  state?: ChatState;
}

function chatRig(answer: unknown = { reply: 'Hello from mission control, in simulation.', action: { type: 'none' } }, live = true, options: RigOptions = {}) {
  const calls: Calls = { grammar: [], spawn: [], gravity: [], mode: [], home: 0, said: [], fetches: [] };
  const objectLines = [...(options.objectLines ?? [])];
  const router: LiveRouter = {
    grammar: async (_text, action) => {
      calls.grammar.push(action);
      if (action.type === 'object' && objectLines.length) return { said: objectLines.shift()! };
      return { said: `grammar did ${action.type}` };
    },
    spawn: async (description) => {
      calls.spawn.push(description);
      return { said: objectLines.shift() ?? 'spawned' };
    },
    gravity: async (id) => {
      calls.gravity.push(id);
    },
    mode: (value) => calls.mode.push(value),
    home: async () => {
      calls.home++;
    },
    say: (reply) => {
      calls.said.push(reply);
      return { id: 1, text: reply, kind: 'info', via: null, atMs: 0, firstAudioMs: null, error: null } satisfies Caption;
    },
    state: () => options.state ?? STATE,
    chatLive: () => live,
  };
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.fetches.push({ url, body: JSON.parse(String(init.body)) });
    const body = typeof answer === 'function' ? (answer as () => unknown)() : answer;
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, chat: new LiveChat(router, fetchImpl) };
}

describe('LiveChat: grammar first, then /api/chat', () => {
  it('"stop" is handled by the grammar at once, with no fetch', async () => {
    const { calls, chat } = chatRig();
    const pending = chat.handle('stop');
    // Synchronously, before any await settles: the stop action has already been handed over.
    expect(calls.grammar).toEqual([{ type: 'stop' }]);
    const turn = await pending;
    expect(turn.by).toBe('grammar');
    expect(calls.fetches).toEqual([]);
    expect(calls.said).toEqual([]);
  });

  it('known lines (gravity, objects) also stay in the grammar; nothing goes on the network', async () => {
    const { calls, chat } = chatRig();
    await chat.handle('switch to Mars');
    await chat.handle('make me a tennis ball');
    expect(calls.grammar).toEqual([{ type: 'gravity', id: 'mars' }, { type: 'object', text: 'a tennis ball' }]);
    expect(calls.fetches).toEqual([]);
  });

  it('an unknown line calls /api/chat with the text, the last 6 turns and the state, then speaks the reply', async () => {
    const { calls, chat } = chatRig();
    for (let i = 0; i < 5; i++) await chat.handle(`tell me something ${i}`);
    const turn = await chat.handle("what's the gravity on the moon?");
    expect(calls.fetches).toHaveLength(6);
    const last = calls.fetches[5]!;
    expect(last.url).toBe('/api/chat');
    expect(last.body.text).toBe("what's the gravity on the moon?");
    expect(last.body.state).toEqual(STATE);
    expect(last.body.history).toHaveLength(HISTORY_TURNS);
    expect(last.body.history.at(-1)).toEqual({ role: 'robuff', text: 'Hello from mission control, in simulation.' });
    expect(turn).toMatchObject({ by: 'chat', grammar: 'unknown', reply: 'Hello from mission control, in simulation.', action: { type: 'none' } });
    expect(typeof turn.chatMs).toBe('number');
    expect(calls.said).toHaveLength(6);
  });

  it('dispatches each action type to its handler', async () => {
    const answers = [
      { reply: 'Making a tennis ball; the guardrail and lift test will check it in simulation.', action: { type: 'spawn', value: 'a tennis ball' } },
      { reply: 'Mars it is, in simulation.', action: { type: 'gravity', value: 'mars' } },
      { reply: 'Delay mode on with the ghost.', action: { type: 'mode', value: 'moon_ghost_on' } },
      { reply: 'Heading home.', action: { type: 'home' } },
      { reply: 'Just chatting.', action: { type: 'none' } },
    ];
    let n = 0;
    const { calls, chat } = chatRig(() => answers[n++]);
    for (let i = 0; i < answers.length; i++) await chat.handle('something the grammar does not know');
    expect(calls.spawn).toEqual(['a tennis ball']);
    expect(calls.gravity).toEqual(['mars']);
    expect(calls.mode).toEqual(['moon_ghost_on']);
    expect(calls.home).toBe(1);
    expect(calls.grammar).toEqual([]);
    expect(calls.said).toEqual(answers.map((a) => a.reply));
    expect(chat.turns.map((t) => t.action?.type)).toEqual(['spawn', 'gravity', 'mode', 'home', 'none']);
  });

  it('offline (no Gemini): an unknown line goes to the grammar, which says it did not understand', async () => {
    const { calls, chat } = chatRig(undefined, false);
    const turn = await chat.handle("what's the gravity on the moon?");
    expect(turn.by).toBe('grammar');
    expect(calls.grammar[0]?.type).toBe('unknown');
    expect(calls.fetches).toEqual([]);
  });

  it('a failed chat call says so plainly and runs nothing', async () => {
    const { calls, chat } = chatRig(() => new Response('Gemini is not configured', { status: 503 }));
    const turn = await chat.handle('tell me a joke');
    expect(turn.by).toBe('chat-failed');
    expect(turn.error).toMatch(/not configured/);
    expect(calls.said[0]).toMatch(/could not reach the chat model/);
    expect(calls.spawn.length + calls.gravity.length + calls.mode.length + calls.home).toBe(0);
  });

  it('checks the answer again in the browser', () => {
    expect(parseChatAnswer({ reply: 'x'.repeat(300), action: { type: 'gravity', value: 'Jupiter' } })).toMatchObject({ reply: 'x'.repeat(200), action: { type: 'none' } });
    expect(parseChatAnswer({ reply: 'ok', action: { type: 'gravity', value: 'MOON' } }).action).toEqual({ type: 'gravity', value: 'moon' });
    expect(parseChatAnswer({ reply: 'ok', action: { type: 'stop' } }).action).toEqual({ type: 'none' });
    expect(parseChatAnswer({ reply: 'ok', action: { type: 'mode', value: 'warp' } }).action).toEqual({ type: 'none' });
    expect(() => parseChatAnswer({ action: { type: 'none' } })).toThrow(/no reply/);
  });

  it('ears and brain together: a heard "stop" never reaches the network', async () => {
    const { calls, chat } = chatRig();
    FakeRecognition.made = [];
    FakeRecognition.failStart = false;
    const speaking = new FakeSpeaking();
    const listener = new LiveListener({ Recognition: FakeRecognition, speaking, timers: new FakeTimers(), onFinal: (text) => chat.handle(text) });
    listener.start();
    FakeRecognition.made[0]!.say('stop');
    expect(calls.grammar).toEqual([{ type: 'stop' }]);
    await Promise.resolve();
    expect(calls.fetches).toEqual([]);
  });
});

describe('ConsoleVoice speaking state', () => {
  it('is true from say() until the line has played, then false', async () => {
    const voice = new ConsoleVoice();
    voice.muted = true;
    const seen: boolean[] = [];
    voice.onSpeakingChange((s) => seen.push(s));
    voice.say('one');
    voice.say('two');
    expect(voice.speaking).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(voice.speaking).toBe(false);
    expect(seen).toEqual([true, false]);
  });
});

describe('audio warm-up at the Talk live click', () => {
  it('silentWav is a valid PCM WAV of zero samples', () => {
    const wav = silentWav(60, 8000);
    const view = new DataView(wav.buffer);
    const tag = (at: number) => String.fromCharCode(...wav.slice(at, at + 4));
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(40, true)).toBe(480 * 2);
    expect(wav.length).toBe(44 + 960);
    expect(wav.slice(44).every((b) => b === 0)).toBe(true);
  });

  it('plays one silent clip per page, and none when muted', async () => {
    resetAudioWarmth();
    const played: string[] = [];
    const make = (url: string) => ({ play: () => (played.push(url), Promise.resolve()) });
    expect(warmAudioOutput(true, make)).toBe(false);
    expect(played).toEqual([]);
    expect(warmAudioOutput(false, make)).toBe(true);
    expect(warmAudioOutput(false, make)).toBe(false);
    expect(played).toHaveLength(1);
    expect(played[0]).toMatch(/^blob:/);
    resetAudioWarmth();
  });

  it('a clip that will not play does not throw', () => {
    resetAudioWarmth();
    expect(warmAudioOutput(false, () => ({ play: () => Promise.reject(new Error('NotAllowedError')) }))).toBe(true);
    resetAudioWarmth();
    expect(() => warmAudioOutput(false, () => { throw new Error('no audio'); })).not.toThrow();
    resetAudioWarmth();
  });
});

// ---------------------------------------------------------------------------------------------
// The guardrail's "Ask for that", taken up once. The refusal text comes from the real guardrail
// and the real voice composer, so a change to either wording breaks these tests, not the app.

const BALL: ObjectSpec = { kind: 'sphere', name: 'tennis ball', width_mm: 67, height_mm: 67, roughness: 0.1, lumpiness: 0, seed: 1, material: 'aluminium', color: '#d7e83a', why: 'A tennis ball as a sphere.' };

function refusalLine(spec: ObjectSpec): string {
  return new VoiceComposer().compose(validate(spec, { gravity_m_s2: 9.81 }), false).text;
}

describe("LiveChat: a weight refusal's own suggestion", () => {
  it('reads the size from the real guardrail refusal, and that size passes the same checks', () => {
    const heavy = validate(BALL, { gravity_m_s2: 9.81 });
    expect(heavy.steps.find((s) => s.action === 'refused')?.code).toBe('TOO_HEAVY');
    const line = refusalLine(BALL);
    const size = lighterSize(line);
    expect(size, line).not.toBeNull();
    expect(size!.material).toBe('Solid aluminium');
    expect(size!.grams).toBeLessThan(200);
    const smaller = validate({ ...BALL, width_mm: size!.mm, height_mm: size!.mm }, { gravity_m_s2: 9.81 });
    expect(isRefused(smaller.steps), JSON.stringify(smaller.steps.map((s) => s.message))).toBe(false);
    expect(smaller.mass_kg! * 1000).toBeLessThan(200);
    expect(lighterRequest('a tennis ball', size!)).toBe(`a tennis ball, ${size!.mm} millimetres across, in solid aluminium`);
  });

  it('is null for a slip refusal, a refusal with no lighter size, and a pass line', () => {
    expect(lighterSize(refusalLine({ ...BALL, material: 'ice', width_mm: 40, height_mm: 40 }))).toBeNull();
    expect(lighterSize(refusalLine({ ...BALL, material: 'iron', width_mm: 300, height_mm: 300 }))).toBeNull();
    expect(lighterSize("Here's your 40 millimetre box, 173 grams. It held in the simulated lift test.")).toBeNull();
    expect(lighterSize(null)).toBeNull();
  });

  it('a grammar object refused for weight: says so, asks once for the smaller size, through the grammar handler', async () => {
    const heavy = refusalLine(BALL);
    const size = lighterSize(heavy)!;
    const { calls, chat } = chatRig(undefined, true, { objectLines: [heavy, refusalLine(BALL)] });
    const turn = await chat.handle('make me a tennis ball');
    const retry = `a tennis ball, ${size.mm} millimetres across, in solid aluminium`;
    expect(calls.grammar).toEqual([{ type: 'object', text: 'a tennis ball' }, { type: 'object', text: retry }]);
    expect(turn.followUp).toBe(retry);
    expect(calls.said).toEqual([`So I'll ask for that: ${size.mm} millimetres across, in solid aluminium, through the same checks.`]);
    // The second refusal (same line again here) does not start a third request.
    expect(calls.fetches).toEqual([]);
  });

  it('a chat spawn refused for weight gets the same single follow-up after the receipt', async () => {
    const heavy = refusalLine(BALL);
    const { calls, chat } = chatRig({ reply: 'Making a tennis ball; the checks decide.', action: { type: 'spawn', value: 'a tennis ball' } }, true, { objectLines: [heavy, 'passed'] });
    const turn = await chat.handle('could you whip up a tennis ball');
    await turn.spawnDone;
    expect(calls.spawn).toEqual(['a tennis ball']);
    expect(calls.grammar).toHaveLength(1);
    expect(calls.grammar[0]).toMatchObject({ type: 'object', text: expect.stringMatching(/^a tennis ball, \d+ millimetres across, in solid aluminium$/) });
    expect(turn.followUp).not.toBeNull();
  });

  it('no follow-up for a pass, a slip refusal, or while the arm is stopped', async () => {
    const pass = chatRig(undefined, true, { objectLines: ['Done. It passed the simulated lift test.'] });
    await pass.chat.handle('make me a tennis ball');
    const slip = chatRig(undefined, true, { objectLines: [refusalLine({ ...BALL, material: 'ice', width_mm: 40, height_mm: 40 })] });
    await slip.chat.handle('make me a tennis ball');
    const stopped = chatRig(undefined, true, { objectLines: [refusalLine(BALL)], state: { ...STATE, stopped: true } });
    const turn = await stopped.chat.handle('make me a tennis ball');
    for (const rig of [pass, slip, stopped]) expect(rig.calls.grammar).toHaveLength(1);
    expect(turn.followUp).toBeNull();
    expect(stopped.calls.said).toEqual([]);
  });
});

// ---- Chat actions: an ordered list run through the same handlers as the grammar ----

function actRig(answer: unknown, options: { refuse?: (a: VoiceAction) => boolean; stopped?: () => boolean } = {}) {
  const acted: VoiceAction[] = [];
  const said: string[] = [];
  const caption = (text: string): Caption => ({ id: said.length, text, kind: 'info', via: null, atMs: 0, firstAudioMs: null, error: null });
  const router: LiveRouter = {
    grammar: async (_text, action) => {
      acted.push(action);
      return { said: `grammar did ${action.type}` };
    },
    spawn: async (description) => {
      acted.push({ type: 'object', text: description });
      return { said: 'spawned' };
    },
    gravity: async () => undefined,
    mode: () => undefined,
    home: async () => undefined,
    act: async (_heard, action) => {
      acted.push(action);
      const line = `did ${action.type}`;
      said.push(line);
      return { said: line, refused: options.refuse?.(action) ?? false, caption: caption(line) };
    },
    say: (reply) => {
      said.push(reply);
      return caption(reply);
    },
    state: () => ({ ...STATE, stopped: options.stopped?.() ?? false }),
    chatLive: () => true,
  };
  const fetchImpl = async () => new Response(JSON.stringify(typeof answer === 'function' ? (answer as () => unknown)() : answer), { status: 200 });
  return { acted, said, chat: new LiveChat(router, fetchImpl) };
}

describe('LiveChat: chat action lists', () => {
  it('runs pick then a move up, in order, through the shared handler, and speaks one line', async () => {
    const { acted, said, chat } = actRig({ reply: 'Grabbing it and lifting it a little, in simulation.', actions: [{ type: 'pick', value: 'the cube' }, { type: 'move', value: 'up 2 cm' }] });
    const turn = await chat.handle('could you grab the cube and lift it a little higher');
    expect(acted).toEqual([{ type: 'pick', target: 'cube' }, { type: 'move', direction: 'up', cm: 2, amount: 'said' }]);
    expect(turn.ran).toEqual(['pick', 'move']);
    expect(said).toEqual(['did pick', 'did move']);
    expect(turn.caption?.text).toBe('did pick');
    expect(turn.reply).toBe('Grabbing it and lifting it a little, in simulation.');
  });

  it('stops at a refusal, and at a set stop latch', async () => {
    const refused = actRig({ reply: 'ok', actions: [{ type: 'pick' }, { type: 'move', value: 'up 2 cm' }] }, { refuse: (a) => a.type === 'pick' });
    await refused.chat.handle('grab it and lift');
    expect(refused.acted.map((a) => a.type)).toEqual(['pick']);
    let stopped = false;
    const latched = actRig({ reply: 'ok', actions: [{ type: 'move', value: 'left 5 cm' }, { type: 'move', value: 'up 5 cm' }, { type: 'gravity', value: 'mars' }] }, { refuse: () => ((stopped = true), false), stopped: () => stopped });
    const turn = await latched.chat.handle('left then up');
    expect(latched.acted.map((a) => a.type)).toEqual(['move']);
    expect(turn.ran).toEqual(['move']);
  });

  it('maps every new action type and checks the answer again in the browser', () => {
    const answer = parseChatAnswer({
      reply: 'ok',
      actions: [{ type: 'move', value: 'sideways 5 cm' }, { type: 'grip', value: 'close' }, { type: 'skin', value: 'gold', part: 'wheels' }, { type: 'unskin' }, { type: 'release' }],
    });
    expect(answer.actions).toEqual([{ type: 'grip', value: 'close' }, { type: 'skin', value: 'gold', part: 'wheels' }, { type: 'unskin' }]);
    expect(answer.action).toEqual({ type: 'grip', value: 'close' });
    expect(parseChatAnswer({ reply: 'ok', actions: [{ type: 'stop' }] }).actions).toEqual([{ type: 'none' }]);
    expect(parseChatAnswer({ reply: 'ok', action: { type: 'home' } }).actions).toEqual([{ type: 'home' }]);
    expect(parseChatAnswer({ reply: 'ok', actions: [{ type: 'move', value: 'left 45 cm' }] }).actions).toEqual([{ type: 'move', value: 'left 45 cm' }]);
  });

  it('runs non-stop lines one at a time, and a stop at once while a line is still running', async () => {
    let release: () => void = () => undefined;
    const order: string[] = [];
    const router: LiveRouter = {
      grammar: async (_text, action) => {
        order.push(`start ${action.type}`);
        if (action.type === 'move') await new Promise<void>((resolve) => (release = resolve));
        order.push(`end ${action.type}`);
        return { said: null };
      },
      spawn: async () => ({ said: null }),
      gravity: async () => undefined,
      mode: () => undefined,
      home: async () => undefined,
      say: () => null,
      state: () => STATE,
      chatLive: () => false,
    };
    const chat = new LiveChat(router);
    const first = chat.handle('move left 5 cm');
    const second = chat.handle('close the gripper');
    const stop = chat.handle('stop');
    await Promise.resolve();
    expect(order).toEqual(['start move', 'start stop', 'end stop']);
    release();
    await Promise.all([first, second, stop]);
    expect(order).toEqual(['start move', 'start stop', 'end stop', 'end move', 'start grip', 'end grip']);
  });

  it('the ears reopen 400 ms after a short motion line, while the motion is still running', async () => {
    const timers = new FakeTimers();
    const speaking = new FakeSpeaking();
    FakeRecognition.made = [];
    FakeRecognition.failStart = false;
    let motionDone = false;
    const router: LiveRouter = {
      grammar: async () => {
        // "Moving left 5 centimetres." plays for about 1.1 s, then 0.94 s of silent motion.
        speaking.set(true);
        timers.set(() => speaking.set(false), 1100);
        await new Promise<void>((resolve) => timers.set(() => ((motionDone = true), resolve()), 2500));
        return { said: 'Moving left 5 centimetres.' };
      },
      spawn: async () => ({ said: null }),
      gravity: async () => undefined,
      mode: () => undefined,
      home: async () => undefined,
      say: () => null,
      state: () => STATE,
      chatLive: () => false,
    };
    const chat = new LiveChat(router);
    const listener = new LiveListener({ Recognition: FakeRecognition, speaking, timers, onFinal: (text) => chat.handle(text) });
    listener.start();
    FakeRecognition.made.at(-1)!.say('move left five centimetres');
    expect(listener.state).toBe('paused');
    timers.advance(1500);
    expect(motionDone).toBe(false);
    expect(listener.state).toBe('listening');
    timers.advance(1100);
    expect(motionDone).toBe(true);
  });
});
