// One shared pointer for every animated piece on the page: the mouse or touch position as -1..1 across
// the window (y up), plus the raw client position. Each piece eases toward it on its own frames.
// Under prefers-reduced-motion nothing listens, so every piece holds its still pose.

export const pointer = { x: 0, y: 0, cx: -1, cy: -1, active: false };

let tracking = false;

export function trackPointer() {
  if (tracking) return pointer;
  tracking = true;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return pointer;
  const set = (x, y) => {
    pointer.cx = x;
    pointer.cy = y;
    pointer.x = (x / Math.max(1, window.innerWidth)) * 2 - 1;
    pointer.y = -((y / Math.max(1, window.innerHeight)) * 2 - 1);
    pointer.active = true;
  };
  window.addEventListener('pointermove', (e) => set(e.clientX, e.clientY), { passive: true });
  const touch = (e) => {
    if (e.touches && e.touches[0]) set(e.touches[0].clientX, e.touches[0].clientY);
  };
  window.addEventListener('touchstart', touch, { passive: true });
  window.addEventListener('touchmove', touch, { passive: true });
  return pointer;
}
