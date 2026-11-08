// Honest about approximation: when the spec's why says the shape only approximates the thing
// asked for ("Approximated: a Tesla, as a car-shaped box."), the request line says so plainly.

import { say } from './format';
import type { ObjectSpec } from './spec';

const APPROXIMATED = /\b(approximat\w*|closest)\b/i;

export function isApproximation(spec: ObjectSpec): boolean {
  return APPROXIMATED.test(spec.why);
}

/** "Closest shape I can make: a box, 40 mm across as asked." or null when the why claims no approximation. */
export function approximationLine(spec: ObjectSpec): string | null {
  if (spec.kind === 'assembly' && spec.parts) {
    const count = spec.parts.length;
    return `Closest I can make: ${spec.name ? `the ${spec.name}` : 'it'} from ${say(count)} simple ${count === 1 ? 'part' : 'parts'} (${spec.parts.map((p) => p.shape).join(', ')}).`;
  }
  if (!isApproximation(spec)) return null;
  const article = /^[aeiou]/.test(spec.kind) ? 'an' : 'a';
  return `Closest shape I can make: ${article} ${spec.kind}, ${say(spec.width_mm)} mm across as asked.`;
}
