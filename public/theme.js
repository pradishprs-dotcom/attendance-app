/* Light / dark theme: runs before the page is drawn so there is no flash. The choice is remembered on this device. */
(function () {
  var KEY = 'hre-theme', root = document.documentElement;
  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function pick() { return saved() || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
  function apply(t) {
    root.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', t === 'dark' ? '#0b1a27' : '#0f2a43');
  }
  apply(pick());
  window.HRE_THEME = {
    get: function () { return root.getAttribute('data-theme') || 'light'; },
    toggle: function () { var t = this.get() === 'dark' ? 'light' : 'dark'; try { localStorage.setItem(KEY, t); } catch (e) { /* not saved */ } apply(t); return t; }
  };
})();
