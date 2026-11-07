import type { MjModel } from '@mujoco/mujoco';
import { patchArmXml } from './armXml';
import type { Mujoco } from './mujocoRuntime';

export const ARM_XML = 'so_arm100.xml';
export const SCENE_XML = 'arena.xml';

export interface ModelFiles {
  armXml: string;
  sceneXml: string;
  /** Keyed by the path the arm XML resolves, such as assets/Base.stl. */
  meshes: Map<string, Uint8Array>;
}

/** Places the scene files in a MuJoCo virtual file system and compiles them. */
export function compileModel(mujoco: Mujoco, files: ModelFiles): MjModel {
  const encoder = new TextEncoder();
  const vfs = new mujoco.MjVFS();
  try {
    vfs.addBuffer(ARM_XML, encoder.encode(patchArmXml(files.armXml)));
    vfs.addBuffer(SCENE_XML, encoder.encode(files.sceneXml));
    for (const [path, bytes] of files.meshes) vfs.addBuffer(path, bytes);
    return mujoco.MjModel.from_xml_path(SCENE_XML, vfs);
  } finally {
    vfs.delete();
  }
}
