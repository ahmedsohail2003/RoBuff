import type { MjModel } from '@mujoco/mujoco';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Mujoco } from '../sim/mujocoRuntime';
import { DEFAULT_VIEW } from './defaultView';
import { buildBodyGroups } from './modelMeshes';


/** Three.js scene in MuJoCo's own coordinates: metres, with z up. */
export class Viewport {
  private readonly renderer: THREE.WebGLRenderer;
  /** Readable so scene dressing (render/spaceScene.ts) can add to it and restyle it. */
  readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly bodies: THREE.Group[];
  private orbitButton: 'left' | 'right' = 'left';

  constructor(container: HTMLElement, mujoco: Mujoco, model: MjModel) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0xe8eaee);
    this.camera = new THREE.PerspectiveCamera(DEFAULT_VIEW.fovDeg, 1, 0.01, 20);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(...DEFAULT_VIEW.position);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(...DEFAULT_VIEW.target);
    this.controls.enableDamping = true;
    this.controls.update();

    this.addLights(model);
    this.bodies = buildBodyGroups(mujoco, model);
    this.scene.add(...this.bodies);
    this.addFloorGrid();

    window.addEventListener('resize', this.resize);
    this.resize();
  }

  /** Moves each body group to its simulated pose. Quaternions arrive as w, x, y, z. */
  syncBodies(xpos: Float64Array, xquat: Float64Array): void {
    this.bodies.forEach((group, id) => {
      group.position.set(xpos[3 * id]!, xpos[3 * id + 1]!, xpos[3 * id + 2]!);
      group.quaternion.set(xquat[4 * id + 1]!, xquat[4 * id + 2]!, xquat[4 * id + 3]!, xquat[4 * id]!);
    });
  }

  /**
   * Which mouse button orbits the camera. Mouse mode uses the right one, so a left click on
   * the view can open and close the jaw; middle drag pans there. Other modes keep the default.
   */
  setOrbitButton(button: 'left' | 'right'): void {
    if (button === this.orbitButton) return;
    this.orbitButton = button;
    this.controls.mouseButtons =
      button === 'right'
        ? { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
        : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  }

  get orbitsWith(): 'left' | 'right' {
    return this.orbitButton;
  }

  /** The three.js group drawn at one MuJoCo body's pose, so another module can swap what it shows. */
  bodyGroup(id: number): THREE.Group | undefined {
    return this.bodies[id];
  }

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** Name of the GPU or software rasterizer, what the last frame drew, and where the camera is. */
  stats(): { gpu: string; drawCalls: number; triangles: number; camera: [number, number, number]; orbitsWith: 'left' | 'right' } {
    const gl = this.renderer.getContext();
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      gpu: String(gl.getParameter(debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      camera: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      orbitsWith: this.orbitButton,
    };
  }

  /** Lights come from the compiled model, plus a soft fill so shaded sides stay readable. */
  private addLights(model: MjModel): void {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9098a0, 1.4));
    const positions = model.light_pos as Float64Array;
    const directions = model.light_dir as Float64Array;
    for (let id = 0; id < model.nlight; id++) {
      const light = new THREE.DirectionalLight(0xffffff, 2);
      const position = new THREE.Vector3(positions[3 * id]!, positions[3 * id + 1]!, positions[3 * id + 2]!);
      const direction = new THREE.Vector3(directions[3 * id]!, directions[3 * id + 1]!, directions[3 * id + 2]!);
      light.position.copy(position);
      light.target.position.copy(position).add(direction);
      light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.camera.left = -0.6;
      light.shadow.camera.right = 0.6;
      light.shadow.camera.top = 0.6;
      light.shadow.camera.bottom = -0.6;
      light.shadow.camera.far = 4;
      this.scene.add(light, light.target);
    }
  }

  /** Grid lines every 10 cm on the floor, as a scale reference. */
  private addFloorGrid(): void {
    const grid = new THREE.GridHelper(2, 20, 0x8a93a0, 0xb4bbc5);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = 0.0005;
    this.scene.add(grid);
  }

  private readonly resize = (): void => {
    const parent = this.renderer.domElement.parentElement;
    if (!parent) return;
    const { clientWidth: width, clientHeight: height } = parent;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };
}
