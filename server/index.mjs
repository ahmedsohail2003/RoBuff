// The key server: the only place the Gemini and ElevenLabs keys live. The browser never sees
// them. Routes:
//   GET  /api/health  -> { ok, gemini: 'configured'|'missing', elevenlabs: 'configured'|'missing', ... }
//   POST /api/spec    { text }  -> Gemini structured output: { source, model, intent, gravity, spec, latency_ms }
//   POST /api/tts     { text (<= 160 chars), fixed? } -> ElevenLabs mp3 stream; fixed lines cached on disk
//   POST /api/chat    { text, history (last 6 turns), state: { mode, gravity, lastObject, stopped, object?, holding?, gripper_cm? } }
//                     -> Gemini structured output: { source, model, reply (<= 200 chars), actions: [{ type, value?, part? }] (<= 3),
//                        action: actions[0] (for older pages), latency_ms }
// Keys come from web/.env (or the process environment). Their values are never logged or sent back.
// Run: node server/index.mjs   (port 8787 on 127.0.0.1; PORT and HOST override)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createLimits, isAllowedOrigin } from './limits.mjs';
import { createSkinRoutes } from './skin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GEMINI_MODEL = 'gemini-3.8-flash';
export const TTS_MODEL = 'eleven_flash_v2_5';
export const TTS_MAX_CHARS = 160;
export const SPEC_MAX_CHARS = 300;
const BODY_MAX_BYTES = 4096;
const UPSTREAM_TIMEOUT_MS = 10_000;
/** A spec with parts is a longer answer: measured 7.9 to 9.9 s live (2026-11-07), and one plane request passed 10 s. */
const SPEC_TIMEOUT_MS = 20_000;

export const COMMAND_SCHEMA = JSON.parse(readFileSync(path.join(HERE, 'commandSchema.json'), 'utf8'));
const SPEC_FIELDS = ['kind', 'name', 'width_mm', 'depth_mm', 'height_mm', 'roughness', 'lumpiness', 'seed', 'material', 'color', 'parts', 'why'];

const SYSTEM_PROMPT = [
  'You read one line typed or spoken by the operator of a simulated robot arm and answer with JSON only.',
  'intent spawn: the operator wants an object made. Describe it with the object fields. Quote the size they asked for, even if it is far too big: a validator rescales or refuses it, not you.',
  'intent set_gravity: they want Earth, Mars, Moon, Bennu or orbit gravity; put it in gravity.',
  'intent home: send the arm to its home pose. intent help: they ask what they can say. intent none: anything else.',
  'You can never stop or resume the arm; the browser handles stop itself. For any intent but spawn, fill the object fields with any valid values.',
  'Kinds: box for simple one-colour boxy things (cubes, plain blocks, crates, books, phones); its lumpiness rounds the edges, 0 sharp; give depth_mm when it is not square from above.',
  'cylinder for cans, bottles, wheels and pucks. sphere for balls, oranges and marbles. cone for cones and funnels. assembly for recognisable things built from parts, below.',
  'asteroid, panel, dish, bus and fragment are only for space things: rocks and asteroids, solar panels, antennas, satellites, debris.',
  'Use the colour the thing usually has, as #rrggbb.',
  'Any physical thing, a brand, a vehicle or a game item included, gets the closest kind and proportions.',
  'When the kind only approximates the thing, start why with "Approximated:" and say what, for example "Approximated: a skateboard from 7 simple parts."',
  'why is one short plain sentence.',
].join(' ');

/** How to build a recognisable thing from parts. Sent with every spec call, so voice and panel build the same objects. */
const PARTS_PROMPT = [
  'Always give name: a short display name of the thing asked for, such as "electric guitar", "helicopter" or "skateboard".',
  'Recognisable everyday or technical things (a rifle, a plane, a car, a mug, a chair, a rocket, a satellite, a guitar, a robot) get kind assembly with 3 to 8 coloured parts at real-world size in millimetres. Never shrink them yourself: the validator rescales the whole object.',
  'Each part has name, shape (box, cylinder, sphere or cone), size_mm, pos_mm (the part centre; x along the length, y across, z up, the object resting on z = 0), optional rot_deg (degrees about x, then y, then z) and its own color.',
  'size_mm: box is length, width, height; cylinder is diameter, diameter, length along its own axis, which is z before rotation, so rot_deg [0, 90, 0] lays it along x and [90, 0, 0] along y; sphere is three diameters; cone is base diameter, base diameter, height.',
  'Parts touch or overlap so the object is one piece. width_mm is the overall length and height_mm the overall height. Material aluminium for most made things.',
  'Choose the parts that make the thing recognisable from the side and from above: its main body, then what sticks out (barrels, wings, fins, handles, wheels, legs, rotors), each in its own colour, at its real place and proportion.',
  'Example electric guitar: body box [450, 330, 50] at [-230, 0, 25] #b22222; neck box [480, 55, 25] at [235, 0, 30] maple #c8a165; headstock box [180, 80, 18] at [560, 0, 30] #c8a165.',
  'Example helicopter: cabin sphere [3000, 2400, 2400] at [0, 0, 1500] in the livery colour; tail boom cylinder [500, 500, 6000] at [-4200, 0, 1900] rot [0, 90, 0]; main rotor box [11000, 300, 100] at [0, 0, 2800] #333333; tail fin box [900, 150, 1400] at [-7000, 0, 2400].',
  'Example skateboard: deck box [800, 210, 15] at [0, 0, 72] #2e2e2e; two truck boxes [40, 180, 30] at [280, 0, 50] and [-280, 0, 50] #9a9a9a; four wheel cylinders [54, 54, 40] rot [90, 0, 0] at [280, 75, 27], [280, -75, 27], [-280, 75, 27] and [-280, -75, 27], #f2f2f2.',
  'A thing whose colour changes by layer or face (an iced cake, a block with a different top, a two-tone crate) is an assembly with one part per colour: for example an iced cake is a sponge cylinder [240, 240, 90] at [0, 0, 45] #e8c27a with an icing cylinder [244, 244, 14] at [0, 0, 97] #fff4f0 on top.',
  'Simple single shapes of one colour keep their own kinds and no parts: a ball is sphere, a can is cylinder, a one-colour cube or block is box. Space things keep the space kinds.',
].join(' ');

/** Added when the line comes from the object panel, where every line is an object to make. */
const OBJECT_MODE_PROMPT =
  'This line was typed into the object panel: every line there is an object to make, so the intent is spawn, even for a brand, a vehicle, a game item or a vague word. Never answer none.';

/** KEY=VALUE lines; # comments; optional quotes. Values are returned, never printed. */
export function readEnvFile(file) {
  const out = {};
  if (!file || !existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/** The process environment wins over the file, so a deployment can set keys without a file. */
export function loadConfig(envFile = process.env.AFTERGRIP_ENV_FILE ?? path.join(HERE, '..', 'web', '.env')) {
  const file = readEnvFile(envFile);
  const pick = (name) => (process.env[name] ?? file[name] ?? '').trim();
  return {
    geminiKey: pick('GEMINI_API_KEY'),
    elevenKey: pick('ELEVENLABS_API_KEY'),
    voiceId: pick('ELEVENLABS_VOICE_ID'),
    allowedOrigins: pick('ALLOWED_ORIGINS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendText(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(message);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_MAX_BYTES) throw new HttpError(413, `The request body is over ${BODY_MAX_BYTES} bytes.`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'The request body is not JSON.');
  }
}

function requestText(body, max) {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) throw new HttpError(400, 'Send JSON with a non-empty "text".');
  if (text.length > max) throw new HttpError(400, `"text" is ${text.length} characters; the limit is ${max}.`);
  return text;
}

/** JSON Schema for responseJsonSchema: everything but propertyOrdering, which is Gemini's own keyword. */
function jsonSchemaVariant(schema) {
  const { propertyOrdering: _ordering, ...rest } = schema;
  void _ordering;
  return rest;
}

/** The older responseSchema field takes OpenAPI-style upper-case type names. */
function openApiVariant(node) {
  if (Array.isArray(node)) return node.map(openApiVariant);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) out[key] = key === 'type' && typeof value === 'string' ? value.toUpperCase() : openApiVariant(value);
  return out;
}

/** One Gemini structured-output call. Returns the parsed JSON object. */
async function askGemini(key, text, fetchImpl, objectMode = false) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const system = `${SYSTEM_PROMPT} ${PARTS_PROMPT}${objectMode ? ` ${OBJECT_MODE_PROMPT}` : ''}`;
  const call = (generationConfig) =>
    fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(SPEC_TIMEOUT_MS),
    });
  let res = await call({ responseMimeType: 'application/json', responseJsonSchema: jsonSchemaVariant(COMMAND_SCHEMA), temperature: 0.4 });
  // Not run live yet (no key today): if this model rejects responseJsonSchema, try the older field once.
  if (res.status === 400) res = await call({ responseMimeType: 'application/json', responseSchema: openApiVariant(COMMAND_SCHEMA), temperature: 0.4 });
  if (!res.ok) throw new HttpError(502, `Gemini answered HTTP ${res.status}, so the app falls back to its offline mock.`);
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const out = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
  try {
    return JSON.parse(out);
  } catch {
    throw new HttpError(502, 'Gemini did not return JSON, so the app falls back to its offline mock.');
  }
}

// ---- Live talk: POST /api/chat ----------------------------------------------------------------

export const CHAT_REPLY_MAX_CHARS = 200;
export const CHAT_HISTORY_TURNS = 6;
/** What a chat answer can make the app do, in order, at most CHAT_MAX_ACTIONS per turn. The browser keeps the same list (web/src/voice/liveTalk.ts). */
export const CHAT_ACTIONS = ['move', 'grip', 'pick', 'place', 'release', 'home', 'gravity', 'mode', 'spawn', 'skin', 'unskin', 'none'];
export const CHAT_MAX_ACTIONS = 3;
/** Directions a move value may start with; the browser re-parses the whole value with its own grammar. */
export const CHAT_MOVE_DIRECTIONS = ['left', 'right', 'up', 'down', 'forward', 'back', 'toward me', 'away from me'];
/** Actions that move the arm or the jaw: never while the stop latch is set. */
const CHAT_ARM_ACTIONS = ['move', 'grip', 'pick', 'place', 'release', 'home', 'spawn'];
const CHAT_GRAVITY = ['earth', 'mars', 'moon', 'bennu', 'orbit'];
/** The delay panel's modes (web/src/delay/dualSim.ts DELAY_MODES). */
const CHAT_MODES = ['direct', 'moon_ghost_off', 'moon_ghost_on'];

export const CHAT_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'What RoBuff mission control says aloud: at most 200 characters, one or two sentences.' },
    actions: {
      type: 'array',
      description: 'What the app does, in the order it should happen: at most 3. Use [{"type":"none"}] for questions and chat.',
      maxItems: CHAT_MAX_ACTIONS,
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: CHAT_ACTIONS },
          value: {
            type: 'string',
            description:
              'move: a direction and distance such as "left 5 cm", "up 2 cm" or "toward me 3 cm"; grip: open or close; pick: what to pick up; spawn: a short description of the object; gravity: earth, mars, moon, bennu or orbit; mode: direct, moon_ghost_off or moon_ghost_on; skin: the look, such as "gold" or "carbon fibre".',
          },
          part: { type: 'string', description: 'skin and unskin only: one part name from state.object.partNames, or leave it out for the whole object.' },
        },
        required: ['type'],
        propertyOrdering: ['type', 'value', 'part'],
      },
    },
  },
  required: ['reply', 'actions'],
  propertyOrdering: ['reply', 'actions'],
};

/**
 * The gravity numbers are the app's own presets (web/src/objects/limits.ts GRAVITY); a test checks
 * they match. They are the only numbers the model may quote besides those in the state.
 */
export const CHAT_SYSTEM_PROMPT = [
  'You are RoBuff mission control, the voice of RoBuff: a robot arm that exists only in a browser simulation (MuJoCo physics). The operator talks to you hands-free and hears your reply spoken aloud.',
  'Answer with JSON only: reply and actions.',
  'reply: at most 200 characters, one or two short sentences, friendly and plain, no lists, no markdown, no emoji.',
  'Be honest: everything here is simulated. Say "in simulation" when you speak of what the arm or an object did or will do, and never claim a real arm.',
  'Never invent numbers. Quote only numbers from the state or from these facts: gravity presets in this app, in metres per second squared, Earth 9.82, Mars 3.73, Moon 1.62, Bennu 0.000083 (an asteroid; calculated from JPL data), orbit 0 in the simulation. In the Earth-Moon delay modes the operator sees the arm as it was 1.28 seconds ago (simulated). If you do not know a number, say so.',
  'Vary your wording and do not repeat an earlier reply. Talk about what they asked.',
  'actions is what the app does, in the order it should happen, at most 3. The app checks each one again and runs them through the same handlers as the voice grammar.',
  'You can drive the arm: move, with value a direction and a distance, where the direction is left, right, up, down, forward, back, toward me or away from me and the distance is in cm (for example "left 5 cm"; "a bit" is 2 cm, no amount is 5 cm, at most 30 cm). grip, with value open or close. pick picks up the object in the slot (state.object) with the lift test\'s grasp and checks both jaws; value is what they named. place puts down what the arm holds (state.holding). release opens the jaw and drops it. home sends the arm to its home pose.',
  'You can dress the object: skin, with value the look they asked for (a colour, a material or a picture in words) and part only when they named one of state.object.partNames; it only paints, mass, friction and shape stay the same. unskin removes the skin, with part for one part.',
  'spawn, with value a short plain description of the object such as "a tennis ball", when they want a new object made; the app checks it against the arm\'s limits and runs a simulated lift test, so say it will be checked, never that it fits. gravity, with value earth, mars, moon, bennu or orbit. mode, with value direct, moon_ghost_off or moon_ghost_on, for the Earth-Moon delay (moon_ghost_on adds the predicted ghost arm). none for questions and chat.',
  'There is one object slot: if they name a different object than state.object, say what is in the slot and offer to make theirs.',
  'You can never stop or resume the arm: the app handles stop itself and only the on-screen Resume button clears it. When state.stopped is true, use no arm action (no move, grip, pick, place, release, home or spawn) and say Resume is on screen.',
].join(' ');

/** At most max characters: whole sentences if they fit, else whole words. */
export function clipReply(text, max = CHAT_REPLY_MAX_CHARS) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence > max * 0.4) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[,;:]$/, '')}.`;
}

/** A move value the browser can re-parse: a listed direction, then an optional amount in cm, mm or words, at most 30 cm. */
export function cleanMoveValue(raw) {
  const text = String(raw ?? '').toLowerCase().replace(/[^a-z0-9. ]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:move|go)\s+/, '');
  const direction = CHAT_MOVE_DIRECTIONS.find((d) => text === d || text.startsWith(`${d} `));
  if (!direction) return null;
  const rest = text.slice(direction.length).trim().replace(/^by\s+/, '');
  if (!rest) return direction;
  if (/^(?:a bit|a little|slightly|a lot|all the way)$/.test(rest)) return `${direction} ${rest}`;
  const amount = /^(\d+(?:\.\d+)?)\s*(cm|mm|centimetres?|centimeters?|millimetres?|millimeters?)?$/.exec(rest);
  if (!amount) return null;
  const cm = Number(amount[1]) * (/^m/.test(amount[2] ?? '') ? 0.1 : 1);
  if (!Number.isFinite(cm) || cm < 0.5) return null;
  return `${direction} ${Math.round(Math.min(30, cm) * 10) / 10} cm`;
}

/** The part a skin action names, kept only when it is one of the object's own part names. */
function cleanPart(raw, state) {
  const part = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 24) : '';
  if (!part) return null;
  const names = (state?.object?.partNames ?? []).map((n) => String(n).toLowerCase());
  const singular = part.replace(/s$/, '');
  return names.some((n) => n === part || n.replace(/s$/, '').startsWith(singular) || n.includes(singular)) ? part : null;
}

/** A model action the app can run, or none. state is the cleaned chat state (for skin parts). */
export function cleanChatAction(raw, state = null) {
  const type = CHAT_ACTIONS.includes(raw?.type) ? raw.type : 'none';
  const value = typeof raw?.value === 'string' ? raw.value.trim().slice(0, 200) : '';
  if (type === 'spawn' && value) return { type, value };
  if (type === 'gravity' && CHAT_GRAVITY.includes(value.toLowerCase())) return { type, value: value.toLowerCase() };
  if (type === 'mode' && CHAT_MODES.includes(value)) return { type, value };
  if (type === 'home' || type === 'place' || type === 'release') return { type };
  if (type === 'move') {
    const move = cleanMoveValue(value);
    return move ? { type, value: move } : { type: 'none' };
  }
  if (type === 'grip' && ['open', 'close'].includes(value.toLowerCase())) return { type, value: value.toLowerCase() };
  if (type === 'pick') return value ? { type, value: value.slice(0, 60) } : { type };
  if (type === 'skin' && value) {
    const part = cleanPart(raw?.part, state);
    return part ? { type, value: value.slice(0, 120), part } : { type, value: value.slice(0, 120) };
  }
  if (type === 'unskin') {
    const part = cleanPart(raw?.part, state);
    return part ? { type, part } : { type };
  }
  return { type: 'none' };
}

/**
 * The model's action list, cleaned: each action checked, none dropped, at most 3, and no arm
 * action while the stop latch is set. An older single `action` is read as a list of one.
 */
export function cleanChatActions(raw, state = null) {
  const list = Array.isArray(raw?.actions) ? raw.actions : raw?.action ? [raw.action] : [];
  const stopped = state?.stopped === true;
  const actions = list
    .slice(0, 6)
    .map((a) => cleanChatAction(a, state))
    .filter((a) => a.type !== 'none' && !(stopped && CHAT_ARM_ACTIONS.includes(a.type)))
    .slice(0, CHAT_MAX_ACTIONS);
  return actions.length ? actions : [{ type: 'none' }];
}

/** The state the browser sent, trimmed to what the prompt needs: unknown fields are dropped. */
export function cleanChatState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const state = {
    mode: CHAT_MODES.includes(s.mode) ? s.mode : 'direct',
    gravity: CHAT_GRAVITY.includes(s.gravity) ? s.gravity : 'earth',
    lastObject: typeof s.lastObject === 'string' && s.lastObject.trim() ? s.lastObject.trim().slice(0, 120) : null,
    stopped: s.stopped === true,
  };
  const o = s.object && typeof s.object === 'object' ? s.object : null;
  if (o && typeof o.name === 'string' && o.name.trim()) {
    state.object = {
      name: o.name.trim().slice(0, 40),
      partNames: (Array.isArray(o.partNames) ? o.partNames : []).filter((n) => typeof n === 'string' && n.trim()).slice(0, 8).map((n) => n.trim().slice(0, 24)),
    };
    if (typeof o.skin === 'string' && o.skin.trim()) state.object.skin = o.skin.trim().slice(0, 60);
  }
  if (typeof s.holding === 'boolean') state.holding = s.holding;
  if (Array.isArray(s.gripper_cm) && s.gripper_cm.length === 3 && s.gripper_cm.every((v) => Number.isFinite(v))) state.gripper_cm = s.gripper_cm.map((v) => Math.round(v * 10) / 10);
  return state;
}

/** The state and history the browser sent, trimmed to what the prompt needs. */
function chatPrompt(body, text) {
  const state = cleanChatState(body?.state);
  const history = (Array.isArray(body?.history) ? body.history : [])
    .filter((t) => t && (t.role === 'user' || t.role === 'robuff') && typeof t.text === 'string' && t.text.trim())
    .slice(-CHAT_HISTORY_TURNS)
    .map((t) => `${t.role === 'user' ? 'Operator' : 'RoBuff'}: ${t.text.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
  return [history.length ? `Earlier turns:\n${history.join('\n')}` : 'No earlier turns.', `State: ${JSON.stringify(state)}`, `Operator now: ${text}`].join('\n\n');
}

/** One Gemini structured-output call for live talk. Returns the parsed JSON object. */
async function askGeminiChat(key, prompt, fetchImpl) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const call = (generationConfig) =>
    fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: CHAT_SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  // A higher temperature than the spec call: the replies should not sound the same every time.
  let res = await call({ responseMimeType: 'application/json', responseJsonSchema: jsonSchemaVariant(CHAT_SCHEMA), temperature: 0.8 });
  if (res.status === 400) res = await call({ responseMimeType: 'application/json', responseSchema: openApiVariant(CHAT_SCHEMA), temperature: 0.8 });
  if (!res.ok) throw new HttpError(502, `Gemini answered HTTP ${res.status}, so live talk knows only the offline commands for now.`);
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const out = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
  try {
    return JSON.parse(out);
  } catch {
    throw new HttpError(502, 'Gemini did not return JSON, so live talk knows only the offline commands for now.');
  }
}

/**
 * @param {{ config?: ReturnType<typeof loadConfig>, limits?: ReturnType<typeof createLimits>, fetchImpl?: typeof fetch,
 *   cacheDir?: string, skinCacheDir?: string, log?: (line: string) => void }} [options]
 */
export function createAppServer(options = {}) {
  const config = options.config ?? loadConfig();
  const limits = options.limits ?? createLimits();
  const fetchImpl = options.fetchImpl ?? fetch;
  const cacheDir = options.cacheDir ?? path.join(HERE, '..', 'web', '.voice-cache');
  const log = options.log ?? ((line) => console.log(line));
  const gemini = config.geminiKey ? 'configured' : 'missing';
  const elevenlabs = config.elevenKey && config.voiceId ? 'configured' : 'missing';
  const skin = createSkinRoutes({ config, limits, fetchImpl, cacheDir: options.skinCacheDir });

  function health() {
    const body = { ok: true, server: 'robuff key server', gemini, elevenlabs, skin: skin.status, models: { spec: GEMINI_MODEL, tts: TTS_MODEL, ...skin.models }, limits: limits.snapshot() };
    if (config.elevenKey && !config.voiceId) body.elevenlabs_note = 'ELEVENLABS_API_KEY is set but ELEVENLABS_VOICE_ID is not.';
    return body;
  }

  async function spec(req, res) {
    if (gemini === 'missing') throw new HttpError(503, 'Gemini is not configured on this server (no GEMINI_API_KEY), so the app uses its offline mock.');
    const body = await readJsonBody(req);
    const text = requestText(body, SPEC_MAX_CHARS);
    // mode 'object': the object panel, where every line is an object. Voice and typed commands
    // send no mode and keep their intents (gravity, home, help, none).
    const objectMode = body?.mode === 'object';
    if (!limits.takeSpec()) throw new HttpError(429, "Today's Gemini cap is used up, so the app uses its offline mock until midnight.");
    const t0 = performance.now();
    const raw = await askGemini(config.geminiKey, text, fetchImpl, objectMode);
    const latency_ms = Math.round(performance.now() - t0);
    const asked = ['spawn', 'set_gravity', 'home', 'help', 'none'].includes(raw?.intent) ? raw.intent : 'none';
    const intent = objectMode ? 'spawn' : asked;
    const gravity = ['earth', 'mars', 'moon', 'bennu', 'orbit'].includes(raw?.gravity) ? raw.gravity : null;
    const objectSpec = intent === 'spawn' ? Object.fromEntries(SPEC_FIELDS.map((k) => [k, raw?.[k]])) : null;
    sendJson(res, 200, { source: 'gemini', model: GEMINI_MODEL, intent, gravity, spec: objectSpec, latency_ms });
  }

  async function chat(req, res) {
    if (gemini === 'missing') throw new HttpError(503, 'Gemini is not configured on this server (no GEMINI_API_KEY), so live talk knows only the offline commands.');
    const body = await readJsonBody(req);
    const text = requestText(body, SPEC_MAX_CHARS);
    if (!limits.takeSpec()) throw new HttpError(429, "Today's Gemini cap is used up, so live talk knows only the offline commands until midnight.");
    const t0 = performance.now();
    const raw = await askGeminiChat(config.geminiKey, chatPrompt(body, text), fetchImpl);
    const latency_ms = Math.round(performance.now() - t0);
    const reply = clipReply(raw?.reply);
    if (!reply) throw new HttpError(502, 'Gemini sent no reply, so live talk knows only the offline commands for now.');
    const actions = cleanChatActions(raw, cleanChatState(body?.state));
    // action = actions[0] keeps pages built before the action list working.
    sendJson(res, 200, { source: 'gemini', model: GEMINI_MODEL, reply, actions, action: actions[0], latency_ms });
  }

  async function tts(req, res) {
    if (elevenlabs === 'missing') throw new HttpError(503, 'ElevenLabs is not configured on this server (no ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID), so the app uses the browser voice.');
    const body = await readJsonBody(req);
    const text = requestText(body, TTS_MAX_CHARS);
    const fixed = body.fixed === true;
    const file = path.join(cacheDir, `${createHash('sha256').update(`${config.voiceId}|${TTS_MODEL}|${text}`).digest('hex')}.mp3`);
    if (fixed && existsSync(file)) {
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'x-voice-cache': 'hit', 'cache-control': 'no-store' });
      res.end(readFileSync(file));
      return;
    }
    if (!limits.takeTts(text.length)) throw new HttpError(429, "Today's ElevenLabs character cap is used up, so the app uses the browser voice until midnight.");
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voiceId)}/stream?output_format=mp3_44100_128`;
    const upstream = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/mpeg', 'xi-api-key': config.elevenKey },
      body: JSON.stringify({ text, model_id: TTS_MODEL }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!upstream.ok || !upstream.body) throw new HttpError(502, `ElevenLabs answered HTTP ${upstream.status}, so the app uses the browser voice.`);
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'x-voice-cache': fixed ? 'miss' : 'off', 'cache-control': 'no-store' });
    const chunks = [];
    const stream = Readable.fromWeb(upstream.body);
    stream.on('data', (chunk) => {
      if (fixed) chunks.push(chunk);
    });
    stream.on('end', () => {
      if (!fixed) return;
      try {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(file, Buffer.concat(chunks));
      } catch {
        // A cache write failure only costs a later call.
      }
    });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  return http.createServer(async (req, res) => {
    const t0 = performance.now();
    const route = (req.url ?? '').split('?')[0];
    // Method, route, status and time only: never bodies, headers or keys.
    res.on('finish', () => log(`${req.method} ${route} ${res.statusCode} ${Math.round(performance.now() - t0)} ms`));
    try {
      if (!isAllowedOrigin(req.headers.origin, config.allowedOrigins)) throw new HttpError(403, 'This origin may not use the key server.');
      if (req.method === 'GET' && route === '/api/health') sendJson(res, 200, health());
      else if (req.method === 'POST' && (route === '/api/spec' || route === '/api/tts' || route === '/api/chat')) {
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (!limits.allowRequest(ip)) throw new HttpError(429, 'Too many requests: the limit is 30 a minute. Try again shortly.');
        if (route === '/api/spec') await spec(req, res);
        else if (route === '/api/chat') await chat(req, res);
        else await tts(req, res);
      } else if (skin.handles(req.method, route)) await skin.handle(req, res, route);
      else throw new HttpError(404, 'Not found. Routes: GET /api/health, POST /api/spec, POST /api/tts, POST /api/chat, POST /api/skin, GET /api/skin/<hash>.jpg.');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error?.name === 'TimeoutError' ? 504 : 500;
      const message = error instanceof HttpError ? error.message : status === 504 ? 'The upstream service timed out.' : 'The key server hit an error.';
      if (!res.headersSent) sendText(res, status, message);
      else res.destroy();
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  const server = createAppServer();
  server.listen(port, host, () => {
    const config = loadConfig();
    console.log(
      `robuff key server on http://${host}:${port} | gemini ${config.geminiKey ? 'configured' : 'missing'} | elevenlabs ${config.elevenKey && config.voiceId ? 'configured' : 'missing'}`,
    );
  });
}
