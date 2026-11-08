// The offline command grammar: a spoken or typed line becomes one action, in the browser,
// with no network call. "stop" is matched first and returns at once, so a stop never waits
// on a model. Anything the grammar does not know is "unknown"; the voice console may then
// ask Gemini (only when the key server says it is live), and otherwise says it did not understand.

import type { MoveDirection } from '../control/voiceMotion';
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
  | { type: 'move'; direction: MoveDirection; cm: number; amount: 'said' | 'small' | 'default' | 'large' }
  | { type: 'pick'; target: string | null }
  | { type: 'place' }
  | { type: 'handBack' }
  | { type: 'skin'; look: string; part: string | null }
  | { type: 'unskin'; part: string | null }
  | { type: 'unknown'; text: string };

/** Words that carry no command: dropped before matching. */
const FILLER = new Set(['please', 'now', 'hey', 'ok', 'okay', 'robuff', 'aftergrip', 'arm', 'the', 'robot', 'thanks', 'thank', 'you', 'go', 'to', 'set', 'switch', 'turn', 'mode', 'gravity', 'and']);

/** Lower case, punctuation to spaces (a decimal point between digits stays), single spaces. */
export function normalizeUtterance(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/(\d)\.(?=\d)/g, '$1\u0001')
    .replace(/[^a-z0-9\s'\u0001-]/g, ' ')
    .replace(/\u0001/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP_WORDS = /\b(stop|halt|freeze|abort)\b/;
/** Object requests: the rest of the line is the description. */
const OBJECT_PREFIX = /^(?:(?:please|hey|ok|okay|robuff|aftergrip|can you|could you|i want|i'd like|i would like)\s+)*(?:make|spawn|give me|create|build|fabricate|print|generate)\b\s*(?:me\s+)?(.*)$/;

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

  // Safety bias first: any line with a stop word is a stop ("make it stop", "make a stop sign").
  if (STOP_WORDS.test(normalized)) return { type: 'stop' };

  const line = stripLeadIn(normalized);
  const unskin = parseUnskin(line);
  if (unskin) return unskin;
  const skinned = parseSkin(line);
  if (skinned) return skinned;
  const place = parsePlace(line);
  if (place) return place;
  const pick = parsePick(line);
  if (pick) return pick;
  // "make it go left" is a move, not an object called "it go left".
  const makeMove = /^make (?:it|the arm|the gripper) ((?:go|move)\b.*)$/.exec(line);
  if (makeMove) {
    const move = parseMove(makeMove[1]!);
    if (move) return move;
  }

  // Object requests: the rest of the line is the description.
  const object = OBJECT_PREFIX.exec(normalized);
  if (object) {
    const description = object[1]!.trim();
    if (description) return { type: 'object', text: description };
    return { type: 'unknown', text: normalized };
  }

  const words = core(normalized);
  if (/^(resume|continue|carry on|unpause|clear stop|unstop)$/.test(words)) return { type: 'resume' };
  if (/^(home|return home|back home|home position)$/.test(words)) return { type: 'home' };
  if (/^(?:let go(?: of it)?|let it go|release(?: it)?|drop(?: it| that)?)$/.test(line)) return { type: 'grip', open: true };
  if (/^(open|open gripper|open jaw|open hand|release|drop it|drop|open it|open up|open claw|open your hand)$/.test(words)) return { type: 'grip', open: true };
  if (/^(close|close gripper|close jaw|close hand|grip|grab|grab it|pinch|close it|close claw|squeeze|squeeze it)$/.test(words)) return { type: 'grip', open: false };
  if (/^(?:what can you do|what can i say|help(?: me)?|commands)$/.test(line) || /^(help|what can i say|commands)$/.test(words)) return { type: 'help' };
  if (/^(?:hand (?:it |the arm |control )?back|hand control(?: back)?|hand over control|give (?:it|the arm|control) back|give back control|your turn|manual(?: control)?|my turn)$/.test(line)) return { type: 'handBack' };

  const move = parseMove(line);
  if (move) return move;

  for (const [pattern, id] of GRAVITY_WORDS) if (pattern.test(words)) return { type: 'gravity', id };

  const delay = toggle(words, 'delay');
  if (delay !== null) return { type: 'delay', on: delay };
  const ghost = toggle(words, 'ghost');
  if (ghost !== null) return { type: 'ghost', on: ghost };

  return { type: 'unknown', text: normalized };
}

// ---- Lead-ins ------------------------------------------------------------------------------

const LEAD_IN = /^(?:please|hey|ok|okay|robuff|aftergrip|now|just|so|and|then|can you|could you|would you|will you|i want you to|i'd like you to|i would like you to|go ahead and|try to)\s+/;

function stripLeadIn(line: string): string {
  let rest = line;
  for (let i = 0; i < 6; i++) {
    const next = rest.replace(LEAD_IN, '');
    if (next === rest) break;
    rest = next;
  }
  return rest.replace(/\s+(?:please|now|for me)$/, '');
}

// ---- Skins ---------------------------------------------------------------------------------

/** After "make it", these words ask for a different object (size, mass, state, direction), not a skin. */
const NOT_A_LOOK =
  /^(?:bigger|smaller|larger|heavier|lighter|taller|shorter|wider|narrower|thinner|thicker|longer|big|small|large|heavy|light|tall|short|wide|on|off|up|down|left|right|forward|back|go|move|stop|fall|float|spin|work|happen|again|so|a|an|the|me|for|of|in|out|bounce|roll|drop|faster|slower)\b/;
const PRONOUN = '(?:it|them|this|that|this one|that one)';
const SKIN_VERB = '(?:paint|skin|texture|wrap|colou?r|recolou?r|dress|coat)';
const SKIN_PREP = /\s+(?:in|with|like|as|to look like|to look|to be|to|into|so it looks like)\s+/;

function cleanLook(look: string): string {
  return look
    .replace(/^(?:a|an|the|some)\s+/, '')
    .replace(/\s+(?:skin|texture|finish|paint job|livery|colou?r|look|pattern|paint)$/, '')
    .replace(/\s+(?:please|now|for me)$/, '')
    .trim();
}

/** "the wheels" -> wheels, "the tesla's wheels" -> wheels, it -> null. */
function partOf(target: string): string | null {
  const t = target.trim();
  if (new RegExp(`^${PRONOUN}$`).test(t) || t === 'everything' || t === 'all of it' || t === 'the whole thing' || t === 'the object') return null;
  const own = /^the [a-z0-9-]+'s ([a-z0-9' -]+)$/.exec(t);
  if (own) return own[1]!.trim();
  const noun = /^(?:the|its|his|her|their) ([a-z0-9' -]+)$/.exec(t);
  return noun ? noun[1]!.trim() : null;
}

function skin(look: string, part: string | null): VoiceAction | null {
  const clean = cleanLook(look);
  if (!clean || clean.length > 120) return null;
  return { type: 'skin', look: clean, part };
}

function parseSkin(line: string): VoiceAction | null {
  // paint it gold / paint the wheels black / paint it in carbon fibre / skin it like a galaxy
  const verb = new RegExp(`^${SKIN_VERB}\\s+(.+)$`).exec(line);
  if (verb) {
    const rest = verb[1]!;
    const prep = SKIN_PREP.exec(rest);
    if (prep && prep.index > 0) {
      const target = rest.slice(0, prep.index);
      if (new RegExp(`^(?:${PRONOUN}|the [a-z0-9' -]+|its [a-z0-9' -]+)$`).test(target)) return skin(rest.slice(prep.index + prep[0].length), partOf(target));
    }
    const pro = new RegExp(`^${PRONOUN}\\s+(.+)$`).exec(rest);
    if (pro) return skin(pro[1]!, null);
    const noun = /^the ([a-z0-9-]+(?:'s [a-z0-9-]+)?)\s+(.+)$/.exec(rest);
    if (noun) return skin(noun[2]!, partOf(`the ${noun[1]}`));
    return null;
  }
  // make it look like a galaxy / make the wheels look like wood
  const looks = new RegExp(`^make\\s+(${PRONOUN}|the [a-z0-9' -]+?)\\s+looks?\\s+(?:like\\s+)?(.+)$`).exec(line);
  if (looks) return skin(looks[2]!, partOf(looks[1]!));
  // make it gold (but "make it bigger" is still an object request)
  const make = new RegExp(`^make\\s+${PRONOUN}\\s+(.+)$`).exec(line);
  if (make && !NOT_A_LOOK.test(make[1]!)) return skin(make[1]!, null);
  // give it a galaxy skin / give the wheels a chrome finish
  const give = new RegExp(`^give\\s+(${PRONOUN}|the [a-z0-9' -]+?)\\s+(?:a|an|some)\\s+(.+?)\\s+(?:skin|texture|finish|look|paint job|livery|paint|wrap|coat)$`).exec(line);
  if (give) return skin(give[2]!, partOf(give[1]!));
  return null;
}

function parseUnskin(line: string): VoiceAction | null {
  const m =
    /^(?:remove|clear|take off|strip|wipe|delete|lose|get rid of)\s+(?:the|its|that|this)?\s*(?:skin|paint|texture|wrap|livery|paint job)(?:\s+off)?(?:\s+(?:from|on|off)\s+(.+))?$/.exec(line) ??
    /^take\s+(?:the|its)\s+(?:skin|paint|texture|wrap)\s+off(?:\s+(?:of\s+)?(.+))?$/.exec(line) ??
    /^(?:no skin|unskin(?: it)?|unpaint(?: it)?|make it plain(?: again)?)()$/.exec(line);
  if (!m) return null;
  const target = m[1]?.trim();
  return { type: 'unskin', part: target ? partOf(target) : null };
}

// ---- Pick and place ------------------------------------------------------------------------

function pickTarget(t: string | undefined): string | null {
  const word = (t ?? '').trim().replace(/^(?:the|that|this|a|an)\s+/, '');
  return !word || /^(?:it|that|this|that one|this one|one|object|thing)$/.test(word) ? null : word;
}

/** A pick names one thing: a longer sentence ("grab the cube and lift it higher") is for the chat brain. */
const NOT_ONE_THING = /\b(?:and|then|lift|move|put|place|set|up|down|left|right|higher|lower|drop|paint|make)\b/;

function parsePick(line: string): VoiceAction | null {
  if (NOT_ONE_THING.test(line.replace(/^pick\s+up\b/, '').replace(/\bup$/, ''))) return null;
  let m = /^pick\s+up(?:\s+(.+))?$/.exec(line);
  if (m) return { type: 'pick', target: pickTarget(m[1]) };
  m = /^pick\s+(it|that|this|the [a-z0-9' -]+?)\s+up$/.exec(line);
  if (m) return { type: 'pick', target: pickTarget(m[1]) };
  m = /^(?:grab|fetch|get|take|grip)\s+(the [a-z0-9' -]+|that one|this one)$/.exec(line);
  if (m) return { type: 'pick', target: pickTarget(m[1]) };
  return null;
}

function parsePlace(line: string): VoiceAction | null {
  if (/^(?:put|set|place|lay|bring)\s+(?:it|that|this|the [a-z0-9' -]+?)\s+(?:back\s+)?(?:down|on the floor|on the ground|on the pad|back)(?:\s+(?:again|gently))?$/.test(line)) return { type: 'place' };
  if (/^(?:put|set|place|lay)\s+(?:down|back)(?:\s+(?:it|the [a-z0-9' -]+))?$/.test(line)) return { type: 'place' };
  if (/^place it$/.test(line)) return { type: 'place' };
  return null;
}

// ---- Moves ---------------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
};
const NUMWORD = `(?:twenty[ -](?:one|two|three|four|five|six|seven|eight|nine)|${Object.keys(NUMBER_WORDS).join('|')})`;
const UNIT = '(?:mm|millimet(?:er|re)s?|cm|cms|centimet(?:er|re)s?|centis?|m|met(?:er|re)s?|inch|inches)';
const NUMBER = `(?:\\d+(?:\\.\\d+)?|${NUMWORD}(?: and a half)?|one and a half|half an?|a couple of|a few)`;
/** to/too (2) and for (4) are speech-to-text mishearings, taken only right before a unit; "a" or "an" before a unit is 1. */
const NUMBER_BEFORE_UNIT = `(?:${NUMBER}|to|too|for|an?)`;
const QUAL_SMALL = '(?:a (?:little )?bit(?: more)?|a little(?: more)?|a tad|a touch|slightly|just a bit|a smidge|a hair)';
const QUAL_LARGE = '(?:a lot(?: more)?|a long way|far|way more|quite a bit|a good bit)';
const QUAL_ALL = '(?:all the way)';
const AMOUNT_LEAD = '(?:(?:by|about|around|another|roughly|maybe|like|some)\\s+)*';
const AMOUNT = `${AMOUNT_LEAD}(?:${QUAL_ALL}|${QUAL_SMALL}|${QUAL_LARGE}|${NUMBER_BEFORE_UNIT}\\s*${UNIT}\\b|\\d+(?:\\.\\d+)?|${NUMWORD})`;

const DIRECTIONS: [RegExp, MoveDirection][] = [
  [/^(?:up|upward|upwards|higher|up higher)$/, 'up'],
  [/^(?:down|downward|downwards|lower|down lower)$/, 'down'],
  [/^(?:(?:to|towards?) (?:the|your|my) )?left$/, 'left'],
  [/^(?:(?:to|towards?) (?:the|your|my) )?right$/, 'right'],
  [/^(?:forward|forwards|out|outward|outwards|ahead)$/, 'forward'],
  [/^(?:back|backward|backwards|in|inward|inwards)$/, 'back'],
  [/^(?:toward me|towards me|closer|closer to me|nearer|nearer to me|toward the camera|towards the camera)$/, 'toward'],
  [/^(?:away from me|away|further|farther|further away|farther away|away from the camera)$/, 'away'],
];
const DIRECTION_WORDS =
  '(?:(?:(?:to|towards?) (?:the|your|my) )?(?:left|right)|up higher|upwards?|up|higher|down lower|downwards?|down|lower|forwards?|outwards?|out|ahead|backwards?|back|inwards?|in|towards? me|closer to me|closer|nearer to me|nearer|towards? the camera|away from me|away from the camera|further away|farther away|away|further|farther)';
const VERB = '(?:move|go|shift|slide|nudge|bring|head|step|swing|come|take|push|pull|scoot|inch)';
const OBJ = '(?:it|the arm|the gripper|the jaw|the claw|the hand|yourself|the robot|over)';
const IMPLIED: Record<string, MoveDirection> = { raise: 'up', lift: 'up', lower: 'down' };

const MOVE_RE = new RegExp(
  `^(?:(?<verb>${VERB})\\s+)?(?:(?<implied>raise|lift|lower)\\s*)?(?:${OBJ}\\s*)*(?:(?<a1>${AMOUNT})\\s+)?(?:(?:over|more)\\s+)?(?<dir>${DIRECTION_WORDS})?(?:\\s+(?<a2>${AMOUNT}))?(?:\\s+(?:more|further|again))?$`,
);

function amountCm(phrase: string): { cm: number; amount: 'said' | 'small' | 'large' } | null {
  const p = phrase.replace(new RegExp(`^${AMOUNT_LEAD}`), '').trim();
  if (new RegExp(`^${QUAL_ALL}$`).test(p)) return { cm: 30, amount: 'large' };
  if (new RegExp(`^${QUAL_SMALL}$`).test(p)) return { cm: 2, amount: 'small' };
  if (new RegExp(`^${QUAL_LARGE}$`).test(p)) return { cm: 10, amount: 'large' };
  const m = new RegExp(`^(${NUMBER_BEFORE_UNIT})\\s*(${UNIT})?$`).exec(p);
  if (!m) return null;
  const numText = m[1]!;
  const unit = m[2] ?? null;
  if (!unit && /^(?:to|too|for|an?|half an?|a couple of|a few)$/.test(numText)) return null;
  let value: number;
  if (/^\d/.test(numText)) value = Number(numText);
  else if (numText === 'to' || numText === 'too') value = 2;
  else if (numText === 'for') value = 4;
  else if (numText === 'a' || numText === 'an') value = 1;
  else if (/^half an?$/.test(numText)) value = 0.5;
  else if (numText === 'a couple of') value = 2;
  else if (numText === 'a few') value = 3;
  else {
    const half = numText.endsWith(' and a half');
    const parts = numText.replace(/ and a half$/, '').split(/[ -]/);
    value = parts.reduce((sum, w) => sum + (NUMBER_WORDS[w] ?? NaN), 0) + (half ? 0.5 : 0);
  }
  if (!Number.isFinite(value)) return null;
  const u = unit ?? 'cm';
  const scale = /^(?:mm|millimet)/.test(u) ? 0.1 : /^(?:cm|cms|centi)/.test(u) ? 1 : /^inch/.test(u) ? 2.54 : 100;
  return { cm: Math.round(value * scale * 1000) / 1000, amount: 'said' };
}

function directionOf(phrase: string): MoveDirection | null {
  for (const [re, dir] of DIRECTIONS) if (re.test(phrase)) return dir;
  return null;
}

/** A move: verb, amount and direction in the shapes people say them. Null when the line is not a move. */
function parseMove(line: string): VoiceAction | null {
  const m = MOVE_RE.exec(line);
  if (!m?.groups) return null;
  const { verb, implied, a1, dir, a2 } = m.groups;
  if (a1 && a2) return null;
  const direction = dir ? directionOf(dir) : implied ? IMPLIED[implied]! : null;
  if (!direction) return null;
  const said = a1 ?? a2;
  const amount = said ? amountCm(said) : null;
  if (said && !amount) return null;
  const hasVerb = Boolean(verb || implied);
  // "right", "all right", "go back", "come back" are conversation, not moves.
  if (!hasVerb && !amount && direction !== 'up' && direction !== 'down') return null;
  if (!amount && (verb === 'go' || verb === 'come') && direction === 'back') return null;
  if (amount) return { type: 'move', direction, cm: amount.cm, amount: amount.amount };
  if (verb === 'nudge' || verb === 'inch' || verb === 'scoot') return { type: 'move', direction, cm: 2, amount: 'small' };
  return { type: 'move', direction, cm: 5, amount: 'default' };
}

/** What the console says for "help". */
export const HELP_LINE =
  'Say stop, home, open, close, move left 5 centimetres, go up a bit, pick it up, put it down, paint it gold, Moon or Mars, or make and an object.';

/** The voice panel's text box hint. */
export const VOICE_PLACEHOLDER = 'Or type: move left 5 cm, pick it up, paint it gold, stop';
