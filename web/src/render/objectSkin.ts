// Skins on the spawned object's visual mesh: paint only. The geometry gets one vertex per
// triangle corner, box-projected UVs (objects/skinUv.ts) and one draw group per part; the mesh
// then draws a material array [base, ...skins], one skinned material per distinct image. Hulls,
// mass, friction and the MJCF are never touched, and this module imports nothing from sim/.

import * as THREE from 'three';
import type { Receipt } from '../objects/receipt';
import { finishFor, type SkinFinish } from '../objects/skinPattern';
import { anchorOf, boxUv, deindex, partRanges, type PartRange } from '../objects/skinUv';

export type SkinSourceKind = 'nano-banana' | 'procedural' | 'upload';

/** A drawn skin: a square canvas, where it came from and what it cost. */
export interface SkinImage {
  /** What the operator asked for, or the file name for an upload. */
  text: string;
  source: SkinSourceKind;
  /** The image model id for Nano Banana skins, else null. */
  model: string | null;
  canvas: HTMLCanvasElement;
  /** Browser-side time to get the image, ms. */
  ms: number;
  /** Nano Banana's own drawing time as the key server measured it, ms (null for others). */
  drawnMs: number | null;
  /** 'hit' when the key server or the session cache already had it. */
  cache: 'hit' | 'miss' | 'session' | null;
  /** Why the procedural fallback was used when Nano Banana was live, or null. */
  note: string | null;
}

/** Look of the object's base material, so a skin keeps flat shading on rocks. */
export interface SkinLook {
  roughness: number;
  metalness: number;
  flatShading: boolean;
}

interface Skin {
  image: SkinImage;
  texture: THREE.CanvasTexture;
  material: THREE.MeshStandardMaterial;
  finish: SkinFinish['kind'];
}

export interface PartSkinState {
  name: string;
  source: SkinSourceKind | null;
  model: string | null;
  text: string | null;
  size: [number, number] | null;
  /** A procedural skin drawn because Nano Banana failed or timed out (its note says why). */
  fallback: boolean;
  /** 'metal' (high metalness, a reflection and bumps from the picture) or 'matte'; null when bare. */
  finish: SkinFinish['kind'] | null;
  /**
   * Read from the mesh, not this layer's records: the part's draw group points at a material whose
   * map is this part's skin picture (or at the base material when bare).
   */
  drawn: boolean;
}

export interface SkinLayerState {
  parts: PartSkinState[];
  /** Distinct skin materials on the mesh now. */
  skins: number;
  /**
   * set: texture.anisotropy; max: the GPU's limit; effective: what three should upload, min(set, max);
   * gl: what the uploaded GL texture really has, read back with getTexParameter (null before the
   * first frame draws it, or with no reader).
   */
  anisotropy: { set: number; max: number; effective: number; gl: number | null };
  mipmaps: boolean;
  colorSpace: string | null;
  minFilter: string | null;
  uvFinite: boolean;
  uvRange: [number, number];
  materials: number;
}

/** What to re-apply when an object comes back (a failed lift restores the one before it). */
export interface SkinRecipe {
  parts: number[];
  image: SkinImage;
}

/**
 * Matte skins, and any skin when no reflection is given, stay inside these: metal with nothing
 * to reflect renders dark. A metal skin (finishFor) with a reflection uses its own finish.
 */
export const SKIN_MAX_METALNESS = 0.2;
export const SKIN_MIN_ROUGHNESS = 0.45;
/** Asked for on every skin; three clamps it to the GPU's maximum. */
export const SKIN_ANISOTROPY = 8;

export class SkinLayer {
  readonly ranges: PartRange[];
  private readonly slots: (Skin | null)[];
  private readonly base: THREE.Material;
  private uv: THREE.BufferAttribute | null = null;
  private recipesLog: SkinRecipe[] = [];

  constructor(
    private readonly mesh: THREE.Mesh,
    receipt: Receipt,
    private readonly opts: {
      maxAnisotropy: number;
      look: SkinLook;
      readGl?: (texture: THREE.Texture) => number | null;
      /** The reflection for metal skins (viewport.skinEnvironment), asked for on the first metal skin. */
      envMap?: () => THREE.Texture | null;
    },
  ) {
    this.ranges = partRanges(receipt);
    this.slots = this.ranges.map(() => null);
    this.base = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material;
  }

  get partNames(): string[] {
    return this.ranges.map((r) => r.name);
  }

  /** Paints these parts (indices into partRanges) with one image. Replaces what they wore. */
  apply(parts: readonly number[], image: SkinImage): void {
    const targets = [...new Set(parts)].filter((p) => p >= 0 && p < this.ranges.length).sort((a, b) => a - b);
    if (targets.length === 0) return;
    this.prepareGeometry();
    const positions = (this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const uv = this.uv!;
    const uvArray = uv.array as Float32Array;
    // The whole object: one picture runs across every part. Some parts: each fits its own box.
    const whole = targets.length === this.ranges.length;
    const total = this.mesh.geometry.getIndex()!.count;
    const objectAnchor = anchorOf(positions, 0, total);
    for (const p of targets) {
      const r = this.ranges[p]!;
      boxUv(positions, uvArray, r.start, r.count, whole ? objectAnchor : anchorOf(positions, r.start, r.count));
    }
    uv.needsUpdate = true;
    const skin = this.makeSkin(image);
    for (const p of targets) this.slots[p] = skin;
    this.recipesLog = this.recipesLog.map((r) => ({ ...r, parts: r.parts.filter((p) => !targets.includes(p)) })).filter((r) => r.parts.length > 0);
    this.recipesLog.push({ parts: targets, image });
    this.rebuild();
  }

  /** Takes the skin off these parts, or off all of them. Returns how many parts lost a skin. */
  remove(parts: readonly number[] | 'all'): number {
    const targets = parts === 'all' ? this.ranges.map((_, i) => i) : parts;
    let removed = 0;
    for (const p of targets) {
      if (this.slots[p]) {
        this.slots[p] = null;
        removed++;
      }
    }
    this.recipesLog = this.recipesLog.map((r) => ({ ...r, parts: r.parts.filter((p) => !targets.includes(p)) })).filter((r) => r.parts.length > 0);
    this.rebuild();
    return removed;
  }

  get skinnedParts(): number {
    return this.slots.filter(Boolean).length;
  }

  /** The recipes that would rebuild today's skins on a fresh mesh of the same object. */
  recipes(): SkinRecipe[] {
    return this.recipesLog.map((r) => ({ parts: [...r.parts], image: r.image }));
  }

  /** Frees every skin texture and material. The mesh goes back to its base material. */
  dispose(): void {
    for (const skin of this.distinct()) disposeSkin(skin);
    this.slots.fill(null);
    this.recipesLog = [];
    this.mesh.material = this.base;
    const geometry = this.mesh.geometry;
    for (const group of geometry.groups) group.materialIndex = 0;
  }

  state(): SkinLayerState {
    const skins = this.distinct();
    const first = skins[0]?.texture ?? null;
    const max = this.opts.maxAnisotropy;
    const set = first?.anisotropy ?? SKIN_ANISOTROPY;
    let lo = Infinity;
    let hi = -Infinity;
    let finite = true;
    if (this.uv) {
      const a = this.uv.array as Float32Array;
      for (let i = 0; i < a.length; i++) {
        const v = a[i]!;
        if (!Number.isFinite(v)) finite = false;
        else {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    return {
      parts: this.ranges.map((r, i) => {
        const s = this.slots[i];
        return {
          name: r.name,
          source: s?.image.source ?? null,
          model: s?.image.model ?? null,
          text: s?.image.text ?? null,
          size: s ? [s.image.canvas.width, s.image.canvas.height] : null,
          fallback: s ? s.image.source === 'procedural' && s.image.note !== null : false,
          finish: s ? s.finish : null,
          drawn: this.drawnRight(i),
        };
      }),
      skins: skins.length,
      // three uses min(texture.anisotropy, the GPU's max) for mipmapped textures, and 1 without the extension.
      anisotropy: { set, max, effective: max > 0 ? Math.min(set, max) : 1, gl: first && this.opts.readGl ? this.opts.readGl(first) : null },
      mipmaps: first ? first.generateMipmaps && first.minFilter === THREE.LinearMipmapLinearFilter : false,
      colorSpace: first ? first.colorSpace : null,
      minFilter: first ? filterName(first.minFilter) : null,
      uvFinite: finite,
      uvRange: this.uv && Number.isFinite(lo) ? [lo, hi] : [0, 0],
      materials: Array.isArray(this.mesh.material) ? this.mesh.material.length : 1,
    };
  }

  /** On first use: corner-per-vertex geometry with a uv attribute and one group per part. */
  private prepareGeometry(): void {
    if (this.uv) return;
    const old = this.mesh.geometry;
    const pos = old.getAttribute('position') as THREE.BufferAttribute;
    const nor = old.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const col = old.getAttribute('color') as THREE.BufferAttribute | undefined;
    const index = old.getIndex();
    const indices = index ? new Uint32Array(index.array as ArrayLike<number>) : Uint32Array.from({ length: pos.count }, (_, i) => i);
    const flat = deindex({
      positions: pos.array as Float32Array,
      indices,
      normals: (nor?.array as Float32Array | undefined) ?? new Float32Array(0),
      colors: col ? (col.array as Float32Array) : undefined,
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(flat.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(flat.normals, 3));
    if (flat.colors) geometry.setAttribute('color', new THREE.BufferAttribute(flat.colors, 3));
    // Keep an index (identity), so the triangle count and the part ranges stay as they were.
    geometry.setIndex(new THREE.BufferAttribute(flat.indices, 1));
    this.uv = new THREE.BufferAttribute(new Float32Array((flat.positions.length / 3) * 2), 2);
    geometry.setAttribute('uv', this.uv);
    for (const r of this.ranges) geometry.addGroup(r.start, r.count, 0);
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    this.mesh.geometry = geometry;
    old.dispose();
  }

  private makeSkin(image: SkinImage): Skin {
    const texture = new THREE.CanvasTexture(image.canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = SKIN_ANISOTROPY;
    // Defaults kept on purpose: generateMipmaps true and LinearMipmapLinearFilter, so a 1024 px
    // skin stays sharp up close and does not shimmer when the object is small on screen.
    texture.name = `skin:${image.source}`;
    const look = this.opts.look;
    const finish = finishFor(image.text);
    const env = finish.kind === 'metal' ? (this.opts.envMap?.() ?? null) : null;
    const metal = env !== null;
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      color: 0xffffff,
      vertexColors: false,
      roughness: metal ? finish.roughness : Math.max(SKIN_MIN_ROUGHNESS, look.roughness),
      metalness: metal ? finish.metalness : Math.min(SKIN_MAX_METALNESS, look.metalness),
      flatShading: look.flatShading,
      transparent: false,
      opacity: 1,
    });
    if (metal) {
      material.envMap = env;
      material.envMapIntensity = 1;
      // The picture's brightness as fine bumps, so scratches and brushing catch the light.
      if (finish.bump > 0) {
        material.bumpMap = texture;
        material.bumpScale = finish.bump;
      }
    }
    material.name = 'object-skin';
    return { image, texture, material, finish: metal ? 'metal' : 'matte' };
  }

  /** The mesh's draw group for this part points at the right material and picture. */
  private drawnRight(part: number): boolean {
    const group = this.mesh.geometry.groups[part];
    const materials = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
    const s = this.slots[part];
    if (!group) return s === null && !Array.isArray(this.mesh.material) && this.mesh.material === this.base;
    const m = materials[group.materialIndex ?? 0] as THREE.MeshStandardMaterial | undefined;
    if (!m) return false;
    if (!s) return m === this.base;
    return m === s.material && m.map !== null && m.map.image === s.image.canvas;
  }

  private distinct(): Skin[] {
    return [...new Set(this.slots.filter((s): s is Skin => s !== null))];
  }

  /** Material array from the slots, groups pointed at it, and unused skins freed. */
  private rebuild(): void {
    const used = this.distinct();
    const current = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
    for (const m of current) {
      if (m === this.base) continue;
      if (!used.some((s) => s.material === m)) {
        (m as THREE.MeshStandardMaterial).map?.dispose();
        m.dispose();
      }
    }
    const groups = this.mesh.geometry.groups;
    for (let i = 0; i < this.ranges.length; i++) {
      const s = this.slots[i];
      if (groups[i]) groups[i]!.materialIndex = s ? 1 + used.indexOf(s) : 0;
    }
    this.mesh.material = used.length > 0 ? [this.base, ...used.map((s) => s.material)] : this.base;
  }
}

function disposeSkin(skin: Skin): void {
  skin.texture.dispose();
  skin.material.dispose();
}

function filterName(filter: THREE.TextureFilter): string {
  if (filter === THREE.LinearMipmapLinearFilter) return 'LinearMipmapLinear';
  if (filter === THREE.LinearFilter) return 'Linear';
  if (filter === THREE.NearestFilter) return 'Nearest';
  return String(filter);
}
