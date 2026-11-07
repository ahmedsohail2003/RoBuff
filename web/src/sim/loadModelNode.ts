/**
 * Node-only loader for unit tests and scripts: reads the model from public/ and starts
 * the WASM runtime without Vite's asset URL. Browser code must not import this file.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import loadMujoco, { type MjModel } from '@mujoco/mujoco';
import { meshFilesIn } from './armXml';
import { ARM_XML, SCENE_XML, compileModel } from './compileModel';
import type { Mujoco } from './mujocoRuntime';

const MODEL_DIR = path.resolve(import.meta.dirname, '../../public/models/so_arm100');

export async function loadNode(): Promise<{ mujoco: Mujoco; model: MjModel }> {
  const mujoco = await loadMujoco();
  const read = (file: string) => readFileSync(path.join(MODEL_DIR, file));
  const armXml = read(ARM_XML).toString('utf8');
  const meshPaths = meshFilesIn(armXml).map((file) => `assets/${file}`);
  const model = compileModel(mujoco, {
    armXml,
    sceneXml: read(SCENE_XML).toString('utf8'),
    meshes: new Map(meshPaths.map((meshPath) => [meshPath, new Uint8Array(read(meshPath))])),
  });
  return { mujoco, model };
}
