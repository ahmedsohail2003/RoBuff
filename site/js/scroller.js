// Pinned horizontal scroller: the section is tall, its inner viewport sticks, and the card track
// slides left as you scroll. Below 901px the cards stack vertically (CSS) and this does nothing.

export function mountScroller() {
  const section = document.querySelector('.steps');
  const track = document.getElementById('track');
  if (!section || !track) return;
  const wide = window.matchMedia('(min-width: 901px)');
  let ticking = false;

  const update = () => {
    ticking = false;
    if (!wide.matches) {
      track.style.transform = '';
      return;
    }
    const r = section.getBoundingClientRect();
    const span = section.offsetHeight - window.innerHeight;
    const p = span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : 0;
    // the flex track's end padding is not counted in scrollWidth, so measure to the last card plus the start padding
    const last = track.lastElementChild;
    const padL = parseFloat(getComputedStyle(track).paddingLeft) || 0;
    const end = last ? last.offsetLeft + last.offsetWidth + padL : track.scrollWidth;
    const distance = end - document.documentElement.clientWidth;
    track.style.transform = `translate3d(${-p * Math.max(0, distance)}px, 0, 0)`;
  };
  const onScroll = () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  wide.addEventListener('change', onScroll);
  update();

  // Keyboard users tabbing into a card: bring that card into the pinned view.
  track.addEventListener('focusin', (e) => {
    if (!wide.matches) return;
    const card = e.target.closest('.scard');
    if (!card) return;
    const cards = [...track.querySelectorAll('.scard')];
    const i = cards.indexOf(card);
    const span = section.offsetHeight - window.innerHeight;
    window.scrollTo({ top: section.offsetTop + (span * i) / Math.max(1, cards.length - 1) });
  });
}
