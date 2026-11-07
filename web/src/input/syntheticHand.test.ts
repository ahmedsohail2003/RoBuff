import { describe, expect, it } from 'vitest';
import { handToCommand, palmToWorld, worldToPalm } from '../control/handMapping';
import type { Vec3 } from '../sim/simulation';
import { palmFromLandmarks, pinchRatio } from './landmarks';
import { PickScript } from './pickScript';
import { syntheticLandmarks, syntheticPinchRatio } from './syntheticHand';

describe('synthetic hand', () => {
  it('draws 21 landmarks whose palm and pinch ratio read back exactly', () => {
    for (const pinch of [0, 0.3, 1]) {
      const palm: Vec3 = [0.42, 0.61, 0.37];
      const landmarks = syntheticLandmarks(palm, pinch);
      expect(landmarks).toHaveLength(21);
      const read = palmFromLandmarks(landmarks);
      read.forEach((value, i) => expect(value).toBeCloseTo(palm[i]!, 9));
      expect(pinchRatio(landmarks)).toBeCloseTo(syntheticPinchRatio(pinch), 9);
    }
  });

  it('round-trips a world target through hand space', () => {
    const world: Vec3 = [0.03, -0.22, 0.05];
    palmToWorld(worldToPalm(world)).forEach((value, i) => expect(value).toBeCloseTo(world[i]!, 12));
  });

  it('is ignored below the confidence threshold', () => {
    expect(handToCommand({ palm: [0.5, 0.5, 0.5], pinch: 0, confidence: 0.1, tMs: 0 })).toBeNull();
    expect(handToCommand({ palm: [Number.NaN, 0.5, 0.5], pinch: 0, confidence: 1, tMs: 0 })).toBeNull();
  });
});

describe('PickScript', () => {
  const script = new PickScript({ objectCenter: [0, -0.22, 0.015], objectHalfWidth: 0.015, start: [0, -0.239, 0.08] });

  it('runs the phases in order', () => {
    expect(script.phases.map((phase) => phase.name)).toEqual(['above', 'down', 'close', 'lift', 'hold', 'move', 'open', 'done']);
  });

  it('moves continuously, with no jump between samples', () => {
    let previous = script.sample(0).target;
    for (let t = 0.01; t < 16; t += 0.01) {
      const next = script.sample(t).target;
      expect(Math.hypot(next[0] - previous[0], next[1] - previous[1], next[2] - previous[2])).toBeLessThan(0.002);
      previous = next;
    }
  });

  it('closes before lifting and opens only after the move', () => {
    const at = (name: string) => script.phases.findIndex((phase) => phase.name === name);
    expect(script.phases[at('lift')]!.grip).toBe(1);
    expect(script.phases[at('move')]!.grip).toBe(1);
    expect(script.phases[at('open')]!.grip).toBe(0);
    expect(script.phases[at('lift')]!.waypoint[2] - script.phases[at('down')]!.waypoint[2]).toBeGreaterThanOrEqual(0.05);
  });
});
