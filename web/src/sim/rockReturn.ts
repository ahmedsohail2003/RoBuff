// The delay modes need the 30 mm test rock in the slot. When an object was spawned in its
// place, the object requests (sim/objectRequest.ts) can put the rock back; the delay rig
// (delay/dualSim.ts) asks through here, so neither module has to import the other.

/** Puts the test rock back in the slot. Returns false when it cannot right now (a request is running). */
export type RockReturn = () => boolean;

let current: RockReturn | null = null;

/** Registers who can put the rock back (the latest one wins); null clears it. */
export function setRockReturn(fn: RockReturn | null): void {
  current = fn;
}

/** The registered way to put the rock back, or null when no object panel is running. */
export function rockReturn(): RockReturn | null {
  return current;
}
