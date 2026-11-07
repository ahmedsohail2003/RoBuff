// The permanent top-left label: everything on screen is a physics simulation. It is never
// hidden and has no close button.

export const SIMULATION_LABEL_TEXT = 'SIMULATION: both arms are physics simulations. Delay and gravity are modelled. No real robot.';

const STYLE = `
#simulation-label { position: fixed; left: 12px; top: 12px; z-index: 6; max-width: min(560px, calc(100vw - 380px));
  padding: 5px 10px; border: 1px solid #f2c14e; border-radius: 4px; background: rgba(10, 12, 20, 0.88); color: #f2c14e;
  font: 600 12px/1.35 system-ui, sans-serif; letter-spacing: .02em; pointer-events: none; }
/* The status line sat in this corner; it moves down under the label. */
#status { top: 48px; }
`;

export function mountSimulationLabel(parent: HTMLElement = document.body): HTMLElement {
  const existing = document.getElementById('simulation-label');
  if (existing) return existing;
  const style = document.createElement('style');
  style.id = 'simulation-label-style';
  style.textContent = STYLE;
  document.head.appendChild(style);
  const label = document.createElement('div');
  label.id = 'simulation-label';
  label.setAttribute('role', 'note');
  label.dataset.testid = 'simulation-label';
  label.textContent = SIMULATION_LABEL_TEXT;
  parent.appendChild(label);
  return label;
}
