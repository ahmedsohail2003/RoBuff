// Header: transparent with white text over the hero, solid light with blur once past it.
// Also the mobile menu toggle.

export function mountHeader() {
  const header = document.querySelector('.site-header');
  const hero = document.querySelector('.hero');
  if (!header) return;
  const menu = header.querySelector('.mobile-menu');
  const btn = header.querySelector('.menu-btn');
  const update = () => {
    const limit = hero ? hero.offsetHeight - header.offsetHeight : 0;
    const menuOpen = menu && menu.classList.contains('open');
    header.classList.toggle('solid', window.scrollY > limit - 1 || menuOpen);
    // inside the hero, once scrolled a little, the header gets a dark glass backing so it stays legible
    header.classList.toggle('over-hero', window.scrollY > 8);
  };
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();

  if (!btn || !menu) return;
  const setOpen = (open) => {
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    menu.classList.toggle('open', open);
    update();
  };
  btn.addEventListener('click', () => setOpen(btn.getAttribute('aria-expanded') !== 'true'));
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('open')) {
      setOpen(false);
      btn.focus();
    }
  });
}
