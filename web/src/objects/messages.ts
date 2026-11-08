// The mission-console voice: what was measured, the arm's limit, and what was done.
// Plain sentences, one number at a time. Never just "invalid".
// Any line that mentions a lift says the proof comes from the simulated lift test.

import { say, sayGravityValue, sayLength, sayMass, sayMassLimit, sayMm } from './format';
import { GRAVITY, MAX_HULL_VERT } from './limits';
import type { Receipt } from './receipt';
import { displayName } from './skinUv';

export const LIFT_NOT_RUN_TEXT = 'lift test: not run yet';

/** A named gravity matches within half a percent, so MuJoCo's default 9.81 still reads as Earth (9.82 here). */
const GRAVITY_NAME_TOLERANCE = 0.005;

export function sayGravity(g: number): string {
  const named = (Object.keys(GRAVITY) as (keyof typeof GRAVITY)[]).find(
    (k) => GRAVITY[k] === g || (GRAVITY[k] > 0 && Math.abs(g - GRAVITY[k]) <= GRAVITY[k] * GRAVITY_NAME_TOLERANCE),
  );
  return named ? `${sayGravityValue(g)} m/s2 (${named[0]!.toUpperCase()}${named.slice(1)})` : `${sayGravityValue(g)} m/s2`;
}

/** What the grip needs: the squeeze part (pads off square) and the weight part. */
function frictionNeed(requiredMu: number, g: number, squeezeDeg: number | null, squeezeMu: number, weightMu: number): string {
  if (squeezeDeg === null || squeezeMu < 0.001) {
    return `At this weight and ${sayGravity(g)} my grip needs friction of at least ${say(requiredMu)}.`;
  }
  return `My pads meet it ${say(squeezeDeg)} degrees off square at best, so just holding it takes friction of at least ${say(squeezeMu)}, plus ${say(weightMu)} for its weight at ${sayGravity(g)}: ${say(requiredMu)} in all.`;
}

/** Model scale in words: "A 1:12 model, 74 mm long." Ratios are rounded to two significant figures. */
export function sayModelScale(scale: number, lengthMm: number, toy = false): string {
  const length = `${say(lengthMm)} mm long`;
  const model = toy ? 'toy model' : 'model';
  if (!(scale > 0) || Math.abs(scale - 1) < 0.005) return toy ? `A full-size ${model}, ${length}.` : `Built at full size, ${length}.`;
  if (scale > 1) return `Enlarged ${say(Number(scale.toPrecision(2)))} times, ${length}.`;
  const ratio = Number((1 / scale).toPrecision(2));
  return `A 1:${say(ratio)} ${model}, ${length}.`;
}

export const lines = {
  badMesh(problem: string, detail: string): string {
    return `This mesh ${problem}. ${detail} MuJoCo would reject it or get its mass wrong, so I stopped here and built nothing.`;
  },
  sanityOk(vertices: number): string {
    return `Mesh checks out: ${say(vertices)} vertices, all finite, with real volume.`;
  },
  decimated(vertices: number, kept: number): string {
    return `This mesh has ${say(vertices)} vertices. Collision only needs the outline, so I measure ${say(kept)} of them.`;
  },
  hullOk(volumeCm3: number, hullVertices: number): string {
    const start = `Convex hull: ${say(volumeCm3)} cubic centimetres from ${say(hullVertices)} points. My mass figure comes from it.`;
    return hullVertices <= MAX_HULL_VERT
      ? `${start} MuJoCo collides with this same hull.`
      : `${start} MuJoCo keeps at most ${MAX_HULL_VERT} of these points for its collision hull, so the shape it collides with is a little smaller.`;
  },
  /** The HULL_OK line once the object is compiled and MuJoCo's own collision hull has been measured. */
  hullMeasured(volumeCm3: number, hullVertices: number, mujocoVolumeCm3: number, mujocoVertices: number): string {
    const start = `Convex hull: ${say(volumeCm3)} cubic centimetres from ${say(hullVertices)} points. My mass figure comes from it.`;
    const smaller = ((volumeCm3 - mujocoVolumeCm3) / volumeCm3) * 100;
    if (Math.abs(smaller) < 0.05) return `${start} MuJoCo collides with the same hull (${say(mujocoVertices)} points, measured after loading).`;
    const direction = smaller > 0 ? `${sayMm(smaller)} percent smaller` : `${sayMm(-smaller)} percent larger`;
    return `${start} MuJoCo keeps at most ${MAX_HULL_VERT} points for collision, so the hull it collides with has ${say(mujocoVertices)} points and ${say(mujocoVolumeCm3)} cubic centimetres, ${direction} (measured after loading).`;
  },
  hullFill(percent: number): string {
    return `The hull fills ${say(percent)} percent more volume than the shape itself. My fingers may look like they hold air.`;
  },
  yawChosen(narrowMm: number, yaw: number, wideMm: number): string {
    return `Narrowest side: ${say(narrowMm)} millimetres with my jaw at ${say(yaw)} degrees. Widest: ${say(wideMm)}.`;
  },
  tooWide(acrossMm: number, narrowMm: number, limitMm: number, hardMm: number, bandName: string, finalNarrowMm: number, finalAcrossMm: number): string {
    const narrow = narrowMm < acrossMm * 0.98 ? `, ${say(narrowMm)} at its narrowest` : '';
    const limit = limitMm < hardMm ? `My jaw opens about ${say(hardMm)} millimetres, and I keep ${bandName} objects to ${say(limitMm)}.` : `My jaw opens about ${say(limitMm)} millimetres.`;
    return `That's ${sayLength(acrossMm)} across${narrow}. ${limit} I'll make a model of it ${say(finalNarrowMm)} millimetres at its narrowest and ${say(finalAcrossMm)} at its widest, same proportions.`;
  },
  tooSmall(narrowMm: number, limitMm: number, finalNarrowMm: number): string {
    return `That's only ${say(narrowMm)} millimetres at its narrowest. My jaw needs at least ${say(limitMm)} to get a grip. I'll make it ${say(finalNarrowMm)}, same proportions.`;
  },
  tooTall(heightMm: number, limitMm: number, finalHeightMm: number): string {
    return `It stands ${sayLength(heightMm)} tall. I can grip things up to ${say(limitMm)} millimetres tall. I'll make it ${say(finalHeightMm)} tall, same proportions.`;
  },
  tooShort(heightMm: number, limitMm: number, finalHeightMm: number): string {
    return `It's only ${say(heightMm)} millimetres tall. My fingertips stop about 4 millimetres above the floor, so I need at least ${say(limitMm)}. I'll make it ${say(finalHeightMm)} tall, same proportions.`;
  },
  tooLong(lengthMm: number, limitMm: number, finalLengthMm: number): string {
    return `It's ${sayLength(lengthMm)} long. The longest part I have evidence for is ${say(limitMm)} millimetres, gripped at the centre. I'll make it ${say(finalLengthMm)} long, same proportions.`;
  },
  outsideHandBand(): string {
    return `No size fits my hand-flown limits, so I used my hard limits instead. Hand-flying this one will take care.`;
  },
  scaleOk(narrowMm: number, heightMm: number): string {
    return `Size fits as asked: ${say(narrowMm)} millimetres at the jaw, ${say(heightMm)} tall. No rescale.`;
  },
  /** scale is the largest scale the upper limits allow: below 1 it shrinks the request, above 1 it enlarges it. */
  noSingleScale(lengthMm: number, limitText: string, floorText: string, scale: number): string {
    const sized = scale < 1 ? `Shrunk to fit ${limitText}` : scale > 1 ? `Even enlarged as far as ${limitText} allows` : `At the size asked, which already meets ${limitText}`;
    return `That's ${sayLength(lengthMm)} end to end. ${sized}, ${floorText}. No single scale satisfies both, so I can't grip it and built nothing. Want a stubby one?`;
  },
  massOk(label: string, volumeCm3: number, density: number, basis: string, massKg: number, limitKg: number, bandName: string): string {
    return `${label}: ${say(volumeCm3)} cubic centimetres at ${say(density)} g/cc ${basis} is ${sayMass(massKg)}, under my ${sayMassLimit(limitKg)} ${bandName} limit. That limit is for the simulated arm; a real arm's payload is unverified.`;
  },
  tooHeavy(label: string, massKg: number, limitKg: number, bandName: string, hardKg: number, suggestion: string): string {
    const hard = limitKg < hardKg ? ` (hard limit ${sayMass(hardKg)})` : '';
    return `${label} at this size is ${sayMass(massKg)}, over my ${sayMassLimit(limitKg)} ${bandName} limit${hard}. I won't build it this way. ${suggestion}`;
  },
  frictionOk(requiredMu: number, mu: number, g: number, squeezeDeg: number | null = null, squeezeMu = 0, weightMu = requiredMu): string {
    return `${frictionNeed(requiredMu, g, squeezeDeg, squeezeMu, weightMu)} This material has ${say(mu)}, enough.`;
  },
  slips(requiredMu: number, label: string, mu: number, g: number, squeezeDeg: number | null = null, squeezeMu = 0, weightMu = requiredMu): string {
    const why =
      mu < squeezeMu
        ? 'Squeezing would push it out of my fingers like a wet bar of soap, so I won\'t build it here. Lower gravity would not help.'
        : 'It will slide out of my fingers, so I won\'t build it here. At lower gravity it might hold.';
    return `${frictionNeed(requiredMu, g, squeezeDeg, squeezeMu, weightMu)} ${label} is ${say(mu)}. ${why}`;
  },
  gripOk(contactMm: number, sliceMm: number): string {
    return `My fingertips meet it ${say(contactMm)} millimetres up, where it's ${say(sliceMm)} across. That fits my jaw.`;
  },
  gripTooLow(heightMm: number, overlapMm: number, needMm: number): string {
    return `It's ${say(heightMm)} millimetres tall, so only ${say(overlapMm)} millimetres of my fingertip pads would touch it. I need ${say(needMm)}, so I won't build it.`;
  },
  laidDown(): string {
    return `Standing up, no size of it both fits my jaw and gives my fingertips a grip. So I laid it on its side, the way it would lie on a table.`;
  },
  /** "Built from 5 parts: stock, receiver, barrel, magazine, grip. ... A 1:12 model, 74 mm long." */
  parts(names: readonly string[], scale: number, lengthMm: number, toy = false): string {
    return `Built from ${say(names.length)} ${names.length === 1 ? 'part' : 'parts'}: ${names.join(', ')}. Each part is its own collision hull, so my fingers meet the real shape, not one box around it. ${sayModelScale(scale, lengthMm, toy)}`;
  },
  thickened(times: number): string {
    return `At real proportions my fingertips would not get a good grip on it at any size that fits. So this is a toy model: I made it ${say(times)} times thicker than real. Length and width keep the real proportions.`;
  },
  hullParts(count: number, mostPoints: number): string {
    return `Each of the ${say(count)} parts has its own convex hull, ${say(mostPoints)} points at most; my mass figure is the sum of their volumes. MuJoCo keeps at most ${MAX_HULL_VERT} points per part for collision.`;
  },
  /** The HULL_OK line for an assembly once MuJoCo has loaded every part's hull. */
  partHullsMeasured(count: number, volumeCm3: number, mujocoVolumeCm3: number, mujocoVertices: number): string {
    const smaller = volumeCm3 > 0 ? ((volumeCm3 - mujocoVolumeCm3) / volumeCm3) * 100 : 0;
    const diff = Math.abs(smaller) < 0.05 ? 'the same volume' : smaller > 0 ? `${sayMm(smaller)} percent smaller` : `${sayMm(-smaller)} percent larger`;
    return `MuJoCo collides with ${say(count)} part hulls, ${say(mujocoVertices)} points and ${say(mujocoVolumeCm3)} cubic centimetres in all: ${diff} than the ${say(volumeCm3)} my mass figure uses (measured after loading).`;
  },
  frictionOutline(angleDeg: number, squeezeMu: number, mu: number, weightMu: number): string {
    return `Its outline meets my pads ${say(angleDeg)} degrees off square, which would take friction of ${say(squeezeMu)}, and this material has ${say(mu)}. But my pads touch the parts themselves, not the outline, and its weight needs only ${say(weightMu)}. The simulated lift test on the real parts decides.`;
  },
  gripSlice(contactMm: number, sliceMm: number, minMm: number, maxMm: number): string {
    return `Where my fingertips meet it, ${say(contactMm)} millimetres up, it's ${say(sliceMm)} across. My jaw works from ${say(minMm)} to ${say(maxMm)}, so I won't build it.`;
  },
  liftNotRun(refused: boolean): string {
    return refused
      ? `${LIFT_NOT_RUN_TEXT}. Not worth trying: a check above already refused it, and only the simulated lift test can prove a lift.`
      : `${LIFT_NOT_RUN_TEXT}. The checks above only rule things out; proof that I can lift it comes from the simulated lift test.`;
  },
  liftOk(riseMm: number, needMm: number, yaw: number): string {
    return `The simulated lift test raised it ${say(riseMm)} millimetres (I needed ${say(needMm)}) with my jaw at ${say(yaw)} degrees. That proof is from simulation; a real arm is unverified.`;
  },
  liftFailed(attempts: number, bestRiseMm: number, needMm: number): string {
    return `I tried in simulation and dropped it. The simulated lift test raised it at most ${say(bestRiseMm)} millimetres in ${say(attempts)} tries, and I needed ${say(needMm)}.`;
  },
  liftError(reason: string): string {
    return `The simulated lift test could not run (${reason}), so nothing is proven yet.`;
  },
  settled(rolledMm: number, rotatedDeg: number): string {
    return `I set it down. It moved ${sayMm(rolledMm)} millimetres and turned ${sayMm(rotatedDeg)} degrees, then came to rest.`;
  },
  rolls(rolledMm: number, rotatedDeg: number): string {
    return `It rolled ${sayMm(rolledMm)} millimetres and turned ${sayMm(rotatedDeg)} degrees when I put it down, so I'm re-aiming from where it stopped.`;
  },
  settleTimeout(seconds: number, touched: boolean, g: number): string {
    return touched
      ? `After ${say(seconds)} seconds at ${sayGravity(g)} it was still moving. I'll aim from where it is now, and watch it.`
      : `After ${say(seconds)} seconds at ${sayGravity(g)} it hadn't reached the floor yet. Low gravity makes everything slow.`;
  },
};

// ---- Spoken lines -------------------------------------------------------------------------
// The voice says a short summary that names the object; the on-screen receipt keeps every
// detail. Phrasings rotate, the identical line is never said twice in a row, and the jaw limit
// is said at most once a session for a width rescale (a width refusal may say it again).

export interface SpokenLine {
  text: string;
  kind: 'receipt' | 'refusal';
}

interface LineFacts {
  name: string;
  lengthMm: number | null;
  grams: number | null;
  model: boolean;
  toy: boolean;
  parts: number;
}

type Phrase = (f: LineFacts) => string;

const size = (f: LineFacts): string => (f.lengthMm === null ? '' : `${say(f.lengthMm)} millimetre`);
const grams = (f: LineFacts): string => (f.grams === null ? '' : `${say(f.grams)} grams`);
const what = (f: LineFacts): string => (f.toy ? 'toy model' : f.model ? 'model' : f.name);

/** At least four ways to say "built and lifted", rotated in order. Each names the object and the simulated lift test. */
const PASS_PHRASES: readonly Phrase[] = [
  (f) => `${f.model || f.toy ? `Here's your ${f.name} as a ${size(f)} ${what(f)}` : `Here's your ${size(f)} ${f.name}`}, ${grams(f)}. It held in the simulated lift test.`,
  (f) => `Your ${f.name} is ready: ${say(f.lengthMm ?? 0)} millimetres long and ${grams(f)}. The simulated lift test held it.`,
  (f) => `Done. One ${f.name}, ${say(f.lengthMm ?? 0)} millimetres, ${grams(f)}${f.parts > 1 ? `, in ${say(f.parts)} parts` : ''}. It passed the simulated lift test.`,
  (f) => `${capital(f.name)} built at ${say(f.lengthMm ?? 0)} millimetres and ${grams(f)}. I lifted it in the simulated lift test.`,
  (f) => `Got it: a ${size(f)} ${f.name}, ${grams(f)}. It stayed in my grip in the simulated lift test.`,
];

/** Every refusal opens with the verdict word, so the caption says plainly that it was refused. */
const REFUSAL_OPENERS: readonly ((name: string) => string)[] = [
  (name) => `Refused: I can't make the ${name}.`,
  (name) => `Refused. Not this ${name}, sorry.`,
  (name) => `Refused. I'll have to pass on the ${name}.`,
  (name) => `Refused. No ${name} this time.`,
];

function capital(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

function factsOf(receipt: Receipt): LineFacts {
  const name = displayName(receipt);
  const lengthMm = receipt.size_mm ? Math.max(receipt.size_mm[0], receipt.size_mm[1]) : null;
  return {
    name,
    lengthMm,
    grams: receipt.mass_kg !== null ? receipt.mass_kg * 1000 : null,
    model: receipt.scale !== null && receipt.scale < 0.995,
    toy: receipt.steps.some((s) => s.code === 'THICKENED'),
    parts: receipt.parts?.length ?? 1,
  };
}

/** Composes the spoken summary of each finished request. One per page: it remembers what it said. */
export class VoiceComposer {
  private last = '';
  private passTurn = 0;
  private refusalTurn = 0;
  private jawSaid = false;

  /** True once the jaw limit has been said for a width rescale. */
  get jawMentioned(): boolean {
    return this.jawSaid;
  }

  compose(receipt: Receipt, spawned: boolean): SpokenLine {
    const facts = factsOf(receipt);
    const candidates: string[] = [];
    let kind: SpokenLine['kind'];
    if (!spawned || receipt.verdict === 'REFUSED') {
      kind = 'refusal';
      const refused = receipt.steps.find((s) => s.action === 'refused');
      const reason = refused?.message ?? receipt.steps[receipt.steps.length - 1]?.message ?? 'A check refused it.';
      for (let k = 0; k < REFUSAL_OPENERS.length; k++) {
        candidates.push(`${REFUSAL_OPENERS[(this.refusalTurn + k) % REFUSAL_OPENERS.length]!(facts.name)} ${reason}`);
      }
      this.refusalTurn++;
    } else {
      kind = 'receipt';
      const wide = receipt.steps.find((s) => s.code === 'TOO_WIDE');
      const jaw = wide && !this.jawSaid && wide.limit !== null ? `My jaw takes ${say(wide.limit)} millimetres, so I made a scale model. ` : '';
      for (let k = 0; k < PASS_PHRASES.length; k++) {
        candidates.push(`${jaw}${PASS_PHRASES[(this.passTurn + k) % PASS_PHRASES.length]!(facts)}`.replace(/\s+/g, ' ').replace(/ ,/g, ','));
      }
      this.passTurn++;
      if (jaw) this.jawSaid = true;
    }
    const text = candidates.find((c) => c !== this.last) ?? `${candidates[0]!} Again.`;
    this.last = text;
    return { text, kind };
  }
}

/** True when a spoken line names the jaw's limit. */
export function mentionsJaw(text: string): boolean {
  return /\bjaw\b/i.test(text);
}
