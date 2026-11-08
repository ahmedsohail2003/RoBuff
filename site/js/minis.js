// Small looping animations inside the three step cards' mini panels:
// the grip state toggling, the describe box typing, and the receipt ticking row by row.

export function mountMinis() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const grip = document.getElementById('mini-grip');
  const typed = document.getElementById('mini-type');
  const ticks = document.getElementById('mini-ticks');
  const pass = document.getElementById('mini-pass');
  const items = ticks ? [...ticks.querySelectorAll('li')] : [];

  if (reduce) {
    items.forEach((li) => li.classList.add('done'));
    if (pass) pass.classList.add('on');
    return;
  }

  const onScreen = (el, fn) => {
    if (!el) return;
    let id = 0;
    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !id) id = fn();
      else if (!entries[0].isIntersecting && id) {
        clearInterval(id);
        id = 0;
      }
    }).observe(el);
  };

  onScreen(grip, () => {
    let closed = false;
    return setInterval(() => {
      closed = !closed;
      grip.textContent = closed ? 'closed' : 'open';
    }, 1600);
  });

  if (typed) {
    const full = typed.textContent;
    onScreen(typed, () => {
      let n = 0;
      return setInterval(() => {
        n = n > full.length + 24 ? 0 : n + 1;
        typed.textContent = full.slice(0, Math.min(n, full.length)) + (n <= full.length ? '|' : '');
      }, 70);
    });
  }

  onScreen(ticks, () => {
    let n = 0;
    return setInterval(() => {
      n = (n + 1) % (items.length + 4);
      items.forEach((li, i) => li.classList.toggle('done', i < n));
      if (pass) pass.classList.toggle('on', n >= items.length);
    }, 500);
  });
}
