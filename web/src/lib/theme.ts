// Thème clair / sombre : suit le système, sauf choix explicite mémorisé sur cet appareil.
export type Theme = 'light' | 'dark';
const KEY = 'jf-theme';

export function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch { return null; }
}

export function applyTheme(t: Theme | null) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

export function effectiveTheme(): Theme {
  return storedTheme() ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

export function setTheme(t: Theme) {
  try { localStorage.setItem(KEY, t); } catch { /* stockage indisponible : le choix vaut pour la session */ }
  applyTheme(t);
}
