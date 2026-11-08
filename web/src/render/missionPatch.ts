// The Robuff mission patch: an original round, embroidered-style badge drawn at runtime with
// Canvas 2D (no image files). A buffalo silhouette drawn here in front of a crescent Moon and a
// few stars, "ROBUFF" on the top arc and "UB HACKING 2026" on the bottom, navy and gold. It is
// not modelled on any agency or company mark. It sits on a side face of the upper arm, parented
// to that body's group, so it moves with the arm. A small "RB-1" unit plate sits on the other side.

import * as THREE from 'three';
import type { Viewport } from './viewport';

/** Body ids follow the MJCF tree: world 0, Base 1, Rotation_Pitch 2, Upper_Arm 3 (arena.xml includes the arm first). */
const UPPER_ARM_BODY = 3;
const NAVY = '#13265a';
const NAVY_DEEP = '#0b1738';
const GOLD = '#e2b43c';
const GOLD_LIGHT = '#f6d77a';
const GOLD_DARK = '#9a7420';
/** Gap between a decal and the face it sits on, in metres. */
const LIFT_M = 0.0007;

const noRaycast = (): void => {};

function disc(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string): void {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
}

function star(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string): void {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const radius = i % 2 === 0 ? r : r * 0.42;
    g.lineTo(x + radius * Math.cos(a), y + radius * Math.sin(a));
  }
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}

/** Text along a circle, centred at the top (reading clockwise) or the bottom (reading left to right, upright). */
function arcText(g: CanvasRenderingContext2D, text: string, cx: number, cy: number, r: number, top: boolean, spacing: number): void {
  const widths = [...text].map((ch) => g.measureText(ch).width + spacing);
  const total = widths.reduce((a, b) => a + b, 0) - spacing;
  let run = 0;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  [...text].forEach((ch, i) => {
    const w = widths[i]!;
    const offset = (run + (w - spacing) / 2 - total / 2) / r;
    run += w;
    const angle = top ? -Math.PI / 2 + offset : Math.PI / 2 - offset;
    g.save();
    g.translate(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
    g.rotate(top ? angle + Math.PI / 2 : angle - Math.PI / 2);
    g.fillText(ch, 0, 0);
    g.restore();
  });
}

/** A bison in profile facing left, in a 224 x 142 box: heavy hump, low head, short horn, tail. */
function buffalo(g: CanvasRenderingContext2D): void {
  g.beginPath();
  g.moveTo(0, 96);
  g.quadraticCurveTo(4, 72, 22, 56);
  g.quadraticCurveTo(38, 8, 84, 4);
  g.quadraticCurveTo(150, 6, 204, 40);
  g.quadraticCurveTo(214, 46, 222, 74);
  g.lineTo(214, 72);
  g.quadraticCurveTo(212, 88, 210, 92);
  g.lineTo(214, 142);
  g.lineTo(198, 142);
  g.lineTo(193, 108);
  g.quadraticCurveTo(140, 120, 88, 108);
  g.lineTo(86, 142);
  g.lineTo(70, 142);
  g.lineTo(66, 116);
  g.quadraticCurveTo(50, 124, 38, 112);
  g.quadraticCurveTo(30, 106, 14, 104);
  g.closePath();
  g.fill();
  g.stroke();
  // Horn.
  g.beginPath();
  g.moveTo(24, 54);
  g.quadraticCurveTo(14, 38, 30, 30);
  g.quadraticCurveTo(26, 42, 36, 50);
  g.closePath();
  g.fillStyle = '#f1e6c8';
  g.fill();
}

/** The round patch, size x size pixels, transparent outside the circle. */
export function drawMissionPatch(size = 512): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.scale(size / 512, size / 512);
  const c = 256;

  disc(g, c, c, 252, GOLD_DARK);
  disc(g, c, c, 245, GOLD);
  disc(g, c, c, 228, NAVY_DEEP);
  disc(g, c, c, 166, GOLD);
  disc(g, c, c, 159, NAVY);

  // The scene inside the inner disc.
  g.save();
  g.beginPath();
  g.arc(c, c, 159, 0, Math.PI * 2);
  g.clip();
  for (const [x, y, r] of [
    [150, 140, 9],
    [205, 112, 5],
    [118, 206, 6],
    [372, 248, 7],
    [312, 128, 4],
    [176, 182, 4],
  ] as const) {
    star(g, x, y, r, '#f4f1e6');
  }
  // Crescent Moon: a pale disc with a navy disc over it, off-centre.
  disc(g, 318, 196, 74, '#d9dee8');
  disc(g, 350, 172, 66, NAVY);
  // Lunar ground with two craters.
  g.beginPath();
  g.ellipse(c, 452, 240, 112, 0, 0, Math.PI * 2);
  g.fillStyle = '#8b909a';
  g.fill();
  g.beginPath();
  g.ellipse(170, 368, 26, 7, 0, 0, Math.PI * 2);
  g.ellipse(338, 380, 18, 5, 0, 0, Math.PI * 2);
  g.fillStyle = '#6c717b';
  g.fill();
  // The buffalo, standing on the ground.
  g.save();
  g.translate(150, 214);
  g.fillStyle = '#3a2416';
  g.strokeStyle = GOLD_LIGHT;
  g.lineWidth = 5;
  g.lineJoin = 'round';
  buffalo(g);
  g.restore();
  g.restore();

  // Stitching on the band edges.
  g.setLineDash([9, 6]);
  g.lineWidth = 3;
  g.strokeStyle = GOLD_LIGHT;
  for (const r of [236, 174]) {
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.stroke();
  }
  g.setLineDash([]);

  g.fillStyle = GOLD_LIGHT;
  g.font = 'bold 50px "Arial Black", Arial, sans-serif';
  arcText(g, 'ROBUFF', c, c, 200, true, 10);
  g.font = 'bold 34px Arial, sans-serif';
  arcText(g, 'UB HACKING 2026', c, c, 202, false, 4);
  star(g, c - 202, c, 11, GOLD_LIGHT);
  star(g, c + 202, c, 11, GOLD_LIGHT);

  // A faint thread texture over the whole badge.
  g.save();
  g.beginPath();
  g.arc(c, c, 252, 0, Math.PI * 2);
  g.clip();
  g.globalAlpha = 0.07;
  g.strokeStyle = '#ffffff';
  g.lineWidth = 1;
  for (let k = -512; k < 512; k += 6) {
    g.beginPath();
    g.moveTo(k, 0);
    g.lineTo(k + 512, 512);
    g.stroke();
  }
  g.restore();
  return canvas;
}

/** The small "RB-1" unit plate, 256 x 112 pixels. */
export function drawUnitMark(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 112;
  const g = canvas.getContext('2d')!;
  g.fillStyle = GOLD;
  g.beginPath();
  g.roundRect(2, 2, 252, 108, 18);
  g.fill();
  g.fillStyle = NAVY_DEEP;
  g.beginPath();
  g.roundRect(9, 9, 238, 94, 13);
  g.fill();
  g.fillStyle = GOLD_LIGHT;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 62px "Arial Black", Arial, sans-serif';
  g.fillText('RB-1', 128, 58);
  return canvas;
}

function decal(canvas: HTMLCanvasElement, width: number, height: number): THREE.Mesh {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshStandardMaterial({
      map: texture,
      alphaTest: 0.5,
      roughness: 0.85,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    }),
  );
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.raycast = noRaycast;
  return mesh;
}

/** The link's extent in its own body frame, from the meshes the body group holds. */
function localBounds(group: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  for (const child of group.children) {
    if (!(child instanceof THREE.Mesh)) continue;
    child.updateMatrix();
    child.geometry.computeBoundingBox();
    box.union(child.geometry.boundingBox!.clone().applyMatrix4(child.matrix));
  }
  return box;
}

/**
 * Puts the patch on the upper arm's +x face (the side the default camera sees) and the RB-1
 * plate on its -x face. Upper_Arm's local y runs along the link, so the badge's top points
 * toward the elbow. Two extra draw calls in all.
 */
export function attachMissionPatch(viewport: Viewport): THREE.Mesh[] {
  const group = viewport.bodyGroup(UPPER_ARM_BODY);
  if (!group) return [];
  const box = localBounds(group);
  if (box.isEmpty()) return [];
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const diameter = THREE.MathUtils.clamp(Math.min(size.y, size.z) * 0.82, 0.018, 0.05);

  const patch = decal(drawMissionPatch(), diameter, diameter);
  patch.name = 'mission-patch';
  patch.rotation.y = Math.PI / 2;
  patch.position.set(box.max.x + LIFT_M, centre.y, centre.z);

  const plateWidth = diameter * 0.8;
  const plate = decal(drawUnitMark(), plateWidth, (plateWidth * 112) / 256);
  plate.name = 'unit-mark';
  plate.rotation.y = -Math.PI / 2;
  plate.position.set(box.min.x - LIFT_M, centre.y, centre.z);

  group.add(patch, plate);
  return [patch, plate];
}
