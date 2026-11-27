(() => {
  const root = document.documentElement;
  const browserColor = document.querySelector('meta[name="theme-color"]');
  let theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

  try {
    const saved = localStorage.getItem('ssn-theme');
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch {
    // The browser may block storage.
  }

  function applyTheme() {
    root.dataset.theme = theme;
    browserColor.content = theme === 'dark' ? '#251d1a' : '#f6eee1';
  }

  applyTheme();
  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('themeBtn');
    if (!button) return;
    const updateLabel = () => { button.textContent = theme === 'light' ? 'Dark mode' : 'Light mode'; };
    updateLabel();
    button.addEventListener('click', () => {
      theme = theme === 'light' ? 'dark' : 'light';
      applyTheme();
      updateLabel();
      try { localStorage.setItem('ssn-theme', theme); } catch { /* Storage is unavailable. */ }
    });
  });
})();
