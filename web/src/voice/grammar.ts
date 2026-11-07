// The offline command grammar: a spoken or typed line becomes one action, in the browser,
// with no network call. "stop" is matched first and returns at once, so a stop never waits
// on a model. Anything the grammar does not know is "unknown"; the voice console may then
// ask Gemini (only when the key server says it is live), and otherwise says it did not understand.

import type { GravityId } from '../sim/gravity';

export type VoiceAction =
  | { type: 'stop' }
  | { type: 'resume' }
  | { type: 'home' }
  | { type: 'grip'; open: boolean }
  | { type: 'gravity'; id: GravityId }
  | { type: 'delay'; on: boolean }
  | { type: 'ghost'; on: boolean }
  | { type: 'help' }
  | { type: 'object'; text: string }
  | { type: 'unknown'; text: string };

/** Words that carry no command: dropped before matching. */
const FILLER = new Set(['please', 'now', 'hey', 'ok', 'okay', 'aftergrip', 'arm', 'the', 'robot', 'thanks', 'thank', 'you', 'go', 'to', 'set', 'switch', 'turn', 'mode', 'gravity', 'and']);

/** Lower case, punctuation to spaces, single spaces. */
export function normalizeUtterance(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP_WORDS = /\b(stop|halt|freeze|abort)\b/;
/** Object requests: the rest of the line is the description. */
const OBJECT_PREFIX = /^(?:(?:please|hey|ok|okay|aftergrip|can you|could you|i want|i'd like|i would like)\s+)*(?:make|spawn|give me|create|build|fabricate|print|generate)\b\s*(?:me\s+)?(.*)$/;

const GRAVITY_WORDS: [RegExp, GravityId][] = [
  [/^(earth|earth normal|one g|1 g)$/, 'earth'],
  [/^(mars|martian)$/, 'mars'],
  [/^(moon|lunar|the moon)$/, 'moon'],
  [/^(bennu|asteroid bennu)$/, 'bennu'],
  [/^(orbit|zero g|zero-g|0 g|zero|microgravity|weightless|space)$/, 'orbit'],
];

const ON = /^(on|enable|enabled|start|yes)$/;
const OFF = /^(off|disable|disabled|no|none)$/;

/** The words left once filler is gone, joined by single spaces. */
function core(normalized: string): string {
  return normalized
    .split(' ')
    .filter((word) => word && !FILLER.has(word))
    .join(' ');
}

function toggle(words: string, name: 'delay' | 'ghost'): boolean | null {
  const rest = words
    .split(' ')
    .filter((w) => w !== name && w !== 'moon' && w !== 'arm' && w !== 'show' && w !== 'hide')
    .join(' ');
  if (!words.split(' ').includes(name)) return null;
  if (/\b(hide|no)\b/.test(words)) return false;
  if (/\bshow\b/.test(words)) return true;
  if (rest === '' || ON.test(rest)) return words.split(' ').includes('no') ? false : true;
  if (OFF.test(rest)) return false;
  return null;
}

/** One line to one action. Never throws, never waits. */
export function parseCommand(text: string): VoiceAction {
  const normalized = normalizeUtterance(text);
  if (!normalized) return { type: 'unknown', text: '' };

  // An object request with a stop word in it is still a stop ("make it stop", "make a stop sign").
  const object = OBJECT_PREFIX.exec(normalized);
  if (object) {
    const description = object[1]!.trim();
    if (description && !STOP_WORDS.test(description)) return { type: 'object', text: description };
    if (description) return { type: 'stop' };
    return { type: 'unknown', text: normalized };
  }

  // Safety bias: any other line with a stop word is a stop.
  if (STOP_WORDS.test(normalized)) return { type: 'stop' };

  const words = core(normalized);
  if (/^(resume|continue|carry on|unpause|clear stop|unstop)$/.test(words)) return { type: 'resume' };
  if (/^(home|return home|back home|home position)$/.test(words)) return { type: 'home' };
  if (/^(open|open gripper|open jaw|open hand|release|let go|drop it|drop)$/.test(words)) return { type: 'grip', open: true };
  if (/^(close|close gripper|close jaw|close hand|grip|grab|grab it|pinch)$/.test(words)) return { type: 'grip', open: false };
  if (/^(help|what can i say|commands|what can you do)$/.test(words)) return { type: 'help' };

  for (const [pattern, id] of GRAVITY_WORDS) if (pattern.test(words)) return { type: 'gravity', id };

  const delay = toggle(words, 'delay');
  if (delay !== null) return { type: 'delay', on: delay };
  const ghost = toggle(words, 'ghost');
  if (ghost !== null) return { type: 'ghost', on: ghost };

  return { type: 'unknown', text: normalized };
}

/** What the console says for "help". */
export const HELP_LINE =
  'Say stop, home, open, close, Earth, Mars, Moon, Bennu, orbit, delay on or off, ghost on or off, or make followed by an object.';
