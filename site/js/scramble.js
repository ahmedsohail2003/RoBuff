// Scramble text: cycles an element through phrases, each character running through random glyphs
// before it settles. Screen readers get the full sentence from a separate sr-only span.

const GLYPHS = 'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789#%&*+=<>/';

export function mountScramble(el, phrases, { interval = 2800, duration = 600 } = {}) {
  if (!el || !phrases || phrases.length < 2) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let index = 0;
  let timer = 0;

  function scrambleTo(next) {
    const from = el.textContent;
    const len = Math.max(from.length, next.length);
    const settleAt = Array.from({ length: len }, (_, i) => (i / len) * duration * 0.6 + Math.random() * duration * 0.4);
    const t0 = performance.now();
    function frame(now) {
      const t = now - t0;
      let html = '';
      let done = true;
      for (let i = 0; i < len; i++) {
        if (t >= settleAt[i]) {
          html += escapeHtml(next[i] || '');
        } else {
          done = false;
          const ch = next[i] || from[i] || '';
          html += ch === ' ' ? ' ' : `<span class="glyph">${escapeHtml(GLYPHS[(Math.random() * GLYPHS.length) | 0])}</span>`;
        }
      }
      el.innerHTML = html;
      if (!done) requestAnimationFrame(frame);
      else el.textContent = next;
    }
    requestAnimationFrame(frame);
  }

  function tick() {
    index = (index + 1) % phrases.length;
    if (reduce.matches) el.textContent = phrases[index];
    else scrambleTo(phrases[index]);
  }

  function start() {
    stop();
    timer = window.setInterval(tick, interval);
  }
  function stop() {
    window.clearInterval(timer);
  }
  el.textContent = phrases[0];
  // With reduced motion the line stays still on the first phrase.
  if (!reduce.matches) start();
  reduce.addEventListener('change', () => (reduce.matches ? stop() : start()));
  document.addEventListener('visibilitychange', () => (document.hidden || reduce.matches ? stop() : start()));
}

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ENTITIES[c]);
}
