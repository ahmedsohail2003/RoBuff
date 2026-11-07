import type { MjModel } from '@mujoco/mujoco';
import * as THREE from 'three';
import type { Mujoco } from '../sim/mujocoRuntime';

/** MJCF geom group used by the arm's collision geoms. They are not drawn. */
const COLLISION_GROUP = 3;
const INFINITE_PLANE_HALF_SIZE = 5;

/** Builds a triangle soup from the compiled mesh, with the normals MuJoCo computed. */
function meshGeometry(model: MjModel, meshId: number): THREE.BufferGeometry {
  const vertexStart = (model.mesh_vertadr as Int32Array)[meshId]!;
  const normalStart = (model.mesh_normaladr as Int32Array)[meshId]!;
  const faceStart = (model.mesh_faceadr as Int32Array)[meshId]!;
  const faceCount = (model.mesh_facenum as Int32Array)[meshId]!;
  const vertices = model.mesh_vert as Float32Array;
  const normals = model.mesh_normal as Float32Array;
  const faces = model.mesh_face as Int32Array;
  const faceNormals = model.mesh_facenormal as Int32Array;

  const positions = new Float32Array(faceCount * 9);
  const cornerNormals = new Float32Array(faceCount * 9);
  for (let corner = 0; corner < faceCount * 3; corner++) {
    const vertex = vertexStart + faces[3 * faceStart + corner]!;
    const normal = normalStart + faceNormals[3 * faceStart + corner]!;
    for (let axis = 0; axis < 3; axis++) {
      positions[3 * corner + axis] = vertices[3 * vertex + axis]!;
      cornerNormals[3 * corner + axis] = normals[3 * normal + axis]!;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(cornerNormals, 3));
  return geometry;
}

function primitiveGeometry(mujoco: Mujoco, type: number, size: number[]): THREE.BufferGeometry | null {
  const [a = 0, b = 0, c = 0] = size;
  const kinds = mujoco.mjtGeom;
  switch (type) {
    case kinds.mjGEOM_PLANE.value:
      return new THREE.PlaneGeometry(2 * (a || INFINITE_PLANE_HALF_SIZE), 2 * (b || INFINITE_PLANE_HALF_SIZE));
    case kinds.mjGEOM_SPHERE.value:
      return new THREE.SphereGeometry(a, 24, 16);
    case kinds.mjGEOM_BOX.value:
      return new THREE.BoxGeometry(2 * a, 2 * b, 2 * c);
    case kinds.mjGEOM_CYLINDER.value:
      return new THREE.CylinderGeometry(a, a, 2 * b, 24).rotateX(Math.PI / 2);
    case kinds.mjGEOM_CAPSULE.value:
      return new THREE.CapsuleGeometry(a, 2 * b, 8, 24).rotateX(Math.PI / 2);
    default:
      return null;
  }
}

function geomColor(model: MjModel, geomId: number): { color: THREE.Color; opacity: number } {
  const materialId = (model.geom_matid as Int32Array)[geomId]!;
  const rgba = (materialId >= 0 ? model.mat_rgba : model.geom_rgba) as Float32Array;
  const offset = 4 * (materialId >= 0 ? materialId : geomId);
  return {
    color: new THREE.Color().setRGB(rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!),
    opacity: rgba[offset + 3]!,
  };
}

/**
 * One group per MuJoCo body, each holding its geoms at their fixed offsets from the
 * body. Every frame only the groups move, using body poses from the simulation.
 */
export function buildBodyGroups(mujoco: Mujoco, model: MjModel): THREE.Group[] {
  const groups = Array.from({ length: model.nbody }, () => new THREE.Group());
  const meshCache = new Map<number, THREE.BufferGeometry>();
  const geomGroup = model.geom_group as Int32Array;
  const geomType = model.geom_type as Int32Array;
  const geomMesh = model.geom_dataid as Int32Array;
  const geomBody = model.geom_bodyid as Int32Array;
  const geomPos = model.geom_pos as Float64Array;
  const geomQuat = model.geom_quat as Float64Array;
  const geomSize = model.geom_size as Float64Array;
  const meshKind = mujoco.mjtGeom.mjGEOM_MESH.value;
  const planeKind = mujoco.mjtGeom.mjGEOM_PLANE.value;

  for (let geomId = 0; geomId < model.ngeom; geomId++) {
    if (geomGroup[geomId] === COLLISION_GROUP) continue;
    const type = geomType[geomId]!;
    let geometry: THREE.BufferGeometry | null;
    if (type === meshKind) {
      const meshId = geomMesh[geomId]!;
      geometry = meshCache.get(meshId) ?? meshGeometry(model, meshId);
      meshCache.set(meshId, geometry);
    } else {
      geometry = primitiveGeometry(mujoco, type, Array.from(geomSize.subarray(3 * geomId, 3 * geomId + 3)));
    }
    if (!geometry) throw new Error(`no renderer for geom ${geomId} of type ${type}`);

    const { color, opacity } = geomColor(model, geomId);
    const material = new THREE.MeshStandardMaterial({
      color,
      opacity,
      transparent: opacity < 1,
      roughness: 0.65,
      metalness: 0.05,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = type !== planeKind;
    mesh.receiveShadow = true;
    mesh.position.set(geomPos[3 * geomId]!, geomPos[3 * geomId + 1]!, geomPos[3 * geomId + 2]!);
    // MuJoCo quaternions are w, x, y, z. Three.js takes x, y, z, w.
    mesh.quaternion.set(
      geomQuat[4 * geomId + 1]!,
      geomQuat[4 * geomId + 2]!,
      geomQuat[4 * geomId + 3]!,
      geomQuat[4 * geomId]!,
    );
    groups[geomBody[geomId]!]!.add(mesh);
  }
  return groups;
}
