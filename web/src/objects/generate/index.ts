// Deterministic mesh from a spec: same spec, same bytes.

import type { ObjectMesh } from '../mesh';
import type { ObjectKind, ObjectSpec } from '../spec';
import { buildAssembly } from './assembly';
import { buildAsteroid } from './asteroid';
import { buildBox } from './box';
import { buildBus } from './bus';
import { buildCone } from './cone';
import { buildCylinder } from './cylinder';
import { buildDish } from './dish';
import { buildFragment } from './fragment';
import { buildPanel } from './panel';
import { buildSphere } from './sphere';

const BUILDERS: Readonly<Record<ObjectKind, (spec: ObjectSpec) => ObjectMesh>> = {
  asteroid: buildAsteroid,
  panel: buildPanel,
  dish: buildDish,
  bus: buildBus,
  fragment: buildFragment,
  box: buildBox,
  cylinder: buildCylinder,
  sphere: buildSphere,
  cone: buildCone,
  assembly: buildAssembly,
};

export function generateMesh(spec: ObjectSpec): ObjectMesh {
  return BUILDERS[spec.kind](spec);
}
