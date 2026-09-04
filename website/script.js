const menuToggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('.nav');

menuToggle?.addEventListener('click', () => {
  const open = nav.classList.toggle('is-open');
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
});

nav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
  nav.classList.remove('is-open');
  menuToggle?.setAttribute('aria-expanded', 'false');
  menuToggle?.setAttribute('aria-label', '打开菜单');
}));

const revealObserver = new IntersectionObserver((entries, observer) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((node) => revealObserver.observe(node));

document.querySelector('.copy-button')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const source = document.querySelector(button.dataset.copy);
  const feedback = document.querySelector('.copy-feedback');
  const value = source?.textContent.replace(/^\s*\$\s?/, '').trim() || '';
  try {
    await navigator.clipboard.writeText(value);
    feedback.textContent = 'COPIED';
  } catch {
    feedback.textContent = 'SELECT & COPY';
  }
  window.setTimeout(() => { feedback.textContent = ''; }, 1800);
});
