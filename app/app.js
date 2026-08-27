import { AircraftDB } from '../db/lookup.js';
import { LiveryMatcher } from '../src/matcher.js';

const db = new AircraftDB('./db');
const matcher = new LiveryMatcher('./liveries/manifest.json');

// Not fetched directly — airplanes.live 403s automated/proxied clients, and
// the sibling APIs (adsb.lol, adsb.fi) don't send CORS headers of their own
// and block Cloudflare-Worker-proxied traffic. This goes through a Netlify
// Function that fetches adsb.fi server-side and adds the CORS header back;
// see aircraft-scanner-proxy/netlify/functions/point.js for the full story.
const FEED_BASE = 'https://comfy-salmiakki-f8f3bf.netlify.app/.netlify/functions/point';
const RADIUS_NM = 30;
const POLL_INTERVAL_MS = 8000;      // well under any upstream's rate limit
const MISS_TOLERANCE = 2;           // consecutive empty polls before clearing to the idle state
const SWITCH_MARGIN_NM = 0.05;      // hysteresis so near-equidistant aircraft don't ping-pong
const POSITION_KEY = 'aircraft-scanner:position';
const DEFAULT_ACCENT = '#4b5563';   // neutral slate for non-exact tiers

// Material Symbols "flight" glyph — a plain top-down plane, not aircraft-specific art.
const PLACEHOLDER_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2.5 1.5V22l4-1 4 1v-1.5L13 19v-5.5l8 2.5z"/>
</svg>`;

const els = {
  root: document.getElementById('scanner'),
  banner: document.getElementById('scanner-banner'),
  image: document.getElementById('scanner-image'),
  status: document.getElementById('scanner-status'),
  editLocation: document.getElementById('edit-location'),
  dialog: document.getElementById('position-form'),
  inputLat: document.getElementById('input-lat'),
  inputLon: document.getElementById('input-lon'),
  fields: {
    airline: document.getElementById('field-airline'),
    type: document.getElementById('field-type'),
    reg: document.getElementById('field-reg'),
    flight: document.getElementById('field-flight'),
    alt: document.getElementById('field-alt'),
    gs: document.getElementById('field-gs'),
    dst: document.getElementById('field-dst'),
  },
};

const state = { position: null, current: null, missCount: 0, pollTimer: null, pollInFlight: false };

main().catch((err) => {
  els.status.hidden = false;
  els.status.textContent = `Startup failed: ${err.message}`;
});

async function main() {
  await Promise.all([db.preload(), matcher.ready()]);
  state.position = await resolvePosition();
  wireEditLocationButton();
  scheduleNextPoll(0);
}

/* ---------------------------------------------------------------
   Position: geolocation, then a saved manual fallback, then a
   blocking form. The 📍 button lets the user correct it later too.
   --------------------------------------------------------------- */

function loadSavedPosition() {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (!raw) return null;
    const pos = JSON.parse(raw);
    if (Number.isFinite(pos.lat) && Number.isFinite(pos.lon)) return pos;
  } catch { /* ignore malformed storage */ }
  return null;
}

function savePosition(pos) {
  localStorage.setItem(POSITION_KEY, JSON.stringify(pos));
}

function getGeolocation({ timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('geolocation unsupported'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(err),
      { timeout }
    );
  });
}

async function resolvePosition() {
  try {
    const pos = await getGeolocation();
    savePosition(pos);
    return pos;
  } catch {
    const saved = loadSavedPosition();
    if (saved) return saved;
    return waitForManualSubmit();
  }
}

async function waitForManualSubmit(prefill) {
  if (prefill) {
    els.inputLat.value = prefill.lat;
    els.inputLon.value = prefill.lon;
  }
  els.dialog.showModal();
  await new Promise((resolve) => els.dialog.addEventListener('close', resolve, { once: true }));

  const lat = parseFloat(els.inputLat.value);
  const lon = parseFloat(els.inputLon.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return waitForManualSubmit(prefill); // cancelled/empty — the dialog is the only way forward, retry
  }
  const pos = { lat, lon };
  savePosition(pos);
  return pos;
}

function wireEditLocationButton() {
  els.editLocation.addEventListener('click', async () => {
    const pos = await waitForManualSubmit(state.position);
    state.position = pos;
  });
}

/* ---------------------------------------------------------------
   Poll loop
   --------------------------------------------------------------- */

function scheduleNextPoll(delay) {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(pollOnce, delay);
}

async function pollOnce() {
  if (state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    const { lat, lon } = state.position;
    const res = await fetch(`${FEED_BASE}?lat=${lat}&lon=${lon}&radius=${RADIUS_NM}`);
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    const { ac = [] } = await res.json();
    await handleFeed(ac);
    setFeedError(null);
  } catch (err) {
    setFeedError(err);
  } finally {
    state.pollInFlight = false;
    scheduleNextPoll(POLL_INTERVAL_MS);
  }
}

/* ---------------------------------------------------------------
   Closest-aircraft selection, with hysteresis against flicker
   --------------------------------------------------------------- */

async function handleFeed(list) {
  const candidates = list.filter((ac) => ac.hex && Number.isFinite(ac.dst));
  candidates.sort((a, b) => a.dst - b.dst);
  const chosen = pickAircraft(candidates);

  if (!chosen) {
    state.missCount++;
    if (state.missCount >= MISS_TOLERANCE) clearScanner();
    return;
  }
  state.missCount = 0;
  await resolveAndRender(chosen);
}

function pickAircraft(candidates) {
  const closest = candidates[0] || null;
  if (!closest) return null;
  if (!state.current) return closest;

  const stillHere = candidates.find((ac) => ac.hex === state.current.hex);
  if (!stillHere) return closest;                                     // current one left range — switch now
  if (closest.hex === state.current.hex) return closest;               // no change
  if (closest.dst < stillHere.dst - SWITCH_MARGIN_NM) return closest;  // meaningfully closer — steal the slot
  return stillHere;                                                    // otherwise keep showing current plane
}

/* ---------------------------------------------------------------
   Resolve identity + visual, then render
   --------------------------------------------------------------- */

async function resolveAndRender(ac) {
  const isSameAircraft = state.current?.hex === ac.hex;

  let typeCode = ac.t || '';
  let registration = (ac.r || '').trim();
  let typeName = ac.desc || '';

  if (!typeCode || !registration) {
    const frame = await db.lookupHex(ac.hex);
    if (frame) {
      typeCode = typeCode || frame.typeCode || '';
      registration = registration || frame.registration || '';
      typeName = typeName || frame.typeName || '';
    }
  }

  const flight = (ac.flight || '').trim();
  const airline = db.lookupAirlineFromCallsign(flight);
  const { tier, entry } = matcher.match({ t: typeCode, flight });

  const record = {
    hex: ac.hex, flight, typeCode, typeName, registration,
    airlineName: airline?.name ?? null,
    alt: ac.alt_baro, dst: ac.dst, gs: ac.gs,
    tier,
    entry: tier === 'exact' ? entry : null,
    accent: tier === 'exact' ? entry.accent : DEFAULT_ACCENT,
  };

  render(record, { isSameAircraft });
  state.current = record;
}

function render(record, { isSameAircraft }) {
  if (!isSameAircraft) {
    setImage(record);
    document.documentElement.style.setProperty('--accent', record.accent);
    els.root.classList.remove('is-entering');
    void els.root.offsetWidth; // force reflow so the entrance animation restarts
    els.root.classList.add('is-entering');
  }

  els.fields.airline.textContent = record.airlineName || 'Unknown operator';
  els.fields.type.textContent = record.typeName || record.typeCode || 'Unknown type';
  els.fields.reg.textContent = record.registration || '—';
  els.fields.flight.textContent = record.flight || '—';
  els.fields.alt.textContent = record.alt === 'ground'
    ? 'On ground'
    : Number.isFinite(record.alt) ? `${Math.round(record.alt).toLocaleString()} ft` : '—';
  els.fields.gs.textContent = Number.isFinite(record.gs) ? `${Math.round(record.gs)} kt` : '—';
  els.fields.dst.textContent = Number.isFinite(record.dst) ? `${record.dst.toFixed(1)} nm` : '—';

  els.root.classList.remove('is-empty');
  els.status.hidden = true;
}

function setImage(record) {
  if (record.tier === 'exact') {
    els.image.classList.remove('is-placeholder');
    els.image.innerHTML = '';
    els.image.style.backgroundImage = `url("./liveries/${encodeURIComponent(record.entry.file)}")`;
  } else {
    els.image.classList.add('is-placeholder');
    els.image.style.backgroundImage = '';
    els.image.innerHTML = PLACEHOLDER_SVG;
  }
}

function clearScanner() {
  state.current = null;
  els.root.classList.add('is-empty');
  els.image.classList.add('is-placeholder');
  els.image.style.backgroundImage = '';
  els.image.innerHTML = PLACEHOLDER_SVG;
  els.status.hidden = false;
  els.status.textContent = `No aircraft within ${RADIUS_NM} nm right now.`;
}

function setFeedError(err) {
  els.banner.hidden = !err;
  if (err) els.banner.textContent = 'Live feed unavailable — retrying…';
}
