// Deterministic mesh from a spec: same spec, same bytes.

import type { ObjectMesh } from '../mesh';
import type { ObjectKind, ObjectSpec } from '../spec';
import { buildAsteroid } from './asteroid';
import { buildBus } from './bus';
import { buildDish } from './dish';
import { buildFragment } from './fragment';
import { buildPanel } from './panel';

const BUILDERS: Readonly<Record<ObjectKind, (spec: ObjectSpec) => ObjectMesh>> = {
  asteroid: buildAsteroid,
  panel: buildPanel,
  dish: buildDish,
  bus: buildBus,
  fragment: buildFragment,
};

export function generateMesh(spec: ObjectSpec): ObjectMesh {
  return BUILDERS[spec.kind](spec);
}
