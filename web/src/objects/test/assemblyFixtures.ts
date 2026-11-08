// Shared assembly fixtures for the unit and arena tests.
import type { ObjectSpec } from '../spec';

/** A five-part AK-47 at real proportions in millimetres, as the server prompt's worked example describes it. */
export const AK47: ObjectSpec = {
  kind: 'assembly',
  name: 'AK-47',
  width_mm: 880,
  height_mm: 250,
  roughness: 0.2,
  lumpiness: 0.1,
  seed: 47,
  material: 'aluminium',
  color: '#2b2b2b',
  why: 'Approximated: an AK-47 from five simple parts.',
  parts: [
    { name: 'stock', shape: 'box', size_mm: [250, 40, 70], pos_mm: [-300, 0, 120], rot_deg: [0, 0, 0], color: '#8b5a2b' },
    { name: 'receiver', shape: 'box', size_mm: [300, 45, 80], pos_mm: [-25, 0, 150], rot_deg: [0, 0, 0], color: '#2b2b2b' },
    { name: 'barrel', shape: 'cylinder', size_mm: [22, 22, 400], pos_mm: [325, 0, 165], rot_deg: [0, 90, 0], color: '#1c1c1c' },
    { name: 'magazine', shape: 'box', size_mm: [70, 30, 200], pos_mm: [40, 0, 30], rot_deg: [0, -20, 0], color: '#3a3a3a' },
    { name: 'grip', shape: 'box', size_mm: [40, 30, 110], pos_mm: [-120, 0, 70], rot_deg: [0, 15, 0], color: '#5a3a1f' },
  ],
};
