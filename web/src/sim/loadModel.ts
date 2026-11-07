import type { MjModel } from '@mujoco/mujoco';
import { meshFilesIn } from './armXml';
import { ARM_XML, SCENE_XML, compileModel } from './compileModel';
import type { Mujoco } from './mujocoRuntime';

const MODEL_DIR = `${import.meta.env.BASE_URL}models/so_arm100/`;

async function fetchOk(path: string): Promise<Response> {
  const response = await fetch(MODEL_DIR + path);
  if (!response.ok) throw new Error(`could not fetch ${path}: HTTP ${response.status}`);
  return response;
}

async function fetchText(path: string): Promise<string> {
  return (await fetchOk(path)).text();
}

async function fetchBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetchOk(path)).arrayBuffer());
}

/** Fetches the scene files over HTTP and compiles them. */
export async function loadModel(mujoco: Mujoco): Promise<MjModel> {
  const [armXml, sceneXml] = await Promise.all([fetchText(ARM_XML), fetchText(SCENE_XML)]);
  const meshPaths = meshFilesIn(armXml).map((file) => `assets/${file}`);
  const meshes = await Promise.all(meshPaths.map(fetchBytes));
  return compileModel(mujoco, { armXml, sceneXml, meshes: new Map(meshPaths.map((path, i) => [path, meshes[i]!])) });
}
