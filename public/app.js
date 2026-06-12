'use strict';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const DEFAULTS = { speed: 1, delay: 3, bounce: 15, bounceMode: 'natural', size: 27, rows: 2, border: 2, panSpeed: 1, small: 20 };
const BOUNCE_MODES = ['natural', 'gravity', 'elastic', 'none'];
const LS_KEY = 'shiftingtiles.settings.v1';

const stage = document.getElementById('stage');
const overlay = document.getElementById('overlay');
const overlayMsg = overlay.querySelector('.msg');
const gear = document.getElementById('gear');
const dialog = document.getElementById('settings');

let settings = sanitize({ ...DEFAULTS, ...readSaved() });
let timer = null;
let idleTimer = null;
let rebuildTimer = null;

function readSaved() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}
function sanitize(s) {
  const clamp = (v, lo, hi, dflt) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : dflt);
  return {
    speed: clamp(s.speed, 0.25, 3, DEFAULTS.speed),
    delay: clamp(s.delay, 1, 30, DEFAULTS.delay),
    bounce: clamp(s.bounce, 0, 40, DEFAULTS.bounce),
    bounceMode: BOUNCE_MODES.includes(s.bounceMode) ? s.bounceMode : DEFAULTS.bounceMode,
    size: clamp(s.size, 12, 70, DEFAULTS.size),
    rows: Math.round(clamp(s.rows, 2, 4, DEFAULTS.rows)),
    border: Math.round(clamp(s.border, 0, 30, DEFAULTS.border)),
    panSpeed: clamp(s.panSpeed, 0, 3, DEFAULTS.panSpeed),
    small: Math.round(clamp(s.small, 0, 100, DEFAULTS.small)),
  };
}

function applySettings() {
  const css = document.documentElement.style;
  css.setProperty('--speed', settings.speed);
  css.setProperty('--bounce-size', `${settings.bounce}px`);
  css.setProperty('--tile-w', `${settings.size}vw`);
  css.setProperty('--rows', settings.rows);
  css.setProperty('--gap', `${settings.border}px`);
  document.body.dataset.bounce = settings.bounceMode;
  alignGrid();
  retunePanos();
  restartTimer();
  syncDialog();
}

// Re-derive pan bounds/duration for panoramas already on screen so the
// pan-speed slider (and size/rows changes) take effect without a rebuild.
function retunePanos() {
  for (const tile of stage.querySelectorAll('.tile.pano')) {
    const m = pool.get(tile.dataset.imgId);
    if (m) configurePan(tile, m);
  }
}

// LTR rows pack from x=0, RTL rows from the right edge of the viewport, and
// tile widths are all full- or half-tile. Padding the RTL anchor out to the
// next quarter-tile grid line puts every seam in every row on one shared
// grid, so images across rows align at half/quarter-width offsets.
function alignGrid() {
  const quarter = (settings.size / 400) * window.innerWidth;
  const pad = quarter ? (quarter - (window.innerWidth % quarter)) % quarter : 0;
  document.documentElement.style.setProperty('--rtl-pad', `${pad.toFixed(2)}px`);
}

const intervalMs = () => settings.delay * 1000;
const durationMs = () => 1000 / settings.speed;

// ---------------------------------------------------------------------------
// Image pool — fed by the server, dealt out like a shuffled deck so every
// photo appears before any repeats.
// ---------------------------------------------------------------------------
const pool = new Map(); // id -> metadata
let deck = [];

async function fetchImages() {
  const res = await fetch('/api/images');
  if (!res.ok) throw new Error(`images: HTTP ${res.status}`);
  const list = await res.json();
  const seen = new Set();
  let added = 0;
  for (const m of list) {
    seen.add(m.id);
    if (!pool.has(m.id)) {
      deck.push(m.id);
      added++;
    }
    pool.set(m.id, m);
  }
  for (const id of [...pool.keys()]) {
    if (!seen.has(id)) pool.delete(id);
  }
  if (added) shuffle(deck);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function drawImage({ noPano = false } = {}) {
  if (!pool.size) return null;
  for (let tries = deck.length + 1; tries > 0; tries--) {
    if (!deck.length) {
      deck = [...pool.keys()];
      shuffle(deck);
    }
    const m = pool.get(deck.pop());
    if (!m) continue;
    if (noPano && m.panorama) {
      deck.unshift(m.id); // back of the deck; try another
      continue;
    }
    return m;
  }
  const all = [...pool.values()];
  return all[(Math.random() * all.length) | 0];
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------
function setImage(el, m) {
  el.style.backgroundImage = `url("${m.url}")`;
  // Percentage background-position aligns the focal point of the image with
  // the same point of the tile — exactly what "keep faces visible" needs.
  el.style.backgroundPosition = `${m.focusX}% ${m.focusY}%`;
}

function makeTile() {
  const tile = document.createElement('div');
  tile.className = 'tile';
  const dual = pool.size > 3 && Math.random() * 100 < settings.small;
  if (dual) {
    tile.classList.add('dual');
    for (let i = 0; i < 2; i++) {
      const half = document.createElement('div');
      half.className = 'half';
      const m = drawImage({ noPano: true });
      if (m) setImage(half, m);
      tile.append(half);
    }
  } else {
    tile.classList.add('single');
    const m = drawImage();
    if (m) {
      if (m.panorama && m.width > m.height) { // wide images only, defensively
        // The pan runs on an inner element so the tile's own animation slot
        // stays free for bounce/disappear — sharing it corrupts both.
        tile.classList.add('pano');
        tile.dataset.imgId = m.id; // lets retunePanos re-derive the pan later
        const pan = document.createElement('div');
        pan.className = 'pan';
        setImage(pan, m);
        tile.append(pan);
        configurePan(tile, m);
      } else {
        setImage(tile, m);
      }
    }
  }
  return tile;
}

const PANO_MAX_ASPECT = 1.6; // displayed panorama content is clamped to 16:10

// Limit a panorama to a 16:10 window around its focal point: the pan sweeps
// only that window, never the image's full (possibly enormous) width.
function configurePan(tile, m) {
  const aspect = m.width / m.height;
  const tileAspect =
    ((settings.size / 100) * window.innerWidth) / (window.innerHeight / settings.rows);
  const shown = Math.min(aspect, PANO_MAX_ASPECT);
  // Pan speed zero disables panning; a tile at least as wide as the clamped
  // window leaves no room to pan. Either way: a plain focal-point crop.
  const canPan = settings.panSpeed > 0 && shown > tileAspect && aspect > tileAspect;
  tile.classList.toggle('static', !canPan);
  if (!canPan) return;
  // Widths below are in tile-height units. background-position-x at p%
  // aligns the p% point of the image with the p% point of the tile.
  let from = 0;
  let to = 100;
  if (aspect > shown) {
    const start = Math.min(
      Math.max((m.focusX / 100) * aspect - shown / 2, 0),
      aspect - shown,
    );
    from = (start / (aspect - tileAspect)) * 100;
    to = ((start + shown - tileAspect) / (aspect - tileAspect)) * 100;
  }
  const dur = Math.min(90, Math.max(8, ((shown - tileAspect) * 18) / settings.panSpeed));
  tile.style.setProperty('--pan-from', `${from.toFixed(2)}%`);
  tile.style.setProperty('--pan-to', `${to.toFixed(2)}%`);
  tile.style.setProperty('--pan-dur', `${dur.toFixed(1)}s`);
}

function rowWidth(row) {
  let w = 0;
  for (const t of row.children) {
    if (!t.classList.contains('disappear')) w += t.offsetWidth;
  }
  return w;
}

// Keep enough tiles that spares wait off-screen, ready to slide in.
function fillRow(row) {
  const target = window.innerWidth * 1.6;
  let guard = 60;
  while (rowWidth(row) < target && guard-- > 0) row.append(makeTile());
}

function buildStage() {
  stage.textContent = '';
  if (!pool.size) return;
  for (let r = 0; r < settings.rows; r++) {
    const row = document.createElement('div');
    row.className = r % 2 ? 'row rtl' : 'row';
    stage.append(row);
    fillRow(row);
  }
}

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------
function tick() {
  const rows = [...stage.children];
  if (!rows.length) return;
  const row = rows[(Math.random() * rows.length) | 0];
  const candidates = [...row.children].filter(
    (t) => !t.classList.contains('disappear') && isVisible(t),
  );
  if (!candidates.length) return;
  vanish(row, candidates[(Math.random() * candidates.length) | 0]);
}

function isVisible(t) {
  const r = t.getBoundingClientRect();
  return r.width > 0 && r.right > 1 && r.left < window.innerWidth - 1;
}

function vanish(row, tile) {
  let sib = tile.nextElementSibling;
  for (let i = 1; sib && i <= 3; sib = sib.nextElementSibling) {
    if (sib.classList.contains('disappear')) continue; // don't hijack its exit
    bounce(sib, `bounce-${i}`);
    i++;
  }
  // A leftover bounce class would out-cascade the disappear animation.
  tile.classList.remove('bounce-1', 'bounce-2', 'bounce-3');
  tile.classList.add('disappear');

  const ttl = setTimeout(remove, durationMs() * 2.5); // safety net
  tile.addEventListener('animationend', (e) => {
    if (e.animationName === 'disappear') remove();
  });
  function remove() {
    clearTimeout(ttl);
    if (!tile.isConnected) return;
    tile.remove();
    fillRow(row);
  }

  fillRow(row); // append the replacement now so it slides in behind
}

function bounce(el, cls) {
  el.classList.remove('bounce-1', 'bounce-2', 'bounce-3');
  void el.offsetWidth; // restart the animation if one just ran
  el.classList.add(cls);
  el.addEventListener(
    'animationend',
    function done(e) {
      if (!e.animationName.startsWith('bounce')) return; // ignore bubbled ends
      el.classList.remove(cls);
      el.removeEventListener('animationend', done);
    },
  );
}

function restartTimer() {
  clearInterval(timer);
  timer = setInterval(tick, intervalMs());
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearInterval(timer);
  else restartTimer();
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    alignGrid();
    stage.querySelectorAll('.row').forEach(fillRow);
  }, 250);
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !dialog.open) {
    tick();
    e.preventDefault();
  }
});

// ---------------------------------------------------------------------------
// Idle cursor + gear + settings dialog
// ---------------------------------------------------------------------------
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!dialog.open) document.body.classList.add('idle');
  }, 3000);
}
for (const ev of ['mousemove', 'pointerdown', 'keydown']) {
  window.addEventListener(ev, wake, { passive: true });
}

gear.addEventListener('click', () => {
  syncDialog();
  dialog.showModal();
});
dialog.addEventListener('close', wake);

const inputs = {
  speed: document.getElementById('set-speed'),
  delay: document.getElementById('set-delay'),
  bounce: document.getElementById('set-bounce'),
  bounceMode: document.getElementById('set-bounce-mode'),
  size: document.getElementById('set-size'),
  rows: document.getElementById('set-rows'),
  border: document.getElementById('set-border'),
  panSpeed: document.getElementById('set-pan-speed'),
  small: document.getElementById('set-small'),
};
const outputs = {
  speed: document.getElementById('out-speed'),
  delay: document.getElementById('out-delay'),
  bounce: document.getElementById('out-bounce'),
  size: document.getElementById('out-size'),
  rows: document.getElementById('out-rows'),
  border: document.getElementById('out-border'),
  panSpeed: document.getElementById('out-pan-speed'),
  small: document.getElementById('out-small'),
};

function syncDialog() {
  inputs.speed.value = settings.speed;
  inputs.delay.value = settings.delay;
  inputs.bounce.value = settings.bounce;
  inputs.bounceMode.value = settings.bounceMode;
  inputs.size.value = settings.size;
  inputs.rows.value = settings.rows;
  inputs.border.value = settings.border;
  inputs.panSpeed.value = settings.panSpeed;
  inputs.small.value = settings.small;
  outputs.speed.textContent = `${settings.speed.toFixed(2)}×`;
  outputs.delay.textContent = `${settings.delay.toFixed(1)} s`;
  outputs.bounce.textContent = `${settings.bounce} px`;
  outputs.size.textContent = `${settings.size} vw`;
  outputs.rows.textContent = String(settings.rows);
  outputs.border.textContent = settings.border ? `${settings.border} px` : 'none';
  outputs.panSpeed.textContent = settings.panSpeed ? `${settings.panSpeed.toFixed(2)}×` : 'off';
  outputs.small.textContent = `${settings.small} %`;
}

function onChange(key, value, { rebuild = false } = {}) {
  settings = sanitize({ ...settings, [key]: value });
  save();
  applySettings();
  if (rebuild) {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(buildStage, 300);
  }
}

inputs.speed.addEventListener('input', (e) => onChange('speed', e.target.value));
inputs.delay.addEventListener('input', (e) => onChange('delay', e.target.value));
inputs.bounce.addEventListener('input', (e) => onChange('bounce', e.target.value));
inputs.bounceMode.addEventListener('change', (e) => onChange('bounceMode', e.target.value));
inputs.size.addEventListener('input', (e) => onChange('size', e.target.value, { rebuild: true }));
inputs.rows.addEventListener('input', (e) => onChange('rows', e.target.value, { rebuild: true }));
inputs.border.addEventListener('input', (e) => onChange('border', e.target.value));
inputs.panSpeed.addEventListener('input', (e) => onChange('panSpeed', e.target.value));
inputs.small.addEventListener('input', (e) => onChange('small', e.target.value, { rebuild: true }));
document.getElementById('set-reset').addEventListener('click', () => {
  settings = { ...DEFAULTS };
  save();
  applySettings();
  buildStage();
});

// ---------------------------------------------------------------------------
// Startup: wait for the server to have processed photos, then run.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start() {
  applySettings();
  for (;;) {
    try { await fetchImages(); } catch { /* server still starting */ }
    if (pool.size) break;
    try {
      const st = await (await fetch('/api/status')).json();
      overlayMsg.textContent = st.total
        ? `Processing photos… ${st.processed}/${st.total}`
        : 'Waiting for photos…';
    } catch {
      overlayMsg.textContent = 'Waiting for server…';
    }
    await sleep(2500);
  }
  buildStage();
  overlay.classList.add('hidden');
  restartTimer();
  wake();
  // Keep learning about newly added photos.
  setInterval(() => fetchImages().catch(() => {}), 60_000);
}

start();
