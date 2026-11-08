// Scroll reveals (fade-up once), counters that count up once when they come into view, and the rings.

const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function mountReveals() {
  const els = document.querySelectorAll('.reveal, .timeline');
  if (reduce() || !('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      });
    },
    // threshold 0: a tall block (the stacked loop panel on a phone) starts fading in as soon as
    // its top edge is 10% above the fold, never after a blank band has scrolled into view
    { threshold: 0, rootMargin: '0px 0px -10% 0px' },
  );
  els.forEach((el) => io.observe(el));
}

export function mountCounters() {
  const els = document.querySelectorAll('[data-count]');
  const show = (el, v) => {
    const dec = Number(el.dataset.decimals || 0);
    el.textContent = v.toFixed(dec) + (el.dataset.suffix || '');
  };
  if (reduce()) return; // the final values are already in the HTML
  els.forEach((el) => show(el, 0));
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        const el = e.target;
        const target = Number(el.dataset.count);
        const t0 = performance.now();
        const dur = 1400;
        const step = (now) => {
          const p = Math.min(1, (now - t0) / dur);
          const eased = 1 - Math.pow(1 - p, 3);
          show(el, target * eased);
          if (p < 1) requestAnimationFrame(step);
          else show(el, target);
        };
        requestAnimationFrame(step);
      });
    },
    { threshold: 0.4 },
  );
  els.forEach((el) => io.observe(el));
}

export function mountRings() {
  const rings = document.querySelectorAll('circle[data-ring]');
  rings.forEach((c) => {
    const len = 2 * Math.PI * Number(c.getAttribute('r'));
    c.style.strokeDasharray = String(len);
    c.style.strokeDashoffset = reduce() ? String(len * (1 - Number(c.dataset.ring))) : String(len);
  });
  if (reduce()) return;
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        const c = e.target;
        const len = 2 * Math.PI * Number(c.getAttribute('r'));
        c.style.strokeDashoffset = String(len * (1 - Number(c.dataset.ring)));
      });
    },
    { threshold: 0.5 },
  );
  rings.forEach((c) => io.observe(c));
}
