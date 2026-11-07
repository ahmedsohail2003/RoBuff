import loadMujoco, { type MainModule } from '@mujoco/mujoco';
import wasmUrl from '@mujoco/mujoco/mujoco.wasm?url';

export type Mujoco = MainModule;

export function loadMujocoRuntime(): Promise<Mujoco> {
  return loadMujoco({ locateFile: () => wasmUrl });
}
