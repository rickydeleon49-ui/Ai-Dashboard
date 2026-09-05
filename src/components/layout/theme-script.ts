/**
 * The theme bootstrap, inlined in <head> so the stored choice is applied before
 * first paint. Without it a light-mode user sees a dark flash on every load.
 *
 * Deliberately its own module, with no "use client" directive: the root layout
 * is a server component and importing a value out of a client module drags that
 * module into both graphs.
 */
export const STORAGE_KEY = "dashboard-theme";

export const themeScript = `
(function(){
  try {
    var stored = localStorage.getItem('${STORAGE_KEY}') || 'dark';
    var light = stored === 'light' ||
      (stored === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
    if (light) document.documentElement.classList.add('light');
  } catch (e) {}
})();
`;
