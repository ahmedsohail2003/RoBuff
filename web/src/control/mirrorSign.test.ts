import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { HandMapper, DEFAULT_HAND_MAPPER } from '../input/handMapper';
import { syntheticLandmarks } from '../input/syntheticHand';
import { DEFAULT_VIEW } from '../render/defaultView';
import type { Vec3 } from '../sim/simulation';
import { handToCommand } from './handMapping';

/** The page's opening camera, as render/viewport.ts builds it. */
function defaultCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(DEFAULT_VIEW.fovDeg, 16 / 9, 0.01, 20);
  camera.up.set(0, 0, 1);
  camera.position.set(...DEFAULT_VIEW.position);
  camera.lookAt(...DEFAULT_VIEW.target);
  camera.updateMatrixWorld();
  return camera;
}

/** Holds a raw camera-image palm for a second of 30 fps frames and returns the gripper target. */
function targetFor(rawPalm: Vec3, mirrorX = false): Vec3 {
  const mapper = new HandMapper({ ...DEFAULT_HAND_MAPPER, mirrorX });
  let target: Vec3 | null = null;
  for (let frame = 0; frame < 30; frame++) {
    const state = mapper.update({ landmarks: syntheticLandmarks(rawPalm, 0), score: 0.95 }, frame * 33);
    const command = state ? handToCommand(state) : null;
    if (command) target = command.target;
  }
  if (!target) throw new Error('no command');
  return target;
}

function screen(point: Vec3): { x: number; y: number } {
  const v = new THREE.Vector3(...point).project(defaultCamera());
  return { x: v.x, y: v.y };
}

describe('webcam direction in the default view', () => {
  // In the raw (unmirrored) camera picture, the user's right is the picture's left: x falls.
  const centre: Vec3 = [0.5, 0.5, 0.45];
  const usersRight: Vec3 = [0.4, 0.5, 0.45];

  it("moves the gripper toward screen right when the hand moves to the user's right", () => {
    const a = targetFor(centre);
    const b = targetFor(usersRight);
    expect(b[0]).toBeGreaterThan(a[0] + 0.03);
    expect(screen(b).x).toBeGreaterThan(screen(a).x + 0.02);
  });

  it('swaps that with mirrorX, for a camera that already mirrors its picture (?flip=1)', () => {
    const a = targetFor(centre, true);
    const b = targetFor(usersRight, true);
    expect(b[0]).toBeLessThan(a[0] - 0.03);
    expect(screen(b).x).toBeLessThan(screen(a).x - 0.02);
  });

  it('moves the gripper up on screen when the hand rises (image y falls)', () => {
    const a = targetFor(centre);
    const b = targetFor([0.5, 0.35, 0.45]);
    expect(b[2]).toBeGreaterThan(a[2] + 0.02);
    expect(screen(b).y).toBeGreaterThan(screen(a).y + 0.02);
  });

  it('reaches toward the viewer when the hand comes closer to the camera', () => {
    const camera = new THREE.Vector3(...DEFAULT_VIEW.position);
    const far = targetFor([0.5, 0.5, 0.35]);
    const near = targetFor([0.5, 0.5, 0.6]);
    expect(near[1]).toBeLessThan(far[1] - 0.02);
    expect(new THREE.Vector3(...near).distanceTo(camera)).toBeLessThan(new THREE.Vector3(...far).distanceTo(camera));
  });
});
