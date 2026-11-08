// The ghost arm on screen: a translucent copy (opacity 0.35) of every moving body the viewport
// draws, posed from the ghost simulation's live poses, plus a drop line from the ghost
// gripper to the floor as a depth cue. The copies share the viewport's geometry, so they cost
// draw calls but no extra mesh memory.

import * as THREE from 'three';
import type { Viewport } from './viewport';

export const GHOST_OPACITY = 0.35;
const GHOST_COLOR = 0x7fd8ff;

export class GhostMeshes {
  readonly root = new THREE.Group();
  private readonly groups = new Map<number, THREE.Group>();
  private readonly dropLine: THREE.Line;
  private readonly dropFoot: THREE.Mesh;

  /** staticBodies: bodies that never move (the welded base), skipped so the ghost does not sit inside them. */
  constructor(
    private readonly viewport: Viewport,
    bodyCount: number,
    staticBodies: ReadonlySet<number>,
  ) {
    const material = new THREE.MeshStandardMaterial({
      color: GHOST_COLOR,
      emissive: 0x0d3a52,
      transparent: true,
      opacity: GHOST_OPACITY,
      depthWrite: false,
      roughness: 0.4,
      metalness: 0,
    });
    for (let id = 1; id < bodyCount; id++) {
      if (staticBodies.has(id)) continue;
      const source = viewport.bodyGroup(id);
      if (!source) continue;
      const copy = source.clone(true);
      copy.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.material = material;
          node.castShadow = false;
          node.receiveShadow = false;
          node.renderOrder = 2;
        }
      });
      this.groups.set(id, copy);
      this.root.add(copy);
    }
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.dropLine = new THREE.Line(lineGeometry, new THREE.LineDashedMaterial({ color: GHOST_COLOR, dashSize: 0.006, gapSize: 0.004, transparent: true, opacity: 0.9 }));
    this.dropFoot = new THREE.Mesh(new THREE.RingGeometry(0.006, 0.009, 24), new THREE.MeshBasicMaterial({ color: GHOST_COLOR, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
    this.root.add(this.dropLine, this.dropFoot);
    this.root.visible = false;
    this.root.name = 'ghost-arm';
    viewport.scene.add(this.root);
  }

  get visible(): boolean {
    return this.root.visible;
  }

  /** Poses the ghost from its simulation and draws the drop line under its gripper; null hides it. */
  sync(poses: { xpos: Float64Array; xquat: Float64Array } | null, gripper: [number, number, number] | null): void {
    this.root.visible = poses !== null;
    if (!poses) return;
    for (const [id, group] of this.groups) {
      group.position.set(poses.xpos[3 * id]!, poses.xpos[3 * id + 1]!, poses.xpos[3 * id + 2]!);
      group.quaternion.set(poses.xquat[4 * id + 1]!, poses.xquat[4 * id + 2]!, poses.xquat[4 * id + 3]!, poses.xquat[4 * id]!);
    }
    this.dropLine.visible = this.dropFoot.visible = gripper !== null;
    if (gripper) {
      const position = this.dropLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      position.setXYZ(0, gripper[0], gripper[1], gripper[2]);
      position.setXYZ(1, gripper[0], gripper[1], 0.001);
      position.needsUpdate = true;
      this.dropLine.computeLineDistances();
      this.dropFoot.position.set(gripper[0], gripper[1], 0.0012);
    }
  }

  /** Ghost meshes drawn (for the debug hook). */
  get meshCount(): number {
    let count = 0;
    this.root.traverse((node) => {
      if (node instanceof THREE.Mesh) count++;
    });
    return count;
  }

  dispose(): void {
    this.viewport.scene.remove(this.root);
  }
}
