// Draws the spawned object's visual mesh (the generated shape, not the collision hull) on the
// slot body's three.js group, so it moves with the simulated pose. Look by material: dark
// faceted rock, stony rock, glassy ice, or brushed metal.

import * as THREE from 'three';
import type { MaterialId } from '../objects/materials';
import type { Receipt } from '../objects/receipt';

interface Look {
  roughness: number;
  metalness: number;
  flatShading: boolean;
  opacity: number;
  emissive?: number;
}

export const LOOKS: Record<MaterialId, Look> = {
  c_type_rock: { roughness: 0.97, metalness: 0.0, flatShading: true, opacity: 1 },
  s_type_rock: { roughness: 0.88, metalness: 0.05, flatShading: true, opacity: 1 },
  ice: { roughness: 0.12, metalness: 0.0, flatShading: false, opacity: 0.82, emissive: 0x16303d },
  aluminium: { roughness: 0.32, metalness: 0.9, flatShading: false, opacity: 1 },
  iron: { roughness: 0.5, metalness: 0.75, flatShading: false, opacity: 1 },
};

/** Visual mesh from the receipt, in the body frame the MJCF uses (lowest point at the origin's height). */
export function buildObjectMesh(receipt: Receipt): THREE.Mesh {
  const mesh = receipt.mesh;
  if (!mesh) throw new Error('this receipt has no mesh to draw');
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mesh.positions), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));
  if (mesh.normals.length === mesh.positions.length) geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(mesh.normals), 3));
  else geometry.computeVertexNormals();
  const look = LOOKS[receipt.spec.material];
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(receipt.spec.color),
    roughness: look.roughness,
    metalness: look.metalness,
    flatShading: look.flatShading,
    transparent: look.opacity < 1,
    opacity: look.opacity,
    emissive: new THREE.Color(look.emissive ?? 0x000000),
  });
  const object = new THREE.Mesh(geometry, material);
  object.name = 'spawned-object-visual';
  object.castShadow = true;
  object.receiveShadow = true;
  return object;
}

/** Swaps what one body group shows. The group's first contents (the cube) are kept aside, so they can come back. */
export class SlotRenderer {
  private readonly original: THREE.Object3D[];
  private current: THREE.Mesh | null = null;

  constructor(private readonly group: THREE.Group) {
    this.original = [...group.children];
  }

  show(receipt: Receipt | null): void {
    if (this.current) {
      this.group.remove(this.current);
      this.current.geometry.dispose();
      (this.current.material as THREE.Material).dispose();
      this.current = null;
    }
    for (const child of this.original) child.visible = receipt === null;
    if (receipt) {
      this.current = buildObjectMesh(receipt);
      this.group.add(this.current);
    }
  }

  /** Vertices and triangles now drawn for the object, for the debug hook. */
  stats(): { vertices: number; triangles: number; material: string } | null {
    if (!this.current) return null;
    const geometry = this.current.geometry;
    return {
      vertices: geometry.getAttribute('position').count,
      triangles: (geometry.getIndex()?.count ?? 0) / 3,
      material: (this.current.material as THREE.MeshStandardMaterial).type,
    };
  }
}
