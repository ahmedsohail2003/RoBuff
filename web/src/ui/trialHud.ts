// The trial HUD (?trial=1): "Trial k/N: GHOST ON", a Start button, the 3-2-1-GO countdown,
// the running clock, the last result, and the CSV and JSON downloads.

import { csvFileName, sidecar, toCsv } from '../trials/logger';
import { CONDITION_LABEL, PROTOCOL } from '../trials/protocol';
import type { TrialRunner } from '../trials/runner';
import { leftStack } from './errorMeter';

const STYLE = `
#trial-hud { width: 340px; box-sizing: border-box;
  padding: 8px 12px; border: 1px solid #7fd8ff; border-radius: 6px; background: rgba(10, 12, 20, 0.92); color: #dfe6f0;
  font: 13px/1.4 system-ui, sans-serif; text-align: center; }
#trial-hud .title { font-weight: 700; font-size: 15px; letter-spacing: .02em; }
#trial-hud .count { font-size: 44px; font-weight: 800; line-height: 1.1; color: #7fd8ff; }
#trial-hud .row { display: flex; gap: 6px; justify-content: center; margin-top: 6px; flex-wrap: wrap; }
#trial-hud button { padding: 4px 10px; border: 1px solid #4a5870; border-radius: 4px; background: #182030; color: #dfe6f0; font: inherit; cursor: pointer; }
#trial-hud button.primary { background: #2b5d86; border-color: #7fd8ff; }
#trial-hud button:disabled { opacity: .5; cursor: default; }
#trial-hud .small { color: #a9b4c4; font-size: 12px; }
#trial-hud [hidden] { display: none; }
`;

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadSession(runner: TrialRunner): void {
  const id = runner.settings.session_id;
  download(csvFileName(id), toCsv(runner.rows), 'text/csv');
  download(`ghost-gate-${id}.json`, JSON.stringify(sidecar(runner.settings, runner.order, runner.rows), null, 2), 'application/json');
}

export class TrialHud {
  readonly element: HTMLElement;
  private readonly title: HTMLElement;
  private readonly count: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly result: HTMLElement;
  private readonly start: HTMLButtonElement;
  private readonly save: HTMLButtonElement;
  private readonly fresh: HTMLButtonElement;
  private wasFinished = false;

  constructor(
    private readonly runner: TrialRunner,
    parent: HTMLElement = document.body,
  ) {
    if (!document.getElementById('trial-hud-style')) {
      const style = document.createElement('style');
      style.id = 'trial-hud-style';
      style.textContent = STYLE;
      document.head.appendChild(style);
    }
    const hud = (this.element = document.createElement('section'));
    hud.id = 'trial-hud';
    hud.dataset.testid = 'trial-hud';
    const el = (cls: string, testid: string): HTMLElement => {
      const e = document.createElement('div');
      e.className = cls;
      e.dataset.testid = testid;
      return e;
    };
    this.title = el('title', 'trial-title');
    this.count = el('count', 'trial-countdown');
    this.clock = el('small', 'trial-clock');
    this.result = el('small', 'trial-result');
    const button = (text: string, cls = ''): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.className = cls;
      return b;
    };
    this.start = button('Start trial', 'primary');
    this.start.dataset.testid = 'trial-start';
    this.start.addEventListener('click', () => void runner.runNext().catch(() => this.update()));
    this.save = button('Download CSV + JSON');
    this.save.dataset.testid = 'trial-download';
    this.save.addEventListener('click', () => downloadSession(runner));
    this.fresh = button('New session');
    this.fresh.addEventListener('click', () => {
      if (runner.rows.length === 0 || confirm(`Start a new session? The ${runner.rows.length} logged rows stay downloadable only until then.`)) runner.newSession();
    });
    const row = document.createElement('div');
    row.className = 'row';
    row.append(this.start, this.save, this.fresh);
    const rules = el('small', 'trial-rules');
    rules.textContent = `Lift the rock: its lowest point ${PROTOCOL.liftMinM * 1000} mm up, both pads on it, ${PROTOCOL.liftHoldS} s. Cutoff ${PROTOCOL.cutoffS} s. Moon gravity. Simulation.`;
    hud.append(this.title, this.count, this.clock, this.result, row, rules);
    leftStack(parent).prepend(hud);
    runner.changed.add(() => this.update());
    this.update();
  }

  /** Called on runner changes and every frame (for the clock). */
  update(): void {
    const r = this.runner;
    const spec = r.current;
    const index = r.state === 'running' || r.state === 'countdown' ? r.rows.length : r.nextIndex;
    this.title.textContent = spec && index !== null
      ? `Trial ${index + 1}/${r.order.length}: ${CONDITION_LABEL[spec.condition]}${spec.practice ? ' (practice)' : ''}`
      : `Session done: ${r.rows.length} trials logged`;
    this.count.hidden = r.countdown === null;
    this.count.textContent = r.countdown === 0 ? 'GO' : String(r.countdown ?? '');
    const elapsed = r.elapsed();
    this.clock.textContent = elapsed === null ? `session ${r.settings.session_id}, operator ${r.settings.operator}` : `${elapsed.toFixed(1)} s since GO (simulated clock)`;
    const last = r.lastOutcome;
    this.result.textContent = r.error
      ? r.error
      : last
        ? `Last trial: ${last.excluded ? `excluded (${last.exclude_reason}), repeated at the end` : last.success ? `stable lift at ${last.completion_s!.toFixed(2)} s` : `no stable lift by the ${PROTOCOL.cutoffS} s cutoff`}`
        : '';
    const busy = r.state === 'countdown' || r.state === 'running';
    this.start.disabled = busy || r.nextIndex === null;
    this.start.textContent = r.nextIndex === null ? 'All trials done' : `Start trial ${r.nextIndex + 1}`;
    this.save.disabled = busy || r.rows.length === 0;
    this.fresh.disabled = busy;
    if (r.state === 'finished' && !this.wasFinished) downloadSession(r);
    this.wasFinished = r.state === 'finished';
  }
}
