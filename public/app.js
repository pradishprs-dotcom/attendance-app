(() => {
'use strict';

/* ---------- Setup ---------- */
const CURRENCY = 'INR';                       // change if you are invoiced in another currency
const IDLE_MINUTES = 30;
const cfg = window.APP_CONFIG || {};
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n == null || n === '' ? '' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: CURRENCY, maximumFractionDigits: 2 }).format(n));
const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const fmtD = (d) => (d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '');
const label = (s) => String(s || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const PASS_LABEL = { IN: 'IN to hospital', OUT: 'OUT to supplier', REPAIR_OUT: 'OUT for repair / service', REPAIR_IN: 'IN from repair', SCRAP: 'SCRAP (final)' };
const COMPANY = { name: 'Anantha MK Institute of Medical Sciences LLP', address: 'Sy.No.20/2, H.No.1-10-44/2, Plot No.1 & 3, Chikoti Garden, Begumpet, Hyderabad, Telangana 500016', phone: '040-49715052', email: 'info@anantharehab.com' };
const companyBlock = () => `<div class="company"><div class="c-addr">${esc(COMPANY.address)}</div><div class="c-contact">Contact: ${esc(COMPANY.phone)} &nbsp;|&nbsp; Email: ${esc(COMPANY.email)}</div></div>`;
const BANNER = { IN: ['IN', 'Equipment coming IN to the hospital'], OUT: ['OUT', 'Equipment going OUT to the supplier'], REPAIR_OUT: ['OUT FOR REPAIR', 'Anantha hospital equipment leaving for repair / service'], REPAIR_IN: ['IN FROM REPAIR', 'Anantha hospital equipment returning after repair / service'], SCRAP: ['SCRAPPED', 'Equipment written off - will not return'] };
const IO = (t) => t === 'IN' || t === 'OUT';
const nextPass = (st) => ({ on_site: 'OUT', in_service: 'REPAIR OUT', in_repair: 'REPAIR IN', scrapped: null }[st] ?? 'IN');
const passTypes = (st) => ({ expected: ['IN'], returned: ['IN'], on_site: ['OUT'], in_service: ['REPAIR_OUT', 'SCRAP'], in_repair: ['REPAIR_IN', 'SCRAP'] }[st] || []);
const supplierOf = (e) => e.supplier_name || (e.ownership === 'owned' ? 'Owned by the Anantha hospital' : '—');
const OWN_LABEL = { rented: 'Rented', owned: 'Owned by the Anantha hospital', demo: 'Demo instrument' };
const badge = (v, cls) => `<span class="badge ${esc(cls || v)}">${esc(label(v))}</span>`;
const opts = (rows, val, text, sel) => rows.map((r) => `<option value="${esc(r[val])}" ${String(r[val]) === String(sel) ? 'selected' : ''}>${esc(text(r))}</option>`).join('');
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);   // India date, for form defaults only

if (!window.supabase || !cfg.SUPABASE_URL || /YOUR-PROJECT/.test(cfg.SUPABASE_URL)) {
  document.getElementById('app').innerHTML = '<div class="login-wrap"><div class="login"><h1>Not configured</h1><p>Set <b>SUPABASE_URL</b> and <b>SUPABASE_ANON_KEY</b> (see SETUP.md), then redeploy.</p></div></div>';
  return;
}
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

const state = { user: null, profile: null, alerts: 0 };
const cache = {};
let idleTimer, scanner = null, refTimer = null;

/* Every database call goes through here so errors read like English. */
function friendly(err) {
  const m = String(err?.message || err);
  if (/row-level security|permission denied|not permitted|Only Admin|Admin only/i.test(m)) return 'Your role is not allowed to do this.';
  if (/duplicate key/i.test(m)) return 'That already exists (names and PO numbers must be unique).';
  if (/JWT|token is expired/i.test(m)) return 'Your session has expired. Please sign in again.';
  return m.replace(/^error:\s*/i, '');
}
/* ---------- Equipment photos (private bucket, shown through short-lived signed links) ---------- */
const PHOTO_BUCKET = 'equipment-photos';
async function photoUrls(paths) {
  const list = [...new Set(paths.filter(Boolean))]; const out = {}; if (!list.length) return out;
  try {
    const { data } = await sb.storage.from(PHOTO_BUCKET).createSignedUrls(list, 3600);
    (data || []).forEach((r) => { if (r.signedUrl) out[r.path] = r.signedUrl; });
  } catch { /* photos are optional - the screen still works without them */ }
  return out;
}
async function hydratePhotos() {                       // fills every <div data-photo-path> with its picture
  const els = [...document.querySelectorAll('[data-photo-path]:not([data-done])')]; if (!els.length) return;
  els.forEach((el) => { el.dataset.done = '1'; });
  const urls = await photoUrls(els.map((el) => el.dataset.photoPath));
  els.forEach((el) => {
    const u = urls[el.dataset.photoPath]; if (!u || !el.isConnected) return;
    el.innerHTML = `<a href="${esc(u)}" target="_blank" rel="noopener"><img class="eqphoto" src="${esc(u)}" alt="Photo of ${esc(el.dataset.alt || 'equipment')}"></a>`;
  });
}
function resizeImage(file, max = 1024) {               // shrink big phone photos before upload (saves space and time)
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('Please choose a picture file (JPG or PNG).'));
    if (file.size > 25 * 1024 * 1024) return reject(new Error('That picture is too large. Please choose one under 25 MB.'));
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)); const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read that picture.'))), 'image/jpeg', 0.78);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that picture. Try a JPG or PNG.')); };
    img.src = url;
  });
}
function printSheet(size) {                              // A4 (default) or A5 paper; the page size is set only while printing
  const st = document.createElement('style');
  st.textContent = size === 'A5'
    ? '@page{size:A5 portrait;margin:8mm} @media print{.sheet,.label-sheet{font-size:11px;max-width:none;padding:0} .sheet h1{font-size:1.05rem;margin-bottom:.5rem} .sheet-logo{height:38px;margin-bottom:.4rem} .company{font-size:.62rem;margin-bottom:.5rem} .sheet .qr{width:84px;height:84px} .sheet-photo .eqphoto{max-height:105px} .pass-banner{top:0;right:0;padding:.2rem .6rem} .pass-banner .pb-main{font-size:.95rem} .company{padding:0 2.6rem} .sheet-logo{margin-top:.2rem} .kv dt,.kv dd{padding:.1rem 0}}'
    : '@page{size:A4 portrait;margin:12mm}';
  document.head.appendChild(st);
  const done = () => { st.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done); window.print();
}
/* In-page camera: opens the device camera, takes a picture and puts it into the form's photo box. */
function openCamera(onPhoto) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open the camera here. Use "Choose file" instead.');
  const d = document.createElement('dialog'); d.className = 'camdlg';
  d.innerHTML = `<div class="cam"><div class="cam-stage"><video playsinline autoplay muted></video><img class="cam-shot" alt="Captured photo" hidden></div>
    <p class="cam-msg small" role="status">Starting camera…</p>
    <div class="cam-bar"><button type="button" class="btn" data-cam="cancel">Cancel</button><button type="button" class="btn" data-cam="flip">Switch camera</button>
    <button type="button" class="btn primary" data-cam="snap">Take photo</button><button type="button" class="btn" data-cam="retake" hidden>Retake</button><button type="button" class="btn primary" data-cam="use" hidden>Use this photo</button></div></div>`;
  document.body.append(d); d.showModal();
  const $c = (k) => d.querySelector(`[data-cam=${k}]`), video = d.querySelector('video'), shot = d.querySelector('.cam-shot'), msg = d.querySelector('.cam-msg');
  let stream = null, facing = 'environment', blob = null;
  const stop = () => { stream?.getTracks().forEach((t) => t.stop()); stream = null; };
  const show = (taken) => { video.hidden = taken; shot.hidden = !taken; ['snap', 'flip'].forEach((k) => { $c(k).hidden = taken; }); ['retake', 'use'].forEach((k) => { $c(k).hidden = !taken; }); };
  async function start() {
    stop(); show(false); msg.textContent = 'Starting camera…';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      video.srcObject = stream; await video.play().catch(() => {}); msg.textContent = 'Point the camera at the equipment, then press Take photo.';
    } catch (e) {
      msg.textContent = e.name === 'NotAllowedError' ? 'Camera permission was blocked. Allow the camera for this site in your browser settings, or use "Choose file".'
        : e.name === 'NotFoundError' ? 'No camera was found on this device. Use "Choose file" instead.' : 'Could not start the camera: ' + e.message;
      ['snap', 'flip'].forEach((k) => { $c(k).hidden = true; });
    }
  }
  d.addEventListener('close', () => { stop(); if (shot.src.startsWith('blob:')) URL.revokeObjectURL(shot.src); d.remove(); });
  d.addEventListener('click', (ev) => {
    const k = ev.target.closest('[data-cam]')?.dataset.cam; if (!k) return; ev.stopPropagation();
    if (k === 'cancel') d.close();
    if (k === 'flip') { facing = facing === 'environment' ? 'user' : 'environment'; start(); }
    if (k === 'retake') start();
    if (k === 'snap') {
      if (!video.videoWidth) { msg.textContent = 'The camera is still starting - wait a second and press Take photo again.'; return; }
      const sc = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight)); const c = document.createElement('canvas');
      c.width = Math.round(video.videoWidth * sc); c.height = Math.round(video.videoHeight * sc); c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
      c.toBlob((b) => { if (!b) { msg.textContent = 'Could not capture the picture. Try again.'; return; } blob = b; shot.src = URL.createObjectURL(b); stop(); show(true); msg.textContent = 'Happy with it? Press Use this photo.'; }, 'image/jpeg', 0.9);
    }
    if (k === 'use' && blob) { onPhoto(new File([blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' })); d.close(); }
  });
  start();
}
function setFormPhoto(file) {                          // put a File into the form's photo input and show the preview
  const inp = document.querySelector('#modal form input[name=photo], dialog[open] form input[name=photo]'); if (!inp) return;
  const dt = new DataTransfer(); dt.items.add(file); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
}

async function savePhoto(id, file, oldPath) {         // upload the new file, point the item at it, then delete the old file
  const blob = await resizeImage(file); const path = `${id}-${Date.now()}.jpg`; const bucket = sb.storage.from(PHOTO_BUCKET);
  const { error } = await bucket.upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) throw new Error(/bucket not found/i.test(error.message) ? 'Photo storage is not set up yet (run photos.sql in Supabase).' : /row-level|security|policy|not allowed/i.test(error.message) ? 'Your role is not allowed to add photos.' : 'Photo upload failed: ' + error.message);
  const r = await q(sb.from('equipment').update({ photo_path: path }).eq('id', id).select('id'));
  if (!r.length) { await bucket.remove([path]); throw new Error('Your role is not allowed to add photos.'); }
  if (oldPath) bucket.remove([oldPath]).catch(() => {});
}
async function removePhoto(id, oldPath) {
  await q(sb.from('equipment').update({ photo_path: null }).eq('id', id).select('id'));
  if (oldPath) sb.storage.from(PHOTO_BUCKET).remove([oldPath]).catch(() => {});
}

async function q(promise) { const { data, error } = await promise; if (error) throw new Error(friendly(error)); return data; }
const rpc = (fn, args) => q(sb.rpc(fn, args));
const can = (...roles) => !!state.profile && roles.includes(state.profile.role);

function toast(msg, isErr) { const t = $('#toast'); const d = document.createElement('div'); if (isErr) d.className = 'err'; d.textContent = msg; t.appendChild(d); setTimeout(() => d.remove(), isErr ? 6000 : 3200); }
const fail = (e) => toast(e.message || String(e), true);
function resetIdle() { clearTimeout(idleTimer); if (state.user) idleTimer = setTimeout(() => signOut(), IDLE_MINUTES * 60000); }
['click', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, resetIdle, { passive: true }));

/* ---------- Modal, scanner, QR ---------- */
const dlg = () => $('#modal');
function modal(title, html) {
  dlg().innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button></div><div class="modal-body">${html}</div>`;
  if (!dlg().open) dlg().showModal();
}
const closeModal = () => { if (dlg().open) dlg().close(); };
async function stopScanner() { if (scanner) { const s = scanner; scanner = null; try { await s.stop(); s.clear(); } catch { /* already stopped */ } } }
document.addEventListener('DOMContentLoaded', () => dlg().addEventListener('close', () => { stopScanner(); clearTimeout(refTimer); }));

async function openScanner(onResult) {
  modal('Scan QR / barcode', '<div id="reader"></div><p class="muted small">Point the camera at the equipment QR label or barcode.</p><button class="btn" data-act="close-modal">Cancel</button>');
  if (!window.Html5Qrcode) { $('#reader').innerHTML = '<p class="error" style="margin:1rem">Scanner could not load. Type the asset tag instead.</p>'; return; }
  try {
    scanner = new Html5Qrcode('reader');
    await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 240, height: 240 } }, (text) => { closeModal(); onResult(text.trim()); }, () => {});
  } catch (e) {
    const r = $('#reader'); if (r) r.innerHTML = `<p class="error" style="margin:1rem">Camera unavailable: ${esc(e.message || e)}.<br>The camera needs HTTPS and your permission. You can type the asset tag instead (USB barcode scanners also work in the tag box).</p>`;
  }
}
function qrSvg(text) { const c = window.qrcode(0, 'M'); c.addData(String(text)); c.make(); return c.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }

/* ---------- CSV ---------- */
const csvCell = (v) => { if (v == null) return ''; let s = String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function downloadCsv(name, cols, rows) {
  const text = '﻿' + [cols.map((c) => csvCell(c.label)).join(',')].concat(rows.map((r) => cols.map((c) => csvCell(r[c.key])).join(','))).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = `${name}-${today()}.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- Layout ---------- */
const ALL = ['admin', 'procurement', 'stores', 'accounts'], SEC = [...ALL, 'security'];
const MGMT_PAGES = ['dashboard', 'equipment', 'alerts', 'reports', 'gatepasses', 'pass', 'password'];   // Management: view only, no side menu
const SEC_PAGES = ['scan', 'equipment', 'gatepasses', 'pass', 'password'];   // Security Department sees only these
const NAV = [['dashboard', 'Dashboard', ALL], ['scan', 'Scan', SEC], ['equipment', 'Equipment', SEC], ['gatepasses', 'Gate passes', SEC], ['alerts', 'Return alerts', ALL],
  ['suppliers', 'Suppliers', ALL], ['pos', 'Purchase orders', ALL], ['reports/inventory', 'Reports', ALL], ['users', 'Users', ['admin']], ['audit', 'Audit trail', ['admin']]];
const pageTitle = (k) => (NAV.find(([h]) => h.split('/')[0] === k) || [, 'Rental Equipment'])[1];
function shell(active, inner) {
  const items = NAV.filter(([, , r]) => r.includes(state.profile.role)).map(([h, t]) =>
    `<a class="item ${active === h.split('/')[0] ? 'active' : ''}" href="#/${h}">${t}${h === 'alerts' && state.alerts ? ` <span class="badge overdue">${state.alerts}</span>` : ''}</a>`).join('');
  const mg = can('management');
  $('#app').innerHTML = `<div class="shell ${mg ? 'no-nav' : ''}">${mg ? '' : `<nav class="nav" id="nav" aria-label="Main"><div class="brand"><img src="/logo-mark.png" alt="">Rental Equipment</div>${items}
    <div class="who"><b>${esc(state.profile.full_name || state.user.email)}</b>${esc(label(state.profile.role))}<br><a href="#/password" style="color:#e0c8ff">Change password</a> · <a href="#" data-act="logout" style="color:#e0c8ff">Sign out</a><br><a href="/install.html" style="color:#e0c8ff">Install on phone / PC</a></div></nav>`}
    <div class="main"><header class="topbar"><button class="icon-btn menu-btn" data-act="toggle-nav" aria-label="Menu">☰</button>${mg && active !== 'dashboard' ? '<a class="btn sm" href="#/dashboard">← Dashboard</a>' : ''}<div class="tb-title"><b>${esc(mg && active === 'dashboard' ? 'Management dashboard' : pageTitle(active))}</b><span>Rental equipment management</span></div>
      <div class="tb-actions">${mg ? '<a class="btn sm" href="#/password">Password</a>' : ''}<button class="icon-btn tb-btn" data-act="toggle-theme" id="theme-btn" aria-label="Switch light / dark mode" title="Light / dark mode">${icon(window.HRE_THEME?.get() === 'dark' ? 'sun' : 'moon')}</button><button class="icon-btn tb-btn" data-act="logout" aria-label="Sign out" title="Sign out">${icon('logout')}</button></div></header><main class="content" id="view">${inner}</main></div></div>`;
}
const view = () => $('#view');

/* ---------- Login ---------- */
function renderLogin(msg) {
  clearTimeout(idleTimer); closeModal();
  $('#app').innerHTML = `<div class="login-wrap"><div class="float-tiles" aria-hidden="true">${[['bed', 'Equipment'], ['pulse', 'Monitors'], ['qr', 'QR scan'], ['truck', 'Gate pass'], ['shield', 'Secure'], ['clip', 'Audit trail']].map(([k, l], i) => `<div class="ft ft${i + 1}">${icon(k)}<span>${l}</span></div>`).join('')}</div><form class="login" data-form="login"><img class="login-logo" src="/logo.png" alt="Anantha MK Institute of Medical Sciences LLP"><h1>Rental Equipment Manager</h1><p class="muted">Sign in with your hospital account.</p>
    ${msg ? `<div class="note">${esc(msg)}</div>` : ''}<div id="login-err"></div>
    <label>Email<input name="email" type="email" autocomplete="username" autocapitalize="none" required></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="btn primary" style="width:100%">Sign in</button><p class="small" style="text-align:center;margin:.5rem 0 0"><a href="/install.html">Install this app on your phone</a></p></form></div>`;
}
function renderPending() {
  $('#app').innerHTML = `<div class="login-wrap"><div class="login"><img class="login-logo" src="/logo.png" alt="Anantha MK Institute of Medical Sciences LLP"><h1>Waiting for access</h1><p>You are signed in as <b>${esc(state.user.email)}</b>, but an administrator has not given your account a role yet (or it has been deactivated).</p>
  <button class="btn" data-act="logout" style="width:100%">Sign out</button></div></div>`;
}
async function signOut(msg) {
  if (state.profile?.role) { try { await sb.rpc('log_event', { p_action: 'LOGOUT' }); } catch { /* ignore */ } }
  await sb.auth.signOut(); state.user = null; state.profile = null; renderLogin(msg);
}
async function loadProfile() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return false;
  state.user = session.user;
  const { data } = await sb.from('profiles').select('role,full_name,active,email').eq('id', session.user.id).maybeSingle();
  state.profile = data && data.active && data.role ? data : null;
  resetIdle();
  return true;
}

/* ---------- Router ---------- */
async function route() {
  if (!state.user) return;
  if (!state.profile) return renderPending();
  closeModal();
  const secOnly = can('security');
  const [path, qs] = (location.hash.slice(2) || (secOnly ? 'scan' : 'dashboard')).split('?');
  const parts = path.split('/'); const params = new URLSearchParams(qs || '');
  try {
    if (secOnly && !SEC_PAGES.includes(parts[0])) { location.hash = '#/scan'; return; }
    if (can('management') && (!MGMT_PAGES.includes(parts[0]) || (parts[0] === 'gatepasses' && parts[1] === 'new'))) { location.hash = '#/dashboard'; return; }
    if (!secOnly) state.alerts = (await q(sb.from('v_alerts').select('equipment_id', { count: 'exact', head: false }))).length;
    switch (parts[0]) {
      case 'dashboard': return await pageDashboard();
      case 'scan': return pageScan();
      case 'equipment': return await pageEquipment();
      case 'gatepasses': return parts[1] === 'new' ? await pagePassNew(params) : await pageGatepasses();
      case 'pass': return await pagePass(parts[1]);
      case 'label': return await pageLabel(parts[1]);
      case 'alerts': return await pageAlerts();
      case 'suppliers': return await pageSuppliers();
      case 'pos': return await pagePOs();
      case 'reports': return await pageReports(parts[1] || 'inventory');
      case 'users': if (can('admin')) return await pageUsers(); break;
      case 'audit': if (can('admin')) return await pageAudit(); break;
      case 'password': return pagePassword();
    }
    location.hash = secOnly ? '#/scan' : '#/dashboard';
  } catch (e) { fail(e); if (view()) view().innerHTML = `<div class="error">${esc(e.message)}</div>`; else renderLogin(e.message); }
}
window.addEventListener('hashchange', route);

/* ---------- Alerts ---------- */
const alertText = (a) => a.kind === 'overdue' ? `OVERDUE by ${a.overdue_days} day(s). Extra rent so far: ${money(a.overdue_cost)}. Arrange return now.`
  : a.kind === 'due_today' ? 'Return due TODAY.' : a.kind === 'due_1d' ? `Return due tomorrow (${fmtD(a.expected_return)}).` : `Return due in ${a.days_left} days (${fmtD(a.expected_return)}).`;
const alertsHtml = (rows) => `<div class="list">${rows.map((a) => `<a class="item-card" href="#/equipment?open=${a.equipment_id}" style="text-decoration:none"><div><div>${badge(a.kind)} <b>${esc(a.name)}</b> <span class="mono muted small">${esc(a.asset_tag)}</span></div>
  <div style="margin:.3rem 0">${esc(alertText(a))}</div><div class="meta">${esc(a.supplier_name)}</div></div></a>`).join('') || '<div class="card muted">No alerts. Nothing is due within 3 days or overdue.</div>'}</div>`;
const loadAlerts = () => q(sb.from('v_alerts').select('*').order('days_left'));

/* ---------- Pages ---------- */
/* ---------- Floating tiles (dashboard stat tiles + login decoration) ---------- */
const IC = {
  box: '<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 17l9 4 9-4"/>',
  alarm: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M5 3L2 6M19 3l3 3"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  truck: '<path d="M2 6h11v10H2zM13 9h4l3 3v4h-7z"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M9 8h6M9 11h6M9 8c4 0 4 5 0 5l4 4"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/>',
  clock: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5M12 8v4l2 2"/>',
  bed: '<path d="M3 18V8M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5"/>',
  pulse: '<path d="M2 12h5l2-6 4 12 2-6h7"/>',
  qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v7M14 20h3"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  bin: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  clip: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9zM9 12h6M9 16h4"/>',
};
Object.assign(IC, {
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>' });
const icon = (k) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[k]}</svg>`;
function tile({ href, n, label, ic, tone = 'teal', state: st = '', count = false, i = 0 }) {
  const body = `<span class="ico">${icon(ic)}</span><div class="n"${count ? ` data-count="${n}"` : ''}>${count ? 0 : n}</div><div class="l">${label}</div>`;
  const cls = `stat tile tone-${tone} ${st}`; const style = `--i:${i}`;
  return href ? `<a class="${cls}" style="${style}" href="${href}">${body}</a>` : `<div class="${cls}" style="${style}">${body}</div>`;
}
function section(kind, title, sub, tiles) {
  return `<section class="dash-sec sec-${kind}"><div class="sec-head"><h2>${title}</h2><span>${sub}</span></div><div class="stats floaty compact">${tiles.join('')}</div></section>`;
}
function animateCounts() {                             // numbers count up once; skipped for people who prefer reduced motion
  const els = [...document.querySelectorAll('[data-count]')]; if (!els.length) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  els.forEach((el) => {
    const to = Number(el.dataset.count) || 0; if (reduce || to === 0) { el.textContent = to; return; }
    const t0 = performance.now(), dur = 650;
    const step = (t) => { const k = Math.min(1, (t - t0) / dur); el.textContent = Math.round(to * (1 - (1 - k) ** 3)); if (k < 1 && el.isConnected) requestAnimationFrame(step); else el.textContent = to; };
    requestAnimationFrame(step);
  });
}

/* ---------- Dashboard analytics: thin doughnuts + category bars, with a From / Till date range ---------- */
const AN = {
  own: { rented: ['Rented', '#2b6cb0'], owned: ['Owned by Anantha', '#c9962b'], demo: ['Demo', '#2a9d8f'] },
  st: { on_site: ['On site', '#2b6cb0'], in_service: ['In service', '#2a9d8f'], returned: ['Returned', '#c9962b'], expected: ['Awaiting delivery', '#8a6bbf'], in_repair: ['In repair', '#d9822b'], scrapped: ['Scrapped', '#8a93a0'] },
  dir: { IN: ['IN', '#1a8a5a'], OUT: ['OUT', '#2b6cb0'], REPAIR_OUT: ['Repair out', '#d9822b'], REPAIR_IN: ['Repair in', '#8a6bbf'], SCRAP: ['Scrap', '#8a93a0'] },
};
function donut(title, items) {
  const list = items.filter((i) => i.value > 0), total = list.reduce((a, i) => a + i.value, 0);
  if (!total) return `<div class="an-card"><h4>${esc(title)}</h4><p class="muted small">Nothing in this period.</p></div>`;
  const R = 46, C = 2 * Math.PI * R, gap = list.length > 1 ? 2.2 : 0; let off = 0;
  const arcs = list.map((i) => { const len = i.value / total * C; const a = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${i.color}" stroke-width="8" stroke-dasharray="${Math.max(len - gap, 0.5)} ${C}" stroke-dashoffset="${-off}" transform="rotate(-90 60 60)"><title>${esc(i.label)}: ${i.value}</title></circle>`; off += len; return a; }).join('');
  return `<div class="an-card"><h4>${esc(title)}</h4><div class="donut-wrap"><svg viewBox="0 0 120 120" class="donut" role="img" aria-label="${esc(title)}"><circle cx="60" cy="60" r="${R}" fill="none" stroke="var(--line)" stroke-width="8"/>${arcs}<text x="60" y="58" text-anchor="middle" class="d-n">${total}</text><text x="60" y="73" text-anchor="middle" class="d-l">total</text></svg>
  <ul class="legend">${list.map((i) => `<li><i style="background:${i.color}"></i><span>${esc(i.label)}</span><b>${i.value}</b><em>${Math.round(i.value / total * 100)}%</em></li>`).join('')}</ul></div></div>`;
}
function hbars(title, rows, fmt) {      // rows: [{label, segs:[{value,color,label}]}]
  if (!rows.length) return `<div class="an-card wide"><h4>${esc(title)}</h4><p class="muted small">Nothing in this period.</p></div>`;
  const mx = Math.max(...rows.map((r) => r.segs.reduce((a, x) => a + x.value, 0))) || 1;
  return `<div class="an-card wide"><h4>${esc(title)}</h4>${rows.map((r) => { const t = r.segs.reduce((a, x) => a + x.value, 0);
    return `<div class="hb"><span class="hb-n" title="${esc(r.label)}">${esc(r.label)}</span><div class="hb-bar">${r.segs.filter((x) => x.value > 0).map((x) => `<div style="width:${x.value / mx * 100}%;background:${x.color}" title="${esc(x.label)}: ${fmt ? fmt(x.value) : x.value}"></div>`).join('')}</div><b>${fmt ? fmt(t) : t}</b></div>`; }).join('')}</div>`;
}
async function loadAnalytics() {
  const body = $('#an-body'); if (!body) return;
  const from = $('#an-from')?.value, till = $('#an-till')?.value, ranged = !!(from || till);
  if (from && till && from > till) { body.innerHTML = '<p class="muted">The “From” date is after the “Till” date.</p>'; return; }
  try {
    const rows = []; for (let off = 0; off < 20000; off += 1000) {
      let qy = sb.from('gatepasses').select('equipment_id,direction,issued_at,rental_cost,equipment(category,ownership,status)').order('id', { ascending: true }).range(off, off + 999);
      if (from) qy = qy.gte('issued_at', new Date(from + 'T00:00:00').toISOString());
      if (till) qy = qy.lte('issued_at', new Date(till + 'T23:59:59').toISOString());
      const part = await q(qy); rows.push(...part); if (part.length < 1000) break;
    }
    let eqs;
    if (ranged) { const m = new Map(); rows.forEach((g) => { if (g.equipment && !m.has(g.equipment_id)) m.set(g.equipment_id, g.equipment); }); eqs = [...m.values()]; }
    else eqs = await q(sb.from('v_equipment').select('category,ownership,status'));
    if (!$('#an-body')) return;
    const cnt = (arr, key, map) => Object.keys(map).map((k) => ({ label: map[k][0], color: map[k][1], value: arr.filter((x) => x[key] === k).length }));
    const catMap = new Map(); eqs.forEach((e) => { const c = (e.category || 'Uncategorised').trim() || 'Uncategorised'; if (!catMap.has(c)) catMap.set(c, { rented: 0, owned: 0, demo: 0 }); catMap.get(c)[e.ownership]++; });
    const catRows = [...catMap.entries()].sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y) - Object.values(a[1]).reduce((x, y) => x + y)).slice(0, 12)
      .map(([label, v]) => ({ label, segs: Object.keys(AN.own).map((k) => ({ value: v[k], color: AN.own[k][1], label: AN.own[k][0] })) }));
    let rentHtml = '';
    if (can('admin', 'procurement', 'accounts', 'management')) {
      const rc = new Map(); rows.filter((g) => g.direction === 'OUT' && g.rental_cost != null).forEach((g) => { const c = (g.equipment?.category || 'Uncategorised').trim() || 'Uncategorised'; rc.set(c, (rc.get(c) || 0) + Number(g.rental_cost)); });
      rentHtml = hbars('Rent billed on returned equipment, by category', [...rc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, v]) => ({ label, segs: [{ value: v, color: '#1f4e79', label: 'Rent' }] })), (n) => money(n));
    }
    $('#an-note').textContent = ranged ? `Showing equipment with a gate pass between ${from || 'the start'} and ${till || 'today'}.` : 'Showing all equipment and all gate passes. Pick dates to narrow it.';
    body.innerHTML = `<div class="an-grid">${donut('Gate passes by type', rows.reduce((a, g) => { const k = AN.dir[g.direction]; if (k) { const x = a.find((i) => i.label === k[0]); if (x) x.value++; else a.push({ label: k[0], color: k[1], value: 1 }); } return a; }, []))}
      ${donut('Equipment by ownership', cnt(eqs, 'ownership', AN.own))}${donut('Equipment by status', cnt(eqs, 'status', AN.st))}</div>
      <div class="an-grid one">${hbars('Equipment by category', catRows)}${rentHtml}</div>
      <div class="lg-row">${Object.values(AN.own).map(([l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join('')}</div>`;
  } catch (e) { if ($('#an-body')) $('#an-body').innerHTML = `<p class="muted">Could not load charts: ${esc(e.message)}</p>`; }
}

async function pageDashboard() {
  const [eq, alerts, passes] = await Promise.all([
    q(sb.from('v_equipment').select('status,ownership,daily_rate,rental_cost,overdue_cost,overdue_days,expected_return')), loadAlerts(),
    q(sb.from('gatepasses').select('id,pass_no,direction,issued_at,equipment(name,asset_tag)').order('id', { ascending: false }).limit(6))]);
  const rented = eq.filter((e) => e.ownership === 'rented'), owned = eq.filter((e) => e.ownership === 'owned'), demo = eq.filter((e) => e.ownership === 'demo');
  const on = rented.filter((e) => e.status === 'on_site'), overdue = on.filter((e) => e.overdue_days > 0).length, demoOverdue = demo.filter((e) => e.status === 'on_site' && e.overdue_days > 0).length;
  const soon = new Date(Date.now() + 3 * 864e5).toLocaleDateString('en-CA'), dueSoon = on.filter((e) => !e.overdue_days && e.expected_return && e.expected_return <= soon).length;
  const sum = (k) => on.reduce((a, e) => a + Number(e[k] || 0), 0);
  const showMoney = !can('stores');
  shell('dashboard', `<div class="page-head"><div><h1>Dashboard</h1><div class="muted">Welcome, ${esc(state.profile.full_name || '')}</div></div>
    <div class="actions">${can('management') ? '<a class="btn primary" href="#/reports/inventory">Reports</a><a class="btn" href="#/gatepasses">Gate passes</a>' : '<a class="btn primary" href="#/scan">Scan equipment</a>'}${can('admin', 'stores') ? '<a class="btn" href="#/gatepasses/new">New gate pass</a>' : ''}</div></div>
  ${section('rented', 'Rented equipment', 'Hired from suppliers, rent applies', [
      tile({ href: '#/equipment?status=on_site', n: on.length, label: 'On site now', ic: 'box', tone: 'teal', count: true, i: 0 }),
      tile({ href: '#/alerts', n: overdue, label: 'Overdue for return', ic: 'alarm', tone: 'red', state: overdue ? 'danger' : '', count: true, i: 1 }),
      tile({ href: '#/alerts', n: dueSoon, label: 'Due within 3 days', ic: 'cal', tone: 'amber', state: dueSoon ? 'warn' : '', count: true, i: 2 }),
      tile({ href: '#/equipment?status=expected', n: rented.filter((e) => e.status === 'expected').length, label: 'Awaiting delivery', ic: 'truck', tone: 'teal', count: true, i: 3 }),
      tile({ href: '#/equipment?status=returned', n: rented.filter((e) => e.status === 'returned').length, label: 'Returned', ic: 'check', tone: 'teal', count: true, i: 4 }),
      ...(showMoney ? [
        tile({ href: can('admin', 'procurement', 'accounts', 'management') ? '#/reports/rental-costs' : '', n: money(sum('rental_cost')), label: 'Rent accrued on site', ic: 'coin', tone: 'teal', i: 5 }),
        tile({ href: can('admin', 'procurement', 'accounts', 'management') ? '#/reports/rental-costs' : '', n: money(sum('overdue_cost')), label: 'Extra rent from overdue', ic: 'warn', tone: 'red', state: sum('overdue_cost') ? 'danger' : '', i: 6 }),
        tile({ n: money(sum('daily_rate')), label: 'Rent accruing per day', ic: 'clock', tone: 'teal', i: 7 })] : [])])}
  ${section('owned', 'Owned by the Anantha hospital', 'Our own equipment: service, repair and scrap', [
      tile({ href: '#/equipment?status=in_service', n: owned.filter((e) => e.status === 'in_service').length, label: 'In service', ic: 'bed', tone: 'blue', count: true, i: 0 }),
      tile({ href: '#/equipment?status=in_repair', n: owned.filter((e) => e.status === 'in_repair').length, label: 'Out for repair', ic: 'wrench', tone: 'blue', count: true, i: 1 }),
      tile({ href: '#/equipment?status=scrapped', n: owned.filter((e) => e.status === 'scrapped').length, label: 'Scrapped', ic: 'bin', tone: 'blue', count: true, i: 2 })])}
  ${section('demo', 'Demo instruments', 'Brought by suppliers for a trial, no rent', [
      tile({ href: '#/equipment?status=on_site', n: demo.filter((e) => e.status === 'on_site').length, label: 'On site now', ic: 'box', tone: 'violet', count: true, i: 0 }),
      tile({ href: '#/equipment?status=expected', n: demo.filter((e) => e.status === 'expected').length, label: 'Expected', ic: 'truck', tone: 'violet', count: true, i: 1 }),
      tile({ href: '#/alerts', n: demoOverdue, label: 'Overdue for return', ic: 'alarm', tone: 'red', state: demoOverdue ? 'danger' : '', count: true, i: 2 }),
      tile({ href: '#/equipment?status=returned', n: demo.filter((e) => e.status === 'returned').length, label: 'Returned', ic: 'check', tone: 'violet', count: true, i: 3 })])}
  <section class="analytics card"><div class="an-head"><h2>Analytics</h2><div class="an-filter"><label>From<input type="date" id="an-from"></label><label>Till<input type="date" id="an-till"></label><button class="btn sm" data-act="an-clear" type="button">All dates</button></div></div><div id="an-note" class="muted small"></div><div id="an-body" class="an-body"><p class="muted">Loading charts…</p></div></section>
  <h3>Return alerts</h3>${alertsHtml(alerts.slice(0, 5))}${alerts.length > 5 ? '<p><a href="#/alerts">See all alerts</a></p>' : ''}
  <h3>Recent gate passes</h3><div class="list">${passes.map((g) => `<a class="item-card" href="#/pass/${g.id}" style="text-decoration:none"><div><div class="t">${esc(g.equipment?.name)} <span class="mono muted small">${esc(g.equipment?.asset_tag)}</span></div>
    <div class="meta">${esc(g.pass_no)} · ${fmtDT(g.issued_at)}</div></div>${badge(g.direction)}</a>`).join('') || '<p class="muted">No gate passes yet.</p>'}</div>`);
  animateCounts(); loadAnalytics();
}
async function pageAlerts() {
  shell('alerts', `<div class="page-head"><div><h1>Return alerts</h1><div class="muted small">Always up to date: shown 3 days before the return date, then every day until the equipment goes OUT.</div></div></div>${alertsHtml(await loadAlerts())}`);
}

function pageScan() {
  shell('scan', `<div class="page-head"><h1>Scan equipment</h1></div><div class="card" style="max-width:560px"><button class="btn primary" style="width:100%;min-height:56px;font-size:1.05rem" data-act="scan-lookup">Open camera &amp; scan</button>
    <p class="muted small" style="text-align:center">or type / scan with a USB barcode reader</p><form class="inline" data-form="lookup"><label>Asset tag or serial<input name="tag" autocomplete="off" autocapitalize="characters" placeholder="HRE-00001"></label><button class="btn">Find</button></form></div>
    <div id="scan-result" style="margin-top:1rem;max-width:560px"></div>`);
}
async function findEquipment(tag) {
  const t = tag.trim(); if (!t) throw new Error('Enter an asset tag or serial number');
  let rows = await q(sb.from('v_equipment').select('*').eq('asset_tag', t.toUpperCase()).limit(1));
  if (!rows.length) rows = await q(sb.from('v_equipment').select('*').eq('serial_no', t).limit(1));
  if (!rows.length) throw new Error(`No equipment found for "${t}"`);
  return rows[0];
}
async function lookupTag(tag) {
  const out = $('#scan-result');
  try {
    const e = await findEquipment(tag); const next = nextPass(e.status);
    out.innerHTML = `<div class="card"><div class="page-head" style="margin:0"><div><h2>${esc(e.name)}</h2><div class="mono muted">${esc(e.asset_tag)}</div></div>${badge(e.status)}</div>
      ${e.photo_path ? `<div data-photo-path="${esc(e.photo_path)}" data-alt="${esc(e.name)}"></div>` : ''}
      <dl class="kv" style="margin-top:.75rem"><dt>${e.ownership === 'owned' ? 'Ownership' : 'Supplier'}</dt><dd>${esc(supplierOf(e))}${e.ownership === 'demo' ? ' <span class="muted small">(demo)</span>' : ''}</dd>${e.ownership !== 'rented' ? '' : `<dt>PO</dt><dd>${esc(e.po_number || '—')}</dd>`}<dt>Location</dt><dd>${esc(e.location || '—')}</dd>${e.ownership === 'owned' ? '' : `<dt>Due back</dt><dd>${fmtD(e.expected_return) || '—'}</dd>`}
      ${e.status === 'on_site' && e.overdue_days ? `<dt>Overdue</dt><dd><span class="badge overdue">${e.overdue_days} day(s) · extra ${money(e.overdue_cost)}</span></dd>` : ''}</dl>
      <div class="actions" style="display:flex;gap:.5rem;margin-top:1rem"><button class="btn" data-act="open-eq" data-id="${e.id}">Details</button>${can('admin', 'stores', 'security') && next && (!can('security') || IO(next)) ? `<a class="btn primary" href="#/gatepasses/new?tag=${encodeURIComponent(e.asset_tag)}">Gate pass ${next}</a>` : ''}</div></div>`;
    hydratePhotos();
  } catch (err) { out.innerHTML = `<div class="error">${esc(err.message)}</div>`; }
}

async function pageEquipment() {
  const [rows, sup] = await Promise.all([q(sb.from('v_equipment').select('*').order('id', { ascending: false })), q(sb.from('suppliers').select('*').order('name'))]);
  cache.suppliers = sup;
  const thumbs = await photoUrls(rows.map((r) => r.photo_path));
  shell('equipment', `<div class="page-head"><h1>Equipment</h1><div class="actions">${can('admin', 'procurement', 'stores') ? '<button class="btn primary" data-act="new-eq">Add equipment</button>' : ''}</div></div>
  <div class="filters"><input type="search" id="eq-q" placeholder="Search name, tag, serial, supplier" aria-label="Search"><select id="eq-status" aria-label="Status"><option value="">All statuses</option><option value="expected">Rented: awaiting delivery</option><option value="on_site">Rented: on site</option><option value="returned">Rented: returned</option><option value="in_service">Owned: in service</option><option value="in_repair">Owned: out for repair</option><option value="scrapped">Owned: scrapped</option></select></div><div class="list" id="eq-list"></div>`);
  const draw = () => {
    const s = $('#eq-q').value.toLowerCase(), st = $('#eq-status').value;
    $('#eq-list').innerHTML = rows.filter((e) => (!st || e.status === st) && (!s || [e.name, e.asset_tag, e.serial_no, e.supplier_name, e.ownership === 'owned' ? 'owned hospital' : e.ownership === 'demo' ? 'demo instrument' : 'rented'].join(' ').toLowerCase().includes(s))).map((e) =>
      `<button class="item-card" data-act="open-eq" data-id="${e.id}">${e.photo_path && thumbs[e.photo_path] ? `<img class="thumb" src="${esc(thumbs[e.photo_path])}" alt="" loading="lazy">` : ''}<div style="flex:1;min-width:0"><div class="t">${esc(e.name)} <span class="mono muted small">${esc(e.asset_tag)}</span></div>
      <div class="meta">${esc(supplierOf(e))}${e.po_number ? ' · PO ' + esc(e.po_number) : ''}${e.location ? ' · ' + esc(e.location) : ''}</div>
      <div class="meta">${e.ownership === 'owned' ? 'Owned by the Anantha hospital' : (e.ownership === 'demo' ? 'Demo · ' : '') + (e.expected_return ? 'Due back ' + fmtD(e.expected_return) : 'No return date')}${e.overdue_days ? ` · <b style="color:var(--danger)">${e.overdue_days}d overdue</b>` : ''}</div></div><div>${badge(e.status)}</div></button>`).join('') || '<p class="muted">No equipment matches.</p>';
  };
  const pre = new URLSearchParams((location.hash.split('?')[1]) || '').get('status'); if (pre && ['expected', 'on_site', 'in_service', 'in_repair', 'returned', 'scrapped'].includes(pre)) $('#eq-status').value = pre;
  $('#eq-q').addEventListener('input', draw); $('#eq-status').addEventListener('change', draw); draw();
  const open = new URLSearchParams((location.hash.split('?')[1]) || '').get('open'); if (open) openEquipment(open);
}

async function openEquipment(id) {
  const e = (await q(sb.from('v_equipment').select('*').eq('id', id).limit(1)))[0]; if (!e) throw new Error('Equipment not found');
  const passes = (await q(sb.from('gatepasses').select('id,pass_no,direction,issued_at,issued_by_name,service_cost').eq('equipment_id', id).order('id', { ascending: false }))).filter((g) => !can('security') || IO(g.direction));
  const repairs = passes.filter((g) => g.direction === 'REPAIR_IN');
  const refUI = can('admin', 'stores')
    ? `<div class="secret"><div id="ref-box">${e.has_patient_ref ? '<span class="muted">Stored (encrypted). Viewing is logged.</span>' : '<span class="muted">No reference stored.</span>'}</div>
       <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem">${e.has_patient_ref ? `<button class="btn sm" data-act="ref-show" data-id="${e.id}">Reveal (30s)</button>` : ''}<button class="btn sm" data-act="ref-edit" data-id="${e.id}">${e.has_patient_ref ? 'Change' : 'Set'}</button></div></div>`
    : `<div class="secret muted">${e.has_patient_ref ? '●●●●●●●●' : 'None'} — restricted to Admin and Stores.</div>`;
  modal(e.name, `<div class="page-head" style="margin:0 0 .75rem"><div><span class="mono">${esc(e.asset_tag)}</span> ${badge(e.status)}</div><div class="actions">${can('security', 'management') ? '' : `<a class="btn sm" href="#/label/${e.id}">QR label</a>`}
    ${can('admin', 'procurement', 'stores') ? `<button class="btn sm" data-act="edit-eq" data-id="${e.id}">Edit</button>` : ''}${can('admin') ? delBtn('equipment', e.id, e.asset_tag + ' ' + e.name, 'Delete', passes.length) : ''}${can('admin', 'stores', 'security') && nextPass(e.status) && (!can('security') || IO(nextPass(e.status))) ? `<a class="btn sm primary" href="#/gatepasses/new?tag=${encodeURIComponent(e.asset_tag)}">Gate pass ${nextPass(e.status)}</a>` : ''}</div></div>
    ${e.photo_path ? `<div data-photo-path="${esc(e.photo_path)}" data-alt="${esc(e.name)}"></div>` : ''}
    <div style="display:flex;gap:1rem;flex-wrap:wrap"><div class="qr" role="img" aria-label="QR code for ${esc(e.asset_tag)}">${qrSvg(e.asset_tag)}</div>
    <dl class="kv" style="flex:1;min-width:230px"><dt>Category</dt><dd>${esc(e.category || '—')}</dd><dt>Serial</dt><dd>${esc(e.serial_no || '—')}</dd><dt>Ownership</dt><dd>${e.ownership === 'owned' ? '<b>Owned by the Anantha hospital</b>' : e.ownership === 'demo' ? '<b>Demo instrument</b> (brought by supplier)' : 'Rented'}</dd>${e.ownership === 'owned' ? (e.supplier_name ? `<dt>Bought from</dt><dd>${esc(e.supplier_name)}</dd>` : '') : `<dt>Supplier</dt><dd>${esc(e.supplier_name)}</dd>${e.ownership === 'demo' ? '' : `<dt>PO</dt><dd>${esc(e.po_number || '—')}</dd>`}`}
    <dt>Location</dt><dd>${esc(e.location || '—')}</dd>${e.ownership === 'owned' ? '' : `${e.ownership === 'demo' || can('security') ? '' : `<dt>Daily rate</dt><dd>${money(e.daily_rate)}</dd>`}<dt>${e.ownership === 'demo' ? 'Demo start' : 'Rental start'}</dt><dd>${fmtDT(e.rental_start) || '—'}</dd><dt>Due back</dt><dd>${fmtD(e.expected_return) || '—'}</dd>`}
    ${e.status === 'in_repair' ? `<dt>Out for repair</dt><dd>${esc(e.repair_workshop || '—')} · since ${fmtDT(e.repair_started_at)}</dd>` : ''}
    ${e.status === 'scrapped' ? `<dt>Scrapped</dt><dd>${fmtDT(e.scrapped_at)}</dd>` : ''}
    ${e.status === 'on_site' ? `<dt>Days on site</dt><dd>${e.rental_days}${e.ownership === 'demo' || can('security') ? '' : ` (${money(e.rental_cost)})`}</dd>${e.overdue_days ? `<dt>Overdue</dt><dd><span class="badge overdue">${e.overdue_days} day(s)${e.ownership === 'demo' || can('security') ? '' : ' · extra ' + money(e.overdue_cost)}</span></dd>` : ''}` : ''}
    ${repairs.length && !can('security') ? `<dt>Repairs / service</dt><dd>${repairs.length} · total service cost ${money(repairs.reduce((a, g) => a + Number(g.service_cost || 0), 0))}</dd>` : ''}
    ${e.status === 'returned' && e.returned_at ? `<dt>Returned</dt><dd>${fmtDT(e.returned_at)}</dd>` : ''}</dl></div>${e.notes ? `<p class="small muted">${esc(e.notes)}</p>` : ''}
    <h3>Confidential patient reference</h3>${refUI}
    <h3>Gate pass history</h3>${passes.length ? `<div class="table-wrap"><table><thead><tr><th>Pass</th><th>Dir</th><th>Date &amp; time</th><th>By</th></tr></thead><tbody>${passes.map((g) =>
      `<tr><td><a href="#/pass/${g.id}">${esc(g.pass_no)}</a></td><td>${badge(g.direction)}</td><td>${fmtDT(g.issued_at)}</td><td>${esc(g.issued_by_name)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">None yet.</p>'}`);
  hydratePhotos();
}

async function equipmentForm(e = {}) {
  const [sup, pos, used] = await Promise.all([cache.suppliers || q(sb.from('suppliers').select('*').order('name')), q(sb.from('purchase_orders').select('id,po_number,supplier_id,status').order('id', { ascending: false })), q(sb.from('equipment').select('category').not('category', 'is', null).limit(1000))]);
  cache.suppliers = sup; cache.pos = pos;
  const seen = new Set(); const cats = [];
  ['Ventilator', 'Infusion pump', 'Patient monitor', 'Syringe pump', 'Oxygen concentrator', 'Defibrillator', 'Ultrasound', 'Hospital bed', ...used.map((r) => r.category)].forEach((c) => { const t = String(c || '').trim(); if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); cats.push(t); } });
  cats.sort((a, b) => a.localeCompare(b));
  const poList = pos.filter((p) => !e.supplier_id || p.supplier_id === e.supplier_id);
  return `<form data-form="equipment" data-id="${e.id || ''}" data-owned="${e.ownership === 'owned' ? '1' : ''}" data-own="${e.ownership || ''}"><div id="form-err"></div>
  ${e.id ? '' : `<div class="seg own-seg" role="radiogroup" aria-label="Ownership"><label><input type="radio" name="ownership" value="rented" checked><span>Rented from a supplier</span></label><label><input type="radio" name="ownership" value="owned"><span>Owned by the Anantha hospital</span></label><label><input type="radio" name="ownership" value="demo"><span>Demo instrument<small>brought by supplier</small></span></label></div>`}
  <div class="row"><label>Equipment name *<input name="name" required maxlength="150" value="${esc(e.name)}"></label>
  <label>Category <span class="hint">(type a new one or pick a suggestion)</span><input name="category" list="cats" maxlength="80" autocomplete="off" placeholder="Type or pick…" value="${esc(e.category)}"><datalist id="cats">${cats.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist></label></div>
  <div class="row"><label>Serial number<input name="serial_no" maxlength="80" value="${esc(e.serial_no)}"></label>
  <label><span id="sup-label">Supplier *</span><select name="supplier_id" data-supplier-select ${e.ownership === 'owned' ? '' : 'required'}><option value="">Select…</option>${opts(sup.filter((s) => s.active || s.id === e.supplier_id), 'id', (s) => s.name, e.supplier_id)}</select></label></div>
  <div class="row paid-only"><label>Purchase order<select name="po_id" id="po-select"><option value="">None</option>${opts(poList, 'id', (p) => p.po_number, e.po_id)}</select></label>
  <label>Daily rental rate (${CURRENCY}) *<input name="daily_rate" type="number" min="0" step="0.01" required value="${esc(e.daily_rate ?? '')}" ${e.id && !can('admin', 'procurement') ? 'disabled' : ''}></label></div>
  <div class="row"><label class="rented-only">Expected return date<input name="expected_return" type="date" value="${esc(e.expected_return)}"></label><label>Location / ward<input name="location" maxlength="120" value="${esc(e.location)}"></label></div>
  <label>Notes<textarea name="notes" maxlength="500">${esc(e.notes)}</textarea></label>
  <label>Photo <span class="hint">(optional - a clear picture helps staff recognise the item. Equipment only: no patients or patient labels)</span><input type="file" name="photo" accept="image/*"></label>
  <div style="margin:-.25rem 0 .5rem"><button type="button" class="btn sm" data-act="photo-cam">📷 Take photo with camera</button></div>
  <div id="photo-preview">${e.photo_path ? `<div data-photo-path="${esc(e.photo_path)}" data-alt="${esc(e.name)}"></div><label class="check"><input type="checkbox" name="remove_photo" value="1"> Remove the current photo</label>` : ''}</div>
  ${e.id ? '' : '<p class="muted small">The asset tag and QR code are generated automatically when you save.</p>'}
  <button class="btn primary">${e.id ? 'Save changes' : 'Create equipment'}</button></form>`;
}

async function pageGatepasses() {
  const allRows = await q(sb.from('gatepasses').select('id,pass_no,direction,issued_at,issued_by_name,rental_cost,equipment(name,asset_tag),suppliers(name)').order('id', { ascending: false }).limit(300));
  const m = can('admin', 'procurement', 'accounts', 'management');
  const rows = can('security') ? allRows.filter((g) => IO(g.direction)) : allRows;
  shell('gatepasses', `<div class="page-head"><h1>Gate passes</h1><div class="actions">${can('admin', 'stores', 'security') ? '<a class="btn primary" href="#/gatepasses/new">New gate pass</a>' : ''}</div></div>
  <div class="table-wrap"><table><thead><tr><th>Pass no.</th><th>Dir</th><th>Equipment</th><th>Supplier</th><th>Date &amp; time</th><th>Issued by</th>${m ? '<th>Rent</th>' : ''}${can('admin') ? '<th></th>' : ''}</tr></thead><tbody>${rows.map((g) =>
    `<tr><td><a href="#/pass/${g.id}">${esc(g.pass_no)}</a></td><td>${badge(g.direction)}</td><td>${esc(g.equipment?.name)} <span class="muted mono">${esc(g.equipment?.asset_tag)}</span></td><td>${esc(g.suppliers?.name || 'Owned by the Anantha hospital')}</td><td>${fmtDT(g.issued_at)}</td><td>${esc(g.issued_by_name)}</td>${m ? `<td>${g.direction === 'OUT' ? money(g.rental_cost) : ''}</td>` : ''}${can('admin') ? `<td>${delBtn('gatepass', g.id, g.pass_no)}</td>` : ''}</tr>`).join('') || '<tr><td colspan="8" class="muted">No gate passes yet.</td></tr>'}</tbody></table></div>`);
}

const delBtn = (kind, id, label, text = 'Delete', extra = 0) => `<button type="button" class="btn sm danger" data-act="ask-delete" data-kind="${kind}" data-id="${id}" data-label="${esc(label)}" data-extra="${extra}">${text}</button>`;
const DEL = {
  gatepass: ['gate pass', (l) => `This removes gate pass <b>${l}</b>. The equipment goes back to the status it had before this pass. Only the newest pass of an item can be deleted.`],
  equipment: ['equipment', (l, n) => `This removes <b>${l}</b>${n ? ` <b>and its ${n} gate pass${n > 1 ? 'es' : ''}</b>` : ''} for good, including its photo and patient reference.`],
  supplier: ['supplier', (l) => `This removes supplier <b>${l}</b>. It only works when no equipment, pass or purchase order uses it (otherwise untick "Active supplier" to retire it).`],
  po: ['purchase order', (l) => `This removes purchase order <b>${l}</b>. It only works when no equipment or pass uses it (otherwise use Close).`]
};
let passEq = null;
async function pagePassNew(params) {
  if (!can('admin', 'stores', 'security')) { shell('gatepasses', '<div class="error">Only Admin, Stores and Security can issue gate passes.</div>'); return; }
  passEq = null;
  shell('gatepasses', `<div class="page-head"><h1>New gate pass</h1></div><form class="card" data-form="pass" style="max-width:640px"><div id="form-err"></div>
    <div class="inline"><label>Asset tag / serial *<input name="tag" id="pass-tag" autocomplete="off" autocapitalize="characters" placeholder="Scan or type" value="${esc(params.get('tag') || '')}"></label>
    <button type="button" class="btn" data-act="scan-pass">Scan</button><button type="button" class="btn" data-act="find-pass">Find</button></div><div id="pass-eq" style="margin:.75rem 0"></div>
    <div id="pass-rest" hidden><div class="seg" id="pass-types" role="radiogroup" aria-label="Pass type"></div>
    <div id="pass-in-only"><label>Expected return date * <span class="hint">(drives the return alerts)</span><input name="expected_return" id="pass-due" type="date"></label></div>
    <div id="pass-repairout" hidden><label>Workshop / service provider *<input name="workshop" maxlength="120" placeholder="Who will repair it?"></label>
      <label>Fault / service needed *<textarea name="fault_notes" maxlength="300" placeholder="What is wrong, or what service is needed?"></textarea></label>
</div>
    <div id="pass-repairin" hidden><div id="pass-ws" class="muted small"></div><div class="row"><label>Service cost * <span class="hint">(enter 0 if free)</span><input name="service_cost" type="number" min="0" step="0.01" inputmode="decimal"></label>
      <label>Invoice / bill number<input name="invoice_no" maxlength="40"></label></div></div>
    <div id="pass-scrap" hidden><div class="note"><b>Scrapping is final.</b> The equipment is written off and can never be sent for repair or booked again.</div>
      <label>Reason for scrapping *<textarea name="scrap_reason" maxlength="300" placeholder="e.g. Beyond economical repair"></textarea></label>
      <label>Scrap / salvage value <span class="hint">(optional)</span><input name="scrap_value" type="number" min="0" step="0.01" inputmode="decimal"></label>
      <label class="check"><input type="checkbox" name="scrap_confirm"> <span>I confirm this equipment is to be scrapped and will not return.</span></label></div>
    <div id="pass-cost"></div>
    <div class="row"><label>Vehicle number<input name="vehicle_no" maxlength="30" autocapitalize="characters"></label><label>Driver / carrier name<input name="driver_name" maxlength="100"></label></div>
    <label>Condition on handover<input name="condition_notes" maxlength="300" placeholder="e.g. Good, accessories complete"></label><label>Remarks<textarea name="remarks" maxlength="300"></textarea></label>
    ${can('admin') ? '<label>Pass date &amp; time <span class="hint">(Admin only. Leave empty for now. Set an earlier date for equipment that came in before this app was used: rent counts from it)</span><input type="datetime-local" name="issued_at" id="pass-when" max="' + new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) + '"></label>' : '<p class="muted small">The date and time are recorded automatically when you issue the pass.</p>'}<button class="btn primary" id="pass-submit">Issue gate pass</button></div></form>`);
  if (params.get('tag')) await findForPass(); else $('#pass-tag').focus();
}
async function findForPass() {
  const tag = $('#pass-tag').value.trim(); if (!tag) return;
  try {
    const e = await findEquipment(tag); passEq = e; $('#pass-tag').value = e.asset_tag;
    $('#pass-eq').innerHTML = `<div class="okbox"><b>${esc(e.name)}</b> · ${esc(supplierOf(e))}${e.po_number ? ' · PO ' + esc(e.po_number) : ''} ${badge(e.status)}</div>${e.photo_path ? `<div data-photo-path="${esc(e.photo_path)}" data-alt="${esc(e.name)}"></div>` : ''}`; hydratePhotos();
    const types = passTypes(e.status).filter((t) => !can('security') || IO(t));
    if (!types.length && can('security') && e.status !== 'scrapped') { $('#pass-rest').hidden = true; $('#pass-eq').insertAdjacentHTML('beforeend', '<div class="error">Security can issue IN and OUT passes only. Ask Stores to issue the repair or scrap pass for this item.</div>'); return; }
    if (!types.length) { $('#pass-rest').hidden = true; $('#pass-eq').insertAdjacentHTML('beforeend', '<div class="error">This equipment has been scrapped. No more gate passes can be issued for it.</div>'); return; }
    $('#pass-types').innerHTML = types.map((t, i) => `<label><input type="radio" name="direction" value="${t}" ${i === 0 ? 'checked' : ''}><span>${PASS_LABEL[t]}</span></label>`).join('');
    $('#pass-rest').hidden = false; $('#pass-due').value = e.expected_return || ''; syncPassDirection();
  } catch (err) { passEq = null; $('#pass-rest').hidden = true; $('#pass-eq').innerHTML = `<div class="error">${esc(err.message)}</div>`; }
}
function syncOwnership() {
  const form = document.querySelector('form[data-form=equipment]'); if (!form) return;
  const kind = form.dataset.own || form.querySelector('input[name=ownership]:checked')?.value || 'rented';
  const owned = kind === 'owned', demo = kind === 'demo';
  form.querySelectorAll('.rented-only').forEach((el) => { el.hidden = owned; el.querySelectorAll('input,select').forEach((i) => { i.disabled = owned; }); });
  form.querySelectorAll('.paid-only').forEach((el) => { el.hidden = owned || demo; el.querySelectorAll('input,select').forEach((i) => { i.disabled = owned || demo || (i.name === 'daily_rate' && !!form.dataset.id && !can('admin', 'procurement')); }); });
  const sel = form.querySelector('[name=supplier_id]'); if (sel) sel.required = !owned;
  const lab = form.querySelector('#sup-label'); if (lab) lab.textContent = owned ? 'Bought from (optional)' : demo ? 'Supplier bringing the demo *' : 'Supplier *';
  const rate = form.querySelector('[name=daily_rate]'); if (rate) rate.required = !owned && !demo;
}
function syncPassDirection() {
  const dir = document.querySelector('input[name=direction]:checked')?.value; if (!dir) return;
  const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
  show('#pass-in-only', dir === 'IN'); show('#pass-repairout', dir === 'REPAIR_OUT'); show('#pass-repairin', dir === 'REPAIR_IN'); show('#pass-scrap', dir === 'SCRAP');
  const notes = [];
  if (dir === 'REPAIR_OUT') notes.push('This is Anantha hospital-owned equipment: no rent is involved. Record where it is going and what is wrong.');
  if (dir === 'REPAIR_IN' && passEq) $('#pass-ws').textContent = 'Sent to: ' + (passEq.repair_workshop || '—') + ' on ' + fmtDT(passEq.repair_started_at);
  $('#pass-cost').innerHTML = notes.map((n) => `<div class="note">${n}</div>`).join('');
  const btn = $('#pass-submit'); btn.textContent = dir === 'SCRAP' ? 'Scrap equipment' : dir === 'REPAIR_OUT' ? 'Issue repair pass (OUT)' : dir === 'REPAIR_IN' ? 'Issue repair pass (IN)' : 'Issue gate pass';
  btn.classList.toggle('danger', dir === 'SCRAP'); btn.classList.toggle('primary', dir !== 'SCRAP');
}

async function pagePass(id) {
  const g = (await q(sb.from('gatepasses').select('*,equipment(name,asset_tag,serial_no,photo_path),suppliers(name),purchase_orders(po_number)').eq('id', id).limit(1)))[0];
  if (!g || (can('security') && !IO(g.direction))) throw new Error('Gate pass not found');
  const vq = (await q(sb.from('v_equipment').select('photo_path,ownership').eq('id', g.equipment_id).limit(1)))[0] || {};
  const photoPath = vq.photo_path || g.equipment?.photo_path || null;   // same source the equipment screen uses
  const isDemo = vq.ownership === 'demo';
  const m = g.direction === 'OUT' && !isDemo && can('admin', 'procurement', 'accounts', 'management');
  const title = { REPAIR_OUT: 'Equipment Gate Pass — Out for Repair / Service', REPAIR_IN: 'Equipment Gate Pass — Back from Repair / Service', SCRAP: 'Equipment Gate Pass — Scrap / Write-off' }[g.direction] || (isDemo ? 'Equipment Gate Pass — Demo Instrument' : 'Equipment Gate Pass');
  const row = (k, v) => (v == null || v === '' ? '' : `<dt>${k}</dt><dd>${v}</dd>`);
  const extra = g.direction === 'REPAIR_OUT' ? row('Workshop', esc(g.workshop)) + row('Fault', esc(g.fault_notes))
    : g.direction === 'REPAIR_IN' ? row('Workshop', esc(g.workshop)) + row('Fault', esc(g.fault_notes)) + row('Service cost', money(g.service_cost)) + row('Invoice no.', esc(g.invoice_no))
    : g.direction === 'SCRAP' ? row('Scrap reason', esc(g.scrap_reason)) + row('Scrap value', g.scrap_value == null ? '' : money(g.scrap_value)) + row('Last workshop', esc(g.workshop)) : '';
  const sig = g.direction === 'SCRAP' ? '<div>Issued by (Stores)</div><div>Approved by (Admin)</div><div>Security</div>'
    : g.direction.startsWith('REPAIR') ? '<div>Issued by (Stores)</div><div>Security</div><div>Workshop / Service provider</div>'
    : '<div>Issued by (Stores)</div><div>Security</div><div>Carrier / Supplier</div>';
  shell('gatepasses', `<div class="page-head no-print"><a href="#/gatepasses">← Gate passes</a><div class="actions">${can('admin') && (g.direction === 'IN' || g.direction === 'OUT') ? `<button class="btn" data-act="edit-pass" data-id="${g.id}">Edit this pass</button>` : ''}${can('admin') ? delBtn('gatepass', g.id, g.pass_no, 'Delete this pass') : ''}<button class="btn" data-act="print-a5">Print A5</button><button class="btn primary" data-act="print">Print A4</button></div></div>
  <div class="sheet"><img class="sheet-logo" src="/logo.png" alt="Anantha MK Institute of Medical Sciences LLP">${companyBlock()}<div class="pass-banner pb-${esc(g.direction)}"><div class="pb-main">${esc(BANNER[g.direction][0])}</div></div><h1><span>${esc(title)}</span></h1><div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap"><dl class="kv"><dt>Pass no.</dt><dd class="mono">${esc(g.pass_no)}</dd><dt>Date &amp; time</dt><dd>${fmtDT(g.issued_at)}</dd>
  <dt>Equipment</dt><dd>${esc(g.equipment?.name)}</dd><dt>Asset tag</dt><dd class="mono">${esc(g.equipment?.asset_tag)}</dd><dt>Serial</dt><dd>${esc(g.equipment?.serial_no || '—')}</dd>${g.suppliers?.name ? `<dt>Supplier</dt><dd>${esc(g.suppliers.name)}</dd><dt>PO</dt><dd>${esc(g.purchase_orders?.po_number || '—')}</dd>` : '<dt>Ownership</dt><dd>Owned by Anantha Hospital</dd>'}
  ${extra}<dt>Vehicle</dt><dd>${esc(g.vehicle_no || '—')}</dd><dt>Driver</dt><dd>${esc(g.driver_name || '—')}</dd><dt>Condition</dt><dd>${esc(g.condition_notes || '—')}</dd><dt>Remarks</dt><dd>${esc(g.remarks || '—')}</dd><dt>Issued by</dt><dd>${esc(g.issued_by_name)}</dd>
  ${m ? `<dt>Rental days</dt><dd>${g.rental_days}</dd><dt>Rent</dt><dd>${money(g.rental_cost)}</dd>${g.overdue_days ? `<dt>Overdue</dt><dd>${g.overdue_days} day(s), extra ${money(g.overdue_cost)}</dd>` : ''}` : ''}</dl>
  <div class="qr" role="img" aria-label="QR code">${qrSvg(g.equipment?.asset_tag)}</div></div>${photoPath ? `<div class="sheet-photo"><div class="small muted">Item photo — for Security to identify the equipment</div><div data-photo-path="${esc(photoPath)}" data-alt="${esc(g.equipment?.name)}"></div></div>` : '<p class="small muted no-print">No photo on record for this item. Add one under Equipment → Edit so Security can identify it.</p>'}${g.direction === 'SCRAP' ? '<p class="small"><b>This equipment has been scrapped and will not return to the hospital store.</b></p>' : ''}<div class="sig">${sig}</div></div>`);
  hydratePhotos();
}
async function pageLabel(id) {
  const e = (await q(sb.from('v_equipment').select('asset_tag,name,supplier_name').eq('id', id).limit(1)))[0]; if (!e) throw new Error('Equipment not found');
  shell('equipment', `<div class="page-head no-print"><a href="#/equipment">← Equipment</a><div class="actions"><button class="btn primary" data-act="print">Print label</button></div></div>
  <div class="label-sheet"><div class="qrbig" role="img" aria-label="QR ${esc(e.asset_tag)}">${qrSvg(e.asset_tag)}</div><div class="mono" style="font-size:1.3rem;font-weight:700">${esc(e.asset_tag)}</div><div>${esc(e.name)}</div><div class="small">${esc(e.supplier_name)}</div></div>`);
}

async function pageSuppliers() {
  const rows = await q(sb.from('suppliers').select('*').order('name')); cache.suppliers = rows;
  shell('suppliers', `<div class="page-head"><h1>Suppliers</h1><div class="actions">${can('admin', 'procurement') ? '<button class="btn primary" data-act="new-sup">Add supplier</button>' : ''}</div></div>
  <div class="list">${rows.map((s) => `<button class="item-card" data-act="edit-sup" data-id="${s.id}"><div><div class="t">${esc(s.name)} ${s.active ? '' : badge('inactive')}</div><div class="meta">${esc([s.contact_person, s.phone, s.email].filter(Boolean).join(' · ')) || 'No contact details'}</div></div></button>`).join('') || '<p class="muted">No suppliers yet.</p>'}</div>`);
}
function supplierForm(s = {}) {
  const ro = can('admin', 'procurement') ? '' : 'disabled';
  return `<form data-form="supplier" data-id="${s.id || ''}"><div id="form-err"></div><label>Supplier name *<input name="name" required maxlength="150" value="${esc(s.name)}" ${ro}></label>
  <div class="row"><label>Contact person<input name="contact_person" maxlength="100" value="${esc(s.contact_person)}" ${ro}></label><label>Phone<input name="phone" type="tel" maxlength="40" value="${esc(s.phone)}" ${ro}></label></div>
  <div class="row"><label>Email<input name="email" type="email" maxlength="120" value="${esc(s.email)}" ${ro}></label><label>Tax / GST ID<input name="tax_id" maxlength="40" value="${esc(s.tax_id)}" ${ro}></label></div>
  <label>Address<textarea name="address" maxlength="300" ${ro}>${esc(s.address)}</textarea></label>${s.id ? `<label><input type="checkbox" name="active" style="width:auto;min-height:0" ${s.active ? 'checked' : ''} ${ro}> Active supplier</label>` : ''}
  ${ro ? '' : `<button class="btn primary">${s.id ? 'Save changes' : 'Add supplier'}</button>`}${s.id && can('admin') ? ' ' + delBtn('supplier', s.id, s.name, 'Delete supplier') : ''}</form>`;
}

async function pagePOs() {
  const [rows, sup] = await Promise.all([q(sb.from('purchase_orders').select('*,suppliers(name)').order('issue_date', { ascending: false }).order('id', { ascending: false })), q(sb.from('suppliers').select('*').order('name'))]);
  cache.suppliers = sup; cache.pos = rows; const edit = can('admin', 'procurement');
  shell('pos', `<div class="page-head"><h1>Purchase orders</h1><div class="actions">${edit ? '<button class="btn primary" data-act="new-po">New PO</button>' : ''}</div></div>
  <div class="table-wrap"><table><thead><tr><th>PO no.</th><th>Supplier</th><th>Date</th><th>Status</th><th class="wrap">Notes</th>${edit ? '<th></th>' : ''}</tr></thead><tbody>${rows.map((p) =>
    `<tr><td><b>${esc(p.po_number)}</b></td><td>${esc(p.suppliers?.name)}</td><td>${fmtD(p.issue_date)}</td><td>${badge(p.status, p.status === 'open' ? 'ok' : p.status === 'closed' ? 'returned' : 'bad')}</td><td class="wrap">${esc(p.notes || '')}</td>
    ${edit ? `<td><button class="btn sm" data-act="edit-po" data-id="${p.id}">Edit</button> ${p.status === 'open' ? `<button class="btn sm" data-act="po-status" data-id="${p.id}" data-s="closed">Close</button>` : p.status === 'closed' ? `<button class="btn sm" data-act="po-status" data-id="${p.id}" data-s="open">Reopen</button>` : ''}${can('admin') ? ' ' + delBtn('po', p.id, p.po_number) : ''}</td>` : ''}</tr>`).join('') || '<tr><td colspan="6" class="muted">No purchase orders yet.</td></tr>'}</tbody></table></div>`);
}

const REPORTS = {
  inventory: { title: 'Inventory status', roles: [...ALL, 'management'], load: async () => (await q(sb.from('v_equipment').select('*').order('status').order('name'))).map((e) => ({ ...e, rental_start: e.rental_start?.slice(0, 10), days_on_site: e.rental_days ?? '', overdue_days: e.overdue_days ?? '' })),
    cols: [['asset_tag', 'Asset tag'], ['name', 'Equipment'], ['category', 'Category'], ['serial_no', 'Serial'], ['supplier_name', 'Supplier'], ['po_number', 'PO'], ['status', 'Status'], ['location', 'Location'], ['rental_start', 'Rental start'], ['expected_return', 'Due back'], ['days_on_site', 'Days on site'], ['overdue_days', 'Overdue days']] },
  'rental-costs': { title: 'Rental costs', roles: ['admin', 'procurement', 'accounts', 'management'], load: () => rpc('report_rental_costs'), money: ['daily_rate', 'rent_to_date', 'overdue_rent'],
    cols: [['asset_tag', 'Asset tag'], ['name', 'Equipment'], ['supplier', 'Supplier'], ['po_number', 'PO'], ['status', 'Status'], ['daily_rate', 'Daily rate'], ['total_days', 'Rental days'], ['rent_to_date', 'Rent to date'], ['overdue_rent', 'Of which overdue'], ['still_accruing', 'Accruing']],
    totals: (r) => [['Total rent', r.reduce((a, x) => a + Number(x.rent_to_date), 0), true], ['Total overdue rent', r.reduce((a, x) => a + Number(x.overdue_rent), 0), true]],
    note: 'Rent is charged per started 24h block (minimum 1 day). Overdue = days after the expected return date.' },
  'service-costs': { title: 'Repairs & scrap (owned)', roles: ['admin', 'procurement', 'accounts', 'management'], load: async () => (await rpc('report_service_costs')).map((r) => ({ ...r, issued_at: fmtDT(r.issued_at) })), money: ['service_cost', 'scrap_value'],
    cols: [['pass_no', 'Pass'], ['kind', 'Type'], ['issued_at', 'Date & time'], ['asset_tag', 'Asset tag'], ['name', 'Equipment'], ['category', 'Category'], ['workshop', 'Workshop'], ['fault_notes', 'Fault / service'], ['service_cost', 'Service cost'], ['invoice_no', 'Invoice'], ['scrap_reason', 'Scrap reason'], ['scrap_value', 'Scrap value']],
    totals: (r) => [['Repairs done', r.filter((x) => x.kind === 'REPAIR_IN').length], ['Total service cost', r.reduce((a, x) => a + Number(x.service_cost || 0), 0), true], ['Items scrapped', r.filter((x) => x.kind === 'SCRAP').length]],
    note: 'Anantha hospital-owned equipment only. One line per completed repair or service (the pass issued when the item came back) and per scrapped item.' },
  'supplier-usage': { title: 'Supplier usage', roles: ['admin', 'procurement', 'accounts', 'management'], load: () => rpc('report_supplier_usage'), money: ['total_rent', 'overdue_rent'],
    cols: [['supplier', 'Supplier'], ['purchase_orders', 'POs'], ['equipment_items', 'Items'], ['on_site_now', 'On site now'], ['overdue_now', 'Overdue now'], ['rental_days', 'Rental days'], ['total_rent', 'Total rent'], ['overdue_rent', 'Overdue rent']],
    totals: (r) => [['Total rent', r.reduce((a, x) => a + Number(x.total_rent), 0), true]] },
};
async function pageReports(kind) {
  const tabs = Object.entries(REPORTS).filter(([, r]) => can(...r.roles));
  if (!REPORTS[kind] || !can(...REPORTS[kind].roles)) { location.hash = '#/reports/inventory'; return; }
  const R = REPORTS[kind], rows = await R.load(); cache.report = { kind, R, rows };
  const cell = (k, v) => (R.money?.includes(k) ? money(v) : k === 'status' || k === 'kind' ? esc(label(v)) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : esc(v ?? ''));
  shell('reports', `<div class="page-head"><h1>Reports</h1><div class="actions"><button class="btn" data-act="csv">Download CSV</button><button class="btn" data-act="print">Print</button></div></div>
  <div class="tabs no-print">${tabs.map(([k, r]) => `<a href="#/reports/${k}" class="${k === kind ? 'active' : ''}">${r.title}</a>`).join('')}</div>
  ${R.totals ? `<div class="stats">${R.totals(rows).map(([l, v, m]) => `<div class="stat"><div class="n">${m ? money(v) : esc(v)}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>` : `<div class="stats"><div class="stat"><div class="n">${rows.length}</div><div class="l">Items</div></div><div class="stat"><div class="n">${rows.filter((r) => r.status === 'on_site').length}</div><div class="l">On site</div></div></div>`}
  ${R.note ? `<p class="muted small">${esc(R.note)}</p>` : ''}<div class="table-wrap"><table><thead><tr>${R.cols.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${R.cols.map(([k]) => `<td>${cell(k, r[k])}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${R.cols.length}" class="muted">No data.</td></tr>`}</tbody></table></div>`);
  sb.rpc('log_event', { p_action: 'REPORT_VIEWED', p_details: kind });
}

async function pageUsers() {
  const rows = await q(sb.from('profiles').select('*').order('email')); cache.users = rows;
  shell('users', `<div class="page-head"><div><h1>Users</h1>${state.user?.email === 'pradish.prs@gmail.com' ? '<div class="muted small">New people are added in Supabase (Authentication &gt; Users &gt; Add user). They appear here with no role until you assign one.</div>' : ''}</div></div>
  <div class="list">${rows.map((u) => `<button class="item-card" data-act="edit-user" data-id="${esc(u.id)}"><div><div class="t">${esc(u.full_name || u.email)} <span class="muted small">${esc(u.email)}</span></div><div class="meta">${u.role ? esc(label(u.role)) : '<b style="color:var(--warn)">No role yet</b>'}</div></div>${u.active ? badge('active', 'ok') : badge('disabled', 'bad')}</button>`).join('')}</div>`);
}
function userForm(u) {
  const roles = ['', 'admin', 'procurement', 'stores', 'accounts', 'security', 'management'].map((r) => `<option value="${r}" ${(u.role || '') === r ? 'selected' : ''}>${r ? label(r) : '— no access —'}</option>`).join('');
  return `<form data-form="user" data-id="${esc(u.id)}"><div id="form-err"></div><p class="muted">${esc(u.email)}</p><label>Full name<input name="full_name" maxlength="100" value="${esc(u.full_name)}"></label><label>Role<select name="role">${roles}</select></label>
  <label><input type="checkbox" name="active" style="width:auto;min-height:0" ${u.active ? 'checked' : ''}> Account active</label><button class="btn primary">Save changes</button></form>`;
}

async function pageAudit(filters = {}) {
  let query = sb.from('audit_log').select('*').order('id', { ascending: false }).limit(300);
  if (filters.user) query = query.ilike('user_email', `%${filters.user}%`);
  if (filters.action) query = query.ilike('action', `%${filters.action}%`);
  const rows = await q(query); cache.audit = rows;
  shell('audit', `<div class="page-head"><div><h1>Audit trail</h1><div class="muted small">Append-only, hash-chained log: who did what, and when. Showing the latest 300.</div></div><div class="actions"><button class="btn" data-act="verify-audit">Verify integrity</button><button class="btn" data-act="audit-csv">Export CSV</button></div></div><div id="verify"></div>
  <form class="filters" data-form="audit-filter"><input name="user" placeholder="User email" value="${esc(filters.user || '')}"><input name="action" placeholder="Action e.g. gatepasses, PATIENT_REF" value="${esc(filters.action || '')}"><button class="btn">Filter</button></form>
  <div class="table-wrap"><table><thead><tr><th>Time</th><th>User</th><th>Role</th><th>Action</th><th>Record</th><th class="wrap">Details</th></tr></thead><tbody>${rows.map((r) =>
    `<tr><td>${fmtDT(r.ts)}</td><td>${esc(r.user_email || 'system')}</td><td>${esc(r.role || '')}</td><td><b>${esc(r.action)}</b></td><td>${esc([r.entity, r.entity_id].filter(Boolean).join(' #'))}</td><td class="wrap small">${esc(r.details ? JSON.stringify(r.details).slice(0, 220) : '')}</td></tr>`).join('')}</tbody></table></div>`);
}

function pagePassword() {
  shell('', `<div class="page-head"><h1>Change password</h1></div><form class="card" data-form="password" style="max-width:460px"><div id="form-err"></div>
  <label>New password <span class="hint">(at least 10 characters)</span><input name="new_password" type="password" autocomplete="new-password" minlength="10" required></label><label>Repeat new password<input name="repeat" type="password" autocomplete="new-password" minlength="10" required></label><button class="btn primary">Update password</button></form>`);
}

/* ---------- Click actions ---------- */
const actions = {
  'close-modal': closeModal,
  'toggle-nav': () => $('#nav').classList.toggle('open'),
  'toggle-theme': () => { const t = window.HRE_THEME?.toggle(); const b = $('#theme-btn'); if (b) b.innerHTML = icon(t === 'dark' ? 'sun' : 'moon'); },
  print: () => printSheet(),
  'print-a5': () => printSheet('A5'),
  logout: () => signOut(),
  'scan-lookup': () => openScanner((t) => lookupTag(t)),
  'scan-pass': () => openScanner((t) => { $('#pass-tag').value = t; findForPass(); }),
  'find-pass': () => findForPass(),
  'open-eq': (d) => openEquipment(d.id),
  'photo-cam': () => openCamera(setFormPhoto),
  'new-eq': async () => { modal('Add equipment', await equipmentForm()); syncOwnership(); },
  'edit-eq': async (d) => { modal('Edit equipment', await equipmentForm((await q(sb.from('v_equipment').select('*').eq('id', d.id).limit(1)))[0])); hydratePhotos(); syncOwnership(); },
  'ref-show': async (d) => {
    const v = await rpc('get_patient_ref', { p_equipment_id: Number(d.id) });
    $('#ref-box').innerHTML = `<div class="val mono">${esc(v || '(empty)')}</div><div class="muted small">Hides automatically in 30 seconds. This view was logged.</div>`;
    clearTimeout(refTimer); refTimer = setTimeout(() => { const b = $('#ref-box'); if (b) b.innerHTML = '<span class="muted">Hidden. Viewing is logged.</span>'; }, 30000);
  },
  'ref-edit': (d) => { $('#ref-box').innerHTML = `<form class="inline" data-form="patient-ref" data-id="${esc(d.id)}"><label>Patient reference <span class="hint">(leave empty to clear)</span><input name="patient_ref" maxlength="100" autocomplete="off"></label><button class="btn primary">Save</button></form>`; },
  'new-sup': () => modal('Add supplier', supplierForm()),
  'edit-sup': (d) => modal('Supplier', supplierForm(cache.suppliers.find((s) => String(s.id) === d.id))),
  'new-po': () => modal('New purchase order', `<form data-form="po"><div id="form-err"></div><div class="row"><label>PO number *<input name="po_number" required maxlength="40"></label><label>Issue date *<input name="issue_date" type="date" required value="${today()}"></label></div>
    <label>Supplier *<select name="supplier_id" required><option value="">Select…</option>${opts(cache.suppliers.filter((s) => s.active), 'id', (s) => s.name)}</select></label><label>Notes<textarea name="notes" maxlength="500"></textarea></label><button class="btn primary">Create PO</button></form>`),
  'edit-po': (d) => { const p = (cache.pos || []).find((x) => String(x.id) === d.id); if (!p) return;
    modal('Edit purchase order', `<form data-form="poedit" data-id="${p.id}"><div id="form-err"></div><div class="row"><label>PO number *<input name="po_number" required maxlength="40" value="${esc(p.po_number)}"></label><label>Issue date *<input name="issue_date" type="date" required value="${esc(p.issue_date)}"></label></div>
    <p class="muted small">Supplier: <b>${esc(p.suppliers?.name)}</b> (cannot be changed - create a new PO for another supplier).</p><label>Notes<textarea name="notes" maxlength="500">${esc(p.notes || '')}</textarea></label><button class="btn primary">Save changes</button></form>`); },
  'edit-pass': async (d) => {
    const g = (await q(sb.from('gatepasses').select('*,equipment(name,asset_tag,serial_no,expected_return)').eq('id', d.id).limit(1)))[0]; if (!g) throw new Error('Gate pass not found');
    const last = (await q(sb.from('gatepasses').select('id').eq('equipment_id', g.equipment_id).order('id', { ascending: false }).limit(1)))[0];
    const local = (t) => new Date(new Date(t).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const showDue = g.direction === 'IN' && last && last.id === g.id;
    modal('Edit gate pass ' + g.pass_no, `<form data-form="editpass" data-id="${g.id}" data-due="${showDue ? '1' : ''}"><div id="form-err"></div>
      <p class="muted small">${esc(g.equipment?.name)} <span class="mono">${esc(g.equipment?.asset_tag)}</span>. Only the Admin can change an issued pass. The old and new values are kept in the audit trail together with your reason. Rent figures are recalculated from the corrected dates.</p>
      <label>Pass date &amp; time *<input type="datetime-local" name="issued_at" required value="${local(g.issued_at)}" max="${local(Date.now())}"></label>
      ${showDue ? `<label>Expected return date<input type="date" name="expected_return" value="${esc(g.equipment?.expected_return || '')}"></label>` : ''}
      <label>Equipment serial number<input name="serial_no" maxlength="80" value="${esc(g.equipment?.serial_no || '')}"></label>
      <div class="row"><label>Vehicle number<input name="vehicle_no" maxlength="30" value="${esc(g.vehicle_no || '')}"></label><label>Driver / carrier name<input name="driver_name" maxlength="100" value="${esc(g.driver_name || '')}"></label></div>
      <label>Condition on handover<input name="condition_notes" maxlength="300" value="${esc(g.condition_notes || '')}"></label>
      <label>Remarks<textarea name="remarks" maxlength="300">${esc(g.remarks || '')}</textarea></label>
      <label>Reason for the change * <span class="hint">(for example: wrong date entered)</span><textarea name="reason" required minlength="3" maxlength="200"></textarea></label>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap"><button class="btn primary">Save changes</button><button type="button" class="btn" data-act="close-modal">Cancel</button></div></form>`);
  },
  'ask-delete': (d) => {
    const [name, text] = DEL[d.kind];
    modal('Delete ' + name, `<form data-form="delete" data-kind="${esc(d.kind)}" data-id="${esc(d.id)}"><div id="form-err"></div>
      <p>${text(esc(d.label), Number(d.extra || 0))}</p>
      <p class="muted small">Deleted entries disappear from the lists and from every report. The audit trail keeps a copy and your reason, so there is always a record of who deleted what.</p>
      <label>Reason for deleting * <span class="hint">(for example: entered by mistake)</span><textarea name="reason" required minlength="3" maxlength="200" placeholder="Why is this being deleted?"></textarea></label>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap"><button class="btn danger">Yes, delete permanently</button><button type="button" class="btn" data-act="close-modal">Cancel</button></div></form>`);
  },
  'po-status': async (d) => { const r = await q(sb.from('purchase_orders').update({ status: d.s }).eq('id', d.id).select()); if (!r.length) throw new Error('Your role is not allowed to do this.'); route(); },
  'an-clear': () => { $('#an-from').value = ''; $('#an-till').value = ''; loadAnalytics(); },
  'edit-user': (d) => modal('Edit user', userForm(cache.users.find((u) => u.id === d.id))),
  'verify-audit': async () => { const r = await rpc('verify_audit_chain'); $('#verify').innerHTML = r.ok ? `<div class="okbox">Integrity verified — ${r.checked} entries, no tampering detected.</div>` : `<div class="error">Chain broken at entry #${r.broken_at}. Investigate immediately.</div>`; },
  csv: async () => { const { kind, R, rows } = cache.report; downloadCsv(kind, R.cols.map(([key, l]) => ({ key, label: l })), rows); sb.rpc('log_event', { p_action: 'REPORT_EXPORTED', p_details: kind }); },
  'audit-csv': async () => { downloadCsv('audit-trail', ['id', 'ts', 'user_email', 'role', 'action', 'entity', 'entity_id', 'details'].map((k) => ({ key: k, label: k })), cache.audit.map((r) => ({ ...r, details: r.details ? JSON.stringify(r.details) : '' }))); sb.rpc('log_event', { p_action: 'AUDIT_EXPORTED' }); },
};
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]'); if (!el) return;
  const fn = actions[el.dataset.act]; if (!fn) return; ev.preventDefault();
  try { await fn(el.dataset, el); } catch (e) { fail(e); }
});
document.addEventListener('change', async (ev) => {
  if (ev.target.matches('#an-from,#an-till')) loadAnalytics();
  if (ev.target.matches('input[name=direction]')) syncPassDirection();
  if (ev.target.matches('input[name=ownership]')) syncOwnership();
  if (ev.target.matches('input[name=photo]')) {
    const box = $('#photo-preview'); const f = ev.target.files[0]; if (!box) return;
    box.querySelectorAll('.photo-new').forEach((n) => n.remove());
    if (f && f.type.startsWith('image/')) { const d = document.createElement('div'); d.className = 'photo-new'; const i = document.createElement('img'); i.className = 'eqphoto'; i.alt = 'Selected photo'; i.src = URL.createObjectURL(f); i.onload = () => URL.revokeObjectURL(i.src); d.append(i); box.prepend(d); }
  }
  if (ev.target.matches('[data-supplier-select]')) {
    const sid = Number(ev.target.value);
    $('#po-select').innerHTML = '<option value="">None</option>' + opts((cache.pos || []).filter((p) => p.supplier_id === sid && p.status === 'open'), 'id', (p) => p.po_number);
  }
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.id === 'pass-tag') { ev.preventDefault(); findForPass(); } });

/* ---------- Form submits ---------- */
const clean = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v]));
const formErr = (form, msg) => { const b = form.querySelector('#form-err') || $('#form-err'); if (b) b.innerHTML = `<div class="error">${esc(msg)}</div>`; else toast(msg, true); };
const forms = {
  editpass: async (f, form) => {
    try {
      const r = await rpc('edit_gatepass', { p_id: Number(form.dataset.id), p_issued_at: new Date(f.issued_at).toISOString(), p_vehicle_no: f.vehicle_no || null, p_driver_name: f.driver_name || null,
        p_condition_notes: f.condition_notes || null, p_remarks: f.remarks || null, p_serial_no: f.serial_no || null, p_expected_return: form.dataset.due ? (f.expected_return || null) : null, p_reason: f.reason });
      closeModal(); toast('Gate pass updated'); location.hash = '#/pass/' + r.id; route();
    } catch (e) { formErr(form, e.message); }
  },
  delete: async (f, form) => {
    const { kind, id } = form.dataset;
    const fn = { gatepass: 'delete_gatepass', equipment: 'delete_equipment', supplier: 'delete_supplier', po: 'delete_purchase_order' }[kind];
    const where = { gatepass: '#/gatepasses', equipment: '#/equipment', supplier: '#/suppliers', po: '#/pos' }[kind];
    let photo = null;
    if (kind === 'equipment') { try { photo = (await q(sb.from('v_equipment').select('photo_path').eq('id', id).limit(1)))[0]?.photo_path || null; } catch { /* no photo */ } }
    try {
      const what = await rpc(fn, { p_id: Number(id), p_reason: f.reason });
      if (photo) sb.storage.from(PHOTO_BUCKET).remove([photo]).catch(() => {});
      closeModal(); toast('Deleted ' + what); if (location.hash === where) route(); else location.hash = where;
    } catch (e) { formErr(form, e.message); }
  },
  login: async (f, form) => {
    const { error } = await sb.auth.signInWithPassword({ email: f.email.trim(), password: f.password });
    if (error) { $('#login-err').innerHTML = '<div class="error">Invalid email or password.</div>'; form.password.value = ''; return; }
    await loadProfile(); if (state.profile) await sb.rpc('log_event', { p_action: 'LOGIN' });
    location.hash = '#/dashboard'; route();
  },
  password: async (f, form) => {
    if (f.new_password !== f.repeat) return formErr(form, 'The two passwords do not match.');
    const { error } = await sb.auth.updateUser({ password: f.new_password }); if (error) return formErr(form, error.message);
    toast('Password updated'); location.hash = '#/dashboard';
  },
  lookup: (f) => lookupTag(f.tag),
  equipment: async (f, form) => {
    const id = form.dataset.id; const body = clean(f);
    const file = form.querySelector('[name=photo]')?.files[0]; const dropPhoto = !!form.querySelector('[name=remove_photo]')?.checked;
    const oldPath = form.querySelector('#photo-preview [data-photo-path]')?.dataset.photoPath || null;
    delete body.photo; delete body.remove_photo;
    if (body.daily_rate != null) body.daily_rate = Number(body.daily_rate); if (form.querySelector('[name=daily_rate]').disabled) delete body.daily_rate;
    if (body.supplier_id) body.supplier_id = Number(body.supplier_id); if (body.po_id) body.po_id = Number(body.po_id);
    try {
      let eqId = id;
      if (id) { const r = await q(sb.from('equipment').update(body).eq('id', id).select()); if (!r.length) throw new Error('Your role is not allowed to do this.'); }
      else eqId = (await q(sb.from('equipment').insert(body).select()))[0].id;
      let note = '';
      try { if (file) await savePhoto(eqId, file, oldPath); else if (dropPhoto && oldPath) await removePhoto(eqId, oldPath); }
      catch (pe) { note = ` - but the photo was not saved: ${pe.message}`; }
      closeModal(); toast((id ? 'Equipment updated' : 'Equipment created') + note); route();
    } catch (e) { formErr(form, e.message); }
  },
  'patient-ref': async (f, form) => { try { await rpc('set_patient_ref', { p_equipment_id: Number(form.dataset.id), p_value: f.patient_ref || null }); toast('Patient reference saved (encrypted)'); openEquipment(form.dataset.id); } catch (e) { fail(e); } },
  supplier: async (f, form) => {
    const id = form.dataset.id; const body = clean(f); if (id) body.active = !!form.querySelector('[name=active]')?.checked;
    try { if (id) { const r = await q(sb.from('suppliers').update(body).eq('id', id).select()); if (!r.length) throw new Error('Your role is not allowed to do this.'); } else await q(sb.from('suppliers').insert(body).select()); closeModal(); toast('Supplier saved'); route(); } catch (e) { formErr(form, e.message); }
  },
  poedit: async (f, form) => { try { const b = clean(f); const r = await q(sb.from('purchase_orders').update({ po_number: b.po_number, issue_date: b.issue_date, notes: b.notes }).eq('id', Number(form.dataset.id)).select()); if (!r.length) throw new Error('Your role is not allowed to do this.'); closeModal(); toast('Purchase order updated'); route(); } catch (e) { formErr(form, e.message); } },
  po: async (f, form) => { try { const b = clean(f); b.supplier_id = Number(b.supplier_id); await q(sb.from('purchase_orders').insert(b).select()); closeModal(); toast('Purchase order created'); route(); } catch (e) { formErr(form, e.message); } },
  pass: async (f, form) => {
    if (!passEq) return formErr(form, 'Find the equipment first (scan or type its asset tag).');
    try {
      const common = { p_vehicle_no: f.vehicle_no?.trim() || null, p_driver_name: f.driver_name?.trim() || null, p_condition_notes: f.condition_notes?.trim() || null, p_remarks: f.remarks?.trim() || null };
      if (['REPAIR_OUT', 'REPAIR_IN', 'SCRAP'].includes(f.direction)) {
        const num = (v) => (v == null || String(v).trim() === '' ? null : Number(v));
        const cost = num(f.service_cost), val = num(f.scrap_value);
        if ((cost != null && !(cost >= 0)) || (val != null && !(val >= 0))) return formErr(form, 'Amounts must be numbers of zero or more.');
        if (f.direction === 'REPAIR_OUT' && (!f.workshop?.trim() || !f.fault_notes?.trim())) return formErr(form, 'Enter the workshop and describe the fault.');
        if (f.direction === 'REPAIR_IN' && cost == null) return formErr(form, 'Enter the service cost (0 if there was no charge).');
        if (f.direction === 'SCRAP') {
          if (!f.scrap_reason?.trim()) return formErr(form, 'Enter the reason for scrapping.');
          if (!f.scrap_confirm) return formErr(form, 'Tick the box to confirm that this equipment will be scrapped.');
        }
        const r = await rpc('issue_service_pass', { p_equipment_id: passEq.id, p_kind: f.direction, p_workshop: f.workshop?.trim() || null, p_fault_notes: f.fault_notes?.trim() || null,
          p_service_cost: f.direction === 'REPAIR_IN' ? cost : null, p_invoice_no: f.invoice_no?.trim() || null,
          p_scrap_reason: f.scrap_reason?.trim() || null, p_scrap_value: f.direction === 'SCRAP' ? val : null, ...common });
        toast(`Gate pass ${r.pass_no} issued`); location.hash = '#/pass/' + r.id; return;
      }
      const r = await rpc('issue_gatepass', { p_equipment_id: passEq.id, p_direction: f.direction, p_vehicle_no: f.vehicle_no?.trim() || null, p_driver_name: f.driver_name?.trim() || null,
        p_condition_notes: f.condition_notes?.trim() || null, p_remarks: f.remarks?.trim() || null, p_expected_return: f.direction === 'IN' ? (f.expected_return || null) : null,
        p_issued_at: can('admin') && f.issued_at ? new Date(f.issued_at).toISOString() : null });
      toast(`Gate pass ${r.pass_no} issued`); location.hash = '#/pass/' + r.id;
    } catch (e) { formErr(form, e.message); }
  },
  user: async (f, form) => {
    try { const r = await q(sb.from('profiles').update({ full_name: f.full_name?.trim() || null, role: f.role || null, active: !!form.querySelector('[name=active]').checked }).eq('id', form.dataset.id).select());
      if (!r.length) throw new Error('Your role is not allowed to do this.'); closeModal(); toast('User saved'); route(); } catch (e) { formErr(form, e.message); }
  },
  'audit-filter': (f) => pageAudit(Object.fromEntries(Object.entries(f).filter(([, v]) => v))),
};
document.addEventListener('submit', async (ev) => {
  const form = ev.target.closest('form[data-form]'); if (!form) return; ev.preventDefault();
  const btn = form.querySelector('button:not([type=button])'); if (btn) btn.disabled = true;
  try { await forms[form.dataset.form](Object.fromEntries(new FormData(form)), form); } catch (e) { fail(e); } finally { if (btn) btn.disabled = false; }
});

/* ---------- Boot ---------- */
sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT' && state.user) { state.user = null; state.profile = null; renderLogin('You have been signed out.'); } });
(async () => {
  try {
    if (await loadProfile()) { if (!location.hash) location.hash = '#/dashboard'; route(); } else renderLogin();
  } catch (e) { renderLogin(); }
})();
})();
