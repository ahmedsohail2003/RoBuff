import type { ControlLoop } from './control/controlLoop';
import type { Viewport } from './render/viewport';
import type { Simulation, Vec3 } from './sim/simulation';

/** Keeps a slow frame from queueing up physics it can never catch up on. */
const MAX_PHYSICS_MS_PER_FRAME = 50;
const FPS_WINDOW_MS = 1000;

/** Runs control and physics in (scaled) real time and draws one frame per animation frame. */
export class App {
  renderFrames = 0;
  lastPhysicsMs = 0;
  fps = 0;
  /** Simulated seconds per wall-clock second. Tests raise it to run long scripts faster. */
  speed = 1;

  private lastFrameMs: number | null = null;
  private owedSimSeconds = 0;
  private windowStartMs = 0;
  private windowFrames = 0;

  constructor(
    readonly loop: ControlLoop,
    readonly viewport: Viewport,
    private readonly onFrame: () => void = () => {},
  ) {}

  get sim(): Simulation {
    return this.loop.sim;
  }

  start(): void {
    this.syncAndRender();
    requestAnimationFrame(this.frame);
  }

  /** Direct commands, as from the debug hook. They detach the input source. */
  setTarget(target: Vec3): void {
    this.loop.source = null;
    this.loop.controller.setTarget(target);
  }

  setGrip(grip: number): void {
    this.loop.source = null;
    this.loop.controller.setGrip(grip);
  }

  private readonly frame = (nowMs: number): void => {
    requestAnimationFrame(this.frame);
    const elapsedMs = this.lastFrameMs === null ? 0 : nowMs - this.lastFrameMs;
    this.lastFrameMs = nowMs;

    this.owedSimSeconds += (Math.min(elapsedMs, MAX_PHYSICS_MS_PER_FRAME) / 1000) * this.speed;
    const steps = Math.floor(this.owedSimSeconds / this.sim.timestep);
    this.owedSimSeconds -= steps * this.sim.timestep;

    const physicsStart = performance.now();
    this.loop.advance(steps);
    this.lastPhysicsMs = performance.now() - physicsStart;

    this.syncAndRender();
    this.renderFrames++;
    this.updateFps(nowMs);
    this.onFrame();
  };

  private syncAndRender(): void {
    const { xpos, xquat } = this.sim.bodyPoses();
    this.viewport.syncBodies(xpos, xquat);
    this.viewport.render();
  }

  private updateFps(nowMs: number): void {
    this.windowFrames++;
    const windowMs = nowMs - this.windowStartMs;
    if (windowMs >= FPS_WINDOW_MS) {
      this.fps = (this.windowFrames * 1000) / windowMs;
      this.windowStartMs = nowMs;
      this.windowFrames = 0;
    }
  }
}
