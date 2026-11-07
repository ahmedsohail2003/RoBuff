import { DEFAULT_SPEC, type ObjectSpec } from '../spec';

export function spec(overrides: Partial<ObjectSpec> = {}): ObjectSpec {
  return { ...DEFAULT_SPEC, ...overrides };
}

export function bytesOf(array: Float32Array | Uint32Array): Uint8Array {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

export function sameBytes(a: Float32Array | Uint32Array, b: Float32Array | Uint32Array): boolean {
  const x = bytesOf(a);
  const y = bytesOf(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
