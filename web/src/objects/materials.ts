// Materials the spec may name. Rock density is SAMPLE density, never whole-asteroid
// bulk: whole bodies hold large voids (Bennu bulk is 1.194 g/cc per JPL SBDB).

export const MATERIAL_IDS = ['c_type_rock', 's_type_rock', 'ice', 'aluminium', 'iron'] as const;
export type MaterialId = (typeof MATERIAL_IDS)[number];

export interface Material {
  readonly id: MaterialId;
  readonly label: string;
  readonly density_g_cc: number;
  readonly density_range_g_cc: readonly [number, number];
  /** What the density number describes. Rock is reported as sample density. */
  readonly density_basis: 'sample density' | 'solid density';
  readonly friction: number;
  /** Slippery materials need priority="1", or MuJoCo uses the pad's higher friction and hides them. */
  readonly slippery: boolean;
}

export const MATERIALS: Readonly<Record<MaterialId, Material>> = {
  c_type_rock: {
    id: 'c_type_rock',
    label: 'C-type rock sample',
    // Bennu returned matrix 1.6 +/- 0.3, range 1.2-2.3 (JAMS 2025 abstract R5-13, via story-and-prior-art.md section 3).
    density_g_cc: 1.6,
    density_range_g_cc: [1.2, 2.3],
    density_basis: 'sample density',
    // Design value near Byerlee's rule for rock on rock (about 0.6), recalled, not looked up today. Not measured on carbonaceous rock.
    friction: 0.6,
    slippery: false,
  },
  s_type_rock: {
    id: 's_type_rock',
    label: 'S-type rock sample',
    // Itokawa sample 3.4 (Tsuchiyama 2011), LL chondrites 3.15-3.4 (via story-and-prior-art.md section 3).
    density_g_cc: 3.2,
    density_range_g_cc: [2.2, 3.4],
    density_basis: 'sample density',
    // Same recalled Byerlee value as C-type, nudged up for harder rock. A design value, not a measurement.
    friction: 0.7,
    slippery: false,
  },
  ice: {
    id: 'ice',
    label: 'Ice',
    // Task list and 3d-generation.md pipeline step 6.
    density_g_cc: 0.9,
    density_range_g_cc: [0.9, 0.9],
    density_basis: 'solid density',
    // Engineering ToolBox friction table, ice on steel, clean and dry: 0.03. Engineers Edge lists 0.04. Very cold ice may differ.
    friction: 0.03,
    slippery: true,
  },
  aluminium: {
    id: 'aluminium',
    label: 'Solid aluminium',
    // 3d-generation.md pipeline step 6, low end of metal.
    density_g_cc: 2.7,
    density_range_g_cc: [2.7, 2.7],
    density_basis: 'solid density',
    // Engineering ToolBox, aluminium on mild steel, clean and dry: 0.61 static, 0.47 kinetic. Kinetic is used, the safer of the two.
    friction: 0.47,
    slippery: false,
  },
  iron: {
    id: 'iron',
    label: 'Solid iron',
    // 3d-generation.md pipeline step 6, high end of metal.
    density_g_cc: 7.8,
    density_range_g_cc: [7.8, 7.8],
    density_basis: 'solid density',
    // Design value. Engineering ToolBox lists iron on iron, clean and dry, at 1.0, but the pad is not iron, so a lower number is used.
    friction: 0.6,
    slippery: false,
  },
};
