// The mission-console voice: what was measured, the arm's limit, and what was done.
// Plain sentences, one number at a time. Never just "invalid".
// Any line that mentions a lift says the proof comes from the simulated lift test.

import { say, sayGravityValue, sayLength, sayMass, sayMassLimit, sayMm } from './format';
import { GRAVITY, MAX_HULL_VERT } from './limits';

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
    return `That's ${sayLength(acrossMm)} across${narrow}. ${limit} I'll make a ${say(finalNarrowMm)} millimetre model of it, ${say(finalAcrossMm)} across, same proportions.`;
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
