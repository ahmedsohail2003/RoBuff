// Wires the Earth-Moon delay into a running app: the rig, the ghost meshes, the delay panel,
// the trial HUD (?trial=1) and the debug hooks. One call from main.ts.

import type { App } from '../app';
import { GhostMeshes } from '../render/ghostMeshes';
import { compileModel } from '../sim/compileModel';
import type { Mujoco } from '../sim/mujocoRuntime';
import { fetchModelFiles } from '../sim/objectSlot';
import { physicsOnlyFilesAsync } from '../sim/physicsScene';
import type { Vec3 } from '../sim/simulation';
import { csvFileName, sidecar, toCsv, type TrialRow } from '../trials/logger';
import { TrialRunner } from '../trials/runner';
import { DelayPanel } from '../ui/errorMeter';
import { downloadSession, TrialHud } from '../ui/trialHud';
import { DelayRig, DELAY_MODES, rockOnModel, type DelayMode } from './dualSim';
import type { GhostError } from './ghostError';

/** Shown in the trial CSV: the build's mode (no git hash is baked into the bundle). */
const BUILD_ID = `aftergrip-${import.meta.env.MODE}`;

export interface DelayHook {
  /** Switches mode as the panel does (resets the scene). Resolves when the ghost is ready. */
  setDelayMode(mode: string): Promise<{ mode: DelayMode; ghostCompileMs: number | null }>;
  delayState(): {
    mode: DelayMode;
    simTime: number;
    /** Truth gripper now (not yet visible to the operator). */
    truthGripper: Vec3 | null;
    /** Truth gripper as the screen draws it now (1.28 s old in the Moon modes). */
    seenGripper: Vec3;
    seenRock: Vec3 | null;
    truthRock: Vec3 | null;
    ghostGripper: Vec3 | null;
    ghostRock: Vec3 | null;
    ghostVisible: boolean;
    ghostMeshes: number;
    error: GhostError | null;
    truthRockModel: { mass_g: number; friction: number; priority: number } | null;
    ghostRockModel: { mass_g: number; friction: number; priority: number } | null;
    notice: string | null;
  };
  /** Runs the next trial of the session with this countdown (seconds) and resolves with its row. */
  runTrial(countdownS?: number): Promise<TrialRow>;
  trialCsv(): string;
  trialSidecar(): Record<string, unknown>;
  trialCsvName(): string;
  readonly trialRows: number;
}

declare module '../test-hooks' {
  interface SimHook extends Partial<DelayHook> {}
}

export function mountDelay(app: App, mujoco: Mujoco, withHooks: boolean): DelayRig {
  let ghostCompileMs: number | null = null;
  const rig = new DelayRig(mujoco, app.loop, async () => {
    const files = await physicsOnlyFilesAsync(await fetchModelFiles());
    const t0 = performance.now();
    const model = compileModel(mujoco, files);
    ghostCompileMs = performance.now() - t0;
    return model;
  });

  // Ghost copies of the moving bodies, cloned now while the viewport draws the arena (rock in the slot).
  const model = app.sim.model;
  const jntnum = model.body_jntnum as Int32Array;
  const parent = model.body_parentid as Int32Array;
  const staticBodies = new Set<number>();
  for (let id = 1; id < model.nbody; id++) if (jntnum[id] === 0 && parent[id] === 0) staticBodies.add(id);
  const ghost = new GhostMeshes(app.viewport, model.nbody, staticBodies);

  app.physics = (steps) => rig.advance(steps);
  app.viewPoses = () => {
    ghost.sync(rig.ghostPoses(), rig.ghostNow()?.gripper ?? null);
    return rig.viewPoses();
  };

  const panel = new DelayPanel(rig);
  const params = new URLSearchParams(location.search);
  let runner: TrialRunner | null = null;
  let hud: TrialHud | null = null;
  const trialsWanted = params.get('trial') === '1';
  const makeRunner = (): TrialRunner => {
    const kind = app.loop.source?.kind ?? 'mouse';
    const blocks = Number(params.get('blocks') ?? '3');
    runner = new TrialRunner(rig, {
      operator: params.get('operator') ?? (kind === 'synthetic' ? 'synthetic-hand' : 'ahmed'),
      buildId: BUILD_ID,
      blocks: blocks === 4 ? 4 : 3,
      fps: () => app.fps,
      persist: params.get('persist') !== '0',
    });
    return runner;
  };
  if (trialsWanted) hud = new TrialHud(makeRunner());

  let lastUi = 0;
  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    if (now - lastUi < 100) return;
    lastUi = now;
    panel.locked = runner !== null && (runner.state === 'countdown' || runner.state === 'running');
    panel.update();
    hud?.update();
  };
  requestAnimationFrame(frame);

  if (withHooks && window.__sim) {
    const hooks: DelayHook = {
      async setDelayMode(mode) {
        if (!(DELAY_MODES as readonly string[]).includes(mode)) throw new Error(`unknown delay mode ${mode}`);
        await rig.setMode(mode as DelayMode);
        return { mode: rig.mode, ghostCompileMs };
      },
      delayState() {
        const seen = rig.seenTruth();
        const ghostNow = rig.ghostNow();
        return {
          mode: rig.mode,
          simTime: app.sim.time,
          truthGripper: app.sim.getSitePos('gripper'),
          seenGripper: seen.gripper,
          seenRock: seen.rock,
          truthRock: app.sim.getBodyPos('cube'),
          ghostGripper: ghostNow?.gripper ?? null,
          ghostRock: ghostNow?.rock ?? null,
          ghostVisible: ghost.visible,
          ghostMeshes: ghost.meshCount,
          error: rig.error(),
          truthRockModel: rockOnModel(mujoco, app.sim.model),
          ghostRockModel: rig.ghostSim ? rockOnModel(mujoco, rig.ghostSim.model) : null,
          notice: rig.notice,
        };
      },
      runTrial(countdownS = 0) {
        return (runner ?? makeRunner()).runNext(countdownS);
      },
      trialCsv: () => toCsv((runner ?? makeRunner()).rows),
      trialSidecar: () => {
        const r = runner ?? makeRunner();
        return sidecar(r.settings, r.order, r.rows);
      },
      trialCsvName: () => csvFileName((runner ?? makeRunner()).settings.session_id),
      get trialRows() {
        return runner?.rows.length ?? 0;
      },
    };
    Object.defineProperties(window.__sim, Object.getOwnPropertyDescriptors(hooks));
    (window.__sim as unknown as { downloadTrials: () => void }).downloadTrials = () => runner && downloadSession(runner);
  }
  return rig;
}
