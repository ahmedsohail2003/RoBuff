// Public surface of the objects package. Pure logic: no DOM, no rendering.

export * from './spec';
export * from './materials';
export * from './limits';
export type { ObjectMesh } from './mesh';
export { generateMesh } from './generate/index';
export { icosphere } from './generate/asteroid';
export { convexHull, closedVolume, type ConvexHull } from './hull';
export * from './geometry';
export * from './receipt';
export { validate, validateMesh, type ValidateOptions } from './guardrail';
export { LIFT_NOT_RUN_TEXT } from './messages';
export * from './mjcf';
export * from './lift';
export * from './settle';
export * from './check';
export * from './mock';
export { meshToObj } from './obj';
export { GALLERY_SPECS } from './gallery';
