// Upcoming launches from The Space Devs "Launch Library 2" API.
// It is free and CORS-enabled, but the unauthenticated tier is rate limited
// (~15 requests/hour), so we cache results in localStorage and reuse them.
const API_URL = 'https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=15&mode=list';
const CACHE_KEY = 'launches:upcoming';
const CACHE_TTL_MS = 30 * 60 * 1000;

const nextEl = document.getElementById('next');
const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
  } catch {
    // non-fatal
  }
}

async function loadLaunches() {
  const cached = readCache();
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const res = await fetch(API_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const launches = json.results || [];
    writeCache(launches);
    return launches;
  } catch (err) {
    if (cached) return cached.data;
    throw err;
  }
}

function fmtParts(iso) {
  const d = new Date(iso);
  return {
    day: d.toLocaleDateString(undefined, { day: 'numeric' }),
    mon: d.toLocaleDateString(undefined, { month: 'short' }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    full: d.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

let countdownTarget = null;
function tickCountdown() {
  if (!countdownTarget) return;
  const el = document.getElementById('cd');
  if (!el) return;
  let diff = Math.floor((countdownTarget - Date.now()) / 1000);
  if (diff < 0) {
    el.innerHTML = '<div class="num">Liftoff</div>';
    return;
  }
  const d = Math.floor(diff / 86400);
  diff -= d * 86400;
  const h = Math.floor(diff / 3600);
  diff -= h * 3600;
  const m = Math.floor(diff / 60);
  const s = diff - m * 60;
  el.innerHTML = `
    <div class="unit"><div class="num">${d}</div><div class="lbl">Days</div></div>
    <div class="unit"><div class="num">${pad(h)}</div><div class="lbl">Hrs</div></div>
    <div class="unit"><div class="num">${pad(m)}</div><div class="lbl">Min</div></div>
    <div class="unit"><div class="num">${pad(s)}</div><div class="lbl">Sec</div></div>`;
}

function renderNext(launch) {
  const t = fmtParts(launch.net);
  const provider = launch.lsp_name || 'Unknown provider';
  const loc = launch.location || launch.pad || 'Location TBD';
  nextEl.innerHTML = `
    <div class="next-launch">
      <div class="tag">Next launch</div>
      <h2>${launch.name}</h2>
      <div class="sub">${provider} &middot; ${loc}</div>
      <div class="sub" style="margin-top:4px">${t.full}</div>
      <div id="cd" class="countdown"></div>
    </div>`;
  countdownTarget = new Date(launch.net).getTime();
  tickCountdown();
}

function renderList(launches) {
  listEl.innerHTML = launches
    .map((launch) => {
      const t = fmtParts(launch.net);
      const provider = launch.lsp_name || 'Unknown provider';
      const loc = launch.location || launch.pad || 'Location TBD';
      return `
        <div class="launch-card">
          <div class="when">
            <div class="day">${t.day}</div>
            <div class="mon">${t.mon}</div>
            <div class="time">${t.time}</div>
          </div>
          <div class="info">
            <h3>${launch.name}</h3>
            <div class="meta">${provider}<br />${loc}</div>
          </div>
        </div>`;
    })
    .join('');
}

async function init() {
  try {
    const all = await loadLaunches();
    // The "upcoming" feed can include a launch that just happened; keep only
    // ones still in the future so the countdown and list stay accurate.
    const now = Date.now();
    const launches = all
      .filter((l) => new Date(l.net).getTime() > now)
      .sort((a, b) => new Date(a.net) - new Date(b.net));

    if (!launches.length) {
      statusEl.textContent = 'No upcoming launches found right now. Check back soon.';
      return;
    }
    statusEl.style.display = 'none';
    renderNext(launches[0]);
    renderList(launches.slice(1));
    setInterval(tickCountdown, 1000);
  } catch {
    statusEl.textContent =
      'Could not load launch data right now (the free API limits how often we can ask). Please try again in a little while.';
  }
}

init();
