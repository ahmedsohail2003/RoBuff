// Draws the spawned object's visual mesh (the generated shape, not the collision hull) on the
// slot body's three.js group, so it moves with the simulated pose. Look by material: dark
// faceted rock, stony rock, glassy ice, or brushed metal. An assembly carries a colour per
// vertex (one per part), drawn with a matte look so a red car body reads as red, not chrome.

import * as THREE from 'three';
import type { MaterialId } from '../objects/materials';
import type { ObjectMesh } from '../objects/mesh';
import type { Receipt } from '../objects/receipt';
import { SkinLayer, type SkinImage, type SkinLayerState, type SkinRecipe } from './objectSkin';

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
  const parted = mesh.colors !== undefined && mesh.colors.length === mesh.positions.length;
  if (parted) {
    // Mesh colours are sRGB; three.js wants vertex colours linear.
    const linear = new Float32Array(mesh.colors!.length);
    const c = new THREE.Color();
    for (let i = 0; i < linear.length; i += 3) {
      c.setRGB(mesh.colors![i]!, mesh.colors![i + 1]!, mesh.colors![i + 2]!, THREE.SRGBColorSpace);
      linear[i] = c.r;
      linear[i + 1] = c.g;
      linear[i + 2] = c.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(linear, 3));
  }
  const look = LOOKS[receipt.spec.material];
  const material = new THREE.MeshStandardMaterial({
    color: parted ? new THREE.Color(0xffffff) : new THREE.Color(receipt.spec.color),
    vertexColors: parted,
    roughness: parted ? Math.max(0.55, look.roughness) : look.roughness,
    metalness: parted ? Math.min(0.2, look.metalness) : look.metalness,
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
  private currentReceipt: Receipt | null = null;
  private layer: SkinLayer | null = null;
  /**
   * Skins of the last two objects shown, keyed by their ObjectMesh. A failed lift re-spawns the
   * object before it with the same receipt mesh, so its skin comes back with it. A new object
   * has a new mesh and starts bare.
   */
  private readonly kept = new Map<ObjectMesh, SkinRecipe[]>();
  private readonly listeners = new Set<(receipt: Receipt | null) => void>();
  /** The GPU's largest anisotropic filter, for the skin state. Set by whoever owns the viewport. */
  maxAnisotropy = 0;
  /** Reads an uploaded texture's real GL anisotropy back (viewport.textureAnisotropy). Set by the viewport's owner. */
  glAnisotropy: ((texture: THREE.Texture) => number | null) | null = null;
  /** The reflection metal skins use (viewport.skinEnvironment). Set by the viewport's owner. */
  skinEnvironment: (() => THREE.Texture | null) | null = null;

  constructor(private readonly group: THREE.Group) {
    this.original = [...group.children];
  }

  show(receipt: Receipt | null): void {
    if (this.current) {
      const was = this.currentReceipt?.mesh ?? null;
      if (was && this.layer) {
        const recipes = this.layer.recipes();
        if (recipes.length > 0) {
          this.kept.delete(was);
          this.kept.set(was, recipes);
          while (this.kept.size > 2) this.kept.delete(this.kept.keys().next().value!);
        } else this.kept.delete(was);
      }
      this.layer?.dispose();
      this.layer = null;
      this.group.remove(this.current);
      this.current.geometry.dispose();
      // A skinned mesh draws a material array; free every material and its texture.
      const materials = Array.isArray(this.current.material) ? this.current.material : [this.current.material];
      for (const m of materials) {
        (m as THREE.MeshStandardMaterial).map?.dispose();
        m.dispose();
      }
      this.current = null;
      this.currentReceipt = null;
    }
    for (const child of this.original) child.visible = receipt === null;
    if (receipt === null) this.kept.clear();
    if (receipt) {
      this.current = buildObjectMesh(receipt);
      this.currentReceipt = receipt;
      this.group.add(this.current);
      const again = receipt.mesh ? this.kept.get(receipt.mesh) : undefined;
      if (again) for (const r of again) this.skin().apply(r.parts, r.image);
    }
    for (const listener of this.listeners) listener(receipt);
  }

  /** Called after every show(), with what is in the slot now. */
  onShow(listener: (receipt: Receipt | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The receipt drawn now, or null while the cube is there. */
  get receipt(): Receipt | null {
    return this.currentReceipt;
  }

  /** The receipt mesh drawn now: a late skin checks it is still the same object before applying. */
  get objectMesh(): ObjectMesh | null {
    return this.currentReceipt?.mesh ?? null;
  }

  /** The skin layer of the object drawn now, made on first use. Throws while the cube is there. */
  skin(): SkinLayer {
    if (!this.current || !this.currentReceipt) throw new Error('there is no spawned object to paint');
    if (!this.layer) {
      const look = LOOKS[this.currentReceipt.spec.material];
      this.layer = new SkinLayer(this.current, this.currentReceipt, {
        maxAnisotropy: this.maxAnisotropy,
        look,
        readGl: (t) => this.glAnisotropy?.(t) ?? null,
        envMap: () => this.skinEnvironment?.() ?? null,
      });
    }
    return this.layer;
  }

  /** Paints parts of the object drawn now, if it is still `expect` (the mesh the request was made for). */
  applySkin(expect: ObjectMesh, parts: readonly number[], image: SkinImage): boolean {
    if (!this.currentReceipt || this.currentReceipt.mesh !== expect) return false;
    this.skin().apply(parts, image);
    return true;
  }

  removeSkin(parts: readonly number[] | 'all'): number {
    return this.layer ? this.layer.remove(parts) : 0;
  }

  skinState(): SkinLayerState | null {
    if (!this.current || !this.currentReceipt) return null;
    return this.skin().state();
  }

  /** Vertices and triangles now drawn for the object, for the debug hook, plus its skins. */
  stats(): { vertices: number; triangles: number; material: string; materials: number; skins: number; skinnedParts: number; textureSize: number | null } | null {
    if (!this.current) return null;
    const geometry = this.current.geometry;
    const materials = Array.isArray(this.current.material) ? this.current.material : [this.current.material];
    const maps = materials.map((m) => (m as THREE.MeshStandardMaterial).map).filter((t): t is THREE.Texture => !!t);
    const image = maps[0]?.image as { width?: number } | undefined;
    return {
      vertices: geometry.getAttribute('position').count,
      triangles: (geometry.getIndex()?.count ?? geometry.getAttribute('position').count) / 3,
      material: (materials[0] as THREE.MeshStandardMaterial).type,
      materials: materials.length,
      skins: maps.length,
      skinnedParts: this.layer?.skinnedParts ?? 0,
      textureSize: image?.width ?? null,
    };
  }
}
