// The delay panel: the three modes, the delay with its numbers, the hidden-mismatch line and
// the ghost error meter (green under 5 mm, amber to 20, red above with "wait for truth").

import { delayText } from '../delay/delayLine';
import { DELAY_MODES, GHOST_ROCK, TRUTH_ROCK, rockMassKg, type DelayMode, type DelayRig } from '../delay/dualSim';
import { AMBER_TO_MM, errorCue, GREEN_BELOW_MM } from '../delay/ghostError';
import { gravity, setGravity } from '../sim/gravity';

export const MODE_LABEL: Record<DelayMode, string> = {
  direct: 'Direct',
  moon_ghost_off: 'Moon, ghost off',
  moon_ghost_on: 'Moon, ghost on',
};

const g = (rock: typeof TRUTH_ROCK) => Math.round(rockMassKg(rock) * 1000);
export const MISMATCH_TEXT =
  `The ghost does not know the rock's true mass: the true rock is ${g(TRUTH_ROCK)} g (${TRUTH_ROCK.density_kg_m3 / 1000} g/cm3), friction ${TRUTH_ROCK.friction}; ` +
  `the ghost assumes ${g(GHOST_ROCK)} g (${GHOST_ROCK.density_kg_m3 / 1000} g/cm3), friction ${GHOST_ROCK.friction}.`;

const STYLE = `
#left-stack { position: fixed; left: 12px; top: 84px; z-index: 6; display: flex; flex-direction: column; gap: 8px; }
#delay-panel { width: 340px; box-sizing: border-box;
  padding: 8px 10px; border: 1px solid #39465c; border-radius: 6px; background: rgba(10, 12, 20, 0.9); color: #dfe6f0; font: 12px/1.4 system-ui, sans-serif; }
#delay-panel .modes { display: flex; gap: 4px; margin-bottom: 4px; }
#delay-panel button { flex: 1; padding: 4px 6px; border: 1px solid #4a5870; border-radius: 4px; background: #182030; color: #dfe6f0; font: inherit; cursor: pointer; }
#delay-panel button[aria-pressed="true"] { background: #2b5d86; border-color: #7fd8ff; }
#delay-panel button:disabled { opacity: .5; cursor: default; }
#delay-panel .line { color: #a9b4c4; }
#delay-panel .meter { display: flex; gap: 10px; align-items: baseline; margin-top: 4px; font-variant-numeric: tabular-nums; }
#delay-panel .meter b { font-size: 14px; }
#delay-panel [data-level="green"] { color: #5fd38a; }
#delay-panel [data-level="amber"] { color: #f2c14e; }
#delay-panel [data-level="red"] { color: #ff6b6b; }
#delay-panel .cue { font-weight: 700; }
#delay-panel .notice { color: #f2c14e; }
#delay-panel [hidden] { display: none; }
`;

/** The column under the status line, top left, shared by the delay panel and the trial HUD. */
export function leftStack(parent: HTMLElement = document.body): HTMLElement {
  let stack = document.getElementById('left-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'left-stack';
    parent.appendChild(stack);
  }
  return stack;
}

export class DelayPanel {
  readonly element: HTMLElement;
  private readonly buttons = new Map<DelayMode, HTMLButtonElement>();
  private readonly delayLine: HTMLElement;
  private readonly mismatch: HTMLElement;
  private readonly meter: HTMLElement;
  private readonly gripper: HTMLElement;
  private readonly rock: HTMLElement;
  private readonly cue: HTMLElement;
  private readonly notice: HTMLElement;
  private busy = false;
  private message: string | null = null;
  /** Set while a trial session drives the mode. */
  locked = false;

  constructor(
    private readonly rig: DelayRig,
    parent: HTMLElement = document.body,
  ) {
    if (!document.getElementById('delay-panel-style')) {
      const style = document.createElement('style');
      style.id = 'delay-panel-style';
      style.textContent = STYLE;
      document.head.appendChild(style);
    }
    const panel = (this.element = document.createElement('section'));
    panel.id = 'delay-panel';
    panel.dataset.testid = 'delay-panel';
    panel.setAttribute('aria-label', 'Earth-Moon delay');
    const modes = document.createElement('div');
    modes.className = 'modes';
    for (const mode of DELAY_MODES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = MODE_LABEL[mode];
      button.dataset.delayMode = mode;
      button.addEventListener('click', () => void this.choose(mode));
      this.buttons.set(mode, button);
      modes.appendChild(button);
    }
    const line = (cls: string, testid: string): HTMLElement => {
      const el = document.createElement('div');
      el.className = cls;
      el.dataset.testid = testid;
      return el;
    };
    this.delayLine = line('line', 'delay-text');
    this.mismatch = line('line', 'ghost-mismatch');
    this.mismatch.textContent = MISMATCH_TEXT;
    this.meter = line('meter', 'error-meter');
    this.gripper = document.createElement('span');
    this.gripper.dataset.testid = 'error-gripper';
    this.rock = document.createElement('span');
    this.rock.dataset.testid = 'error-rock';
    this.cue = document.createElement('span');
    this.cue.className = 'cue';
    this.cue.dataset.testid = 'error-cue';
    this.meter.append(this.gripper, this.rock, this.cue);
    this.notice = line('notice', 'delay-notice');
    panel.append(modes, this.delayLine, this.mismatch, this.meter, this.notice);
    leftStack(parent).appendChild(panel);
    this.update();
  }

  async choose(mode: DelayMode): Promise<void> {
    if (this.busy || this.locked) return;
    this.busy = true;
    this.message = mode === 'moon_ghost_on' && !this.rig.ghostSim ? 'building the ghost arm ...' : null;
    this.update();
    try {
      await this.rig.setMode(mode);
      // The delay modes put the arm on the Moon: Moon gravity, which the menu can still change.
      if (mode !== 'direct' && gravity.current.id !== 'moon') setGravity('moon');
      this.message = null;
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.update();
    }
  }

  /** Called every frame. */
  update(): void {
    const rig = this.rig;
    for (const [mode, button] of this.buttons) {
      button.setAttribute('aria-pressed', String(rig.mode === mode));
      button.disabled = this.busy || this.locked;
    }
    this.delayLine.textContent = rig.moon
      ? `SIMULATED delay: ${delayText()}. You see the arm as it was 1.28 s ago.`
      : 'Direct: no delay. The arm answers at once.';
    this.mismatch.hidden = !rig.ghostOn;
    this.meter.hidden = !rig.ghostOn;
    if (rig.ghostOn) {
      const error = rig.error();
      if (!error) {
        this.gripper.textContent = 'ghost error: waiting for 2.56 s of history';
        this.gripper.removeAttribute('data-level');
        this.rock.textContent = '';
        this.cue.textContent = '';
        this.meter.dataset.level = 'none';
      } else {
        this.gripper.innerHTML = `gripper <b>${error.gripper_mm.toFixed(1)} mm</b>`;
        this.rock.innerHTML = error.rock_mm === null ? '' : `rock <b>${error.rock_mm.toFixed(1)} mm</b>`;
        this.cue.textContent = errorCue(error.level);
        for (const el of [this.gripper, this.rock, this.cue]) el.dataset.level = error.level;
        this.meter.dataset.level = error.level;
      }
      this.meter.title = `Truth as you see it now against where the ghost was when those commands were sent. Green under ${GREEN_BELOW_MM} mm, amber to ${AMBER_TO_MM} mm, red above.`;
    }
    const text = this.message ?? rig.notice;
    this.notice.hidden = !text;
    this.notice.textContent = text ?? '';
  }
}
