/* Install page: shows the right steps for this device, an Install button when the browser allows it, and a QR code for sharing. */
(() => {
  const $ = (s) => document.querySelector(s);
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const first = ios ? 'sec-ios' : android ? 'sec-android' : 'sec-desktop';
  const main = $('main.install'); const sec = $('#' + first); const anchor = $('.install-actions');
  if (sec) { sec.classList.add('mine'); const h = sec.querySelector('h2'); h.textContent += ' - your device'; anchor.parentNode.insertBefore(sec, $('#install-msg').nextSibling); }
  const msg = $('#install-msg');
  const say = (t) => { msg.textContent = t; msg.hidden = false; };
  if (standalone) say('The app is already installed on this device.');
  else if (ios) say('On iPhone and iPad, use Share > Add to Home Screen (steps below).');
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#install-btn').hidden = false; });
  $('#install-btn').addEventListener('click', async () => {
    if (!deferred) return; deferred.prompt(); const r = await deferred.userChoice; deferred = null; $('#install-btn').hidden = true;
    say(r.outcome === 'accepted' ? 'Installing... look for the lotus icon on your home screen.' : 'No problem. You can install later from this page.');
  });
  window.addEventListener('appinstalled', () => { $('#install-btn').hidden = true; say('Installed. Look for the lotus icon.'); });
  const url = location.origin + '/install.html';
  $('#site-url').textContent = url;
  try { const c = window.qrcode(0, 'M'); c.addData(url); c.make(); $('#site-qr').innerHTML = c.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch { /* QR is optional */ }
})();
