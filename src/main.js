import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  GROUPS,
  fetchGroup,
  fetchByCatnr,
  parseTle,
  SatelliteGroup,
  gmstFor,
  orbitalElements,
  satelliteState,
  eciToScene,
  geodeticToScene,
  groundTrack,
  predictPasses,
  EARTH_RADIUS_UNITS,
  EARTH_RADIUS_KM,
} from './satellites.js';

const EARTH_TEXTURE =
  'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/earth_atmos_2048.jpg';
const EARTH_SPECULAR =
  'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/earth_specular_2048.jpg';

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
camera.position.set(0, 1.6, 4.2);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 1.4;
controls.maxDistance = 30;
controls.rotateSpeed = 0.5;

// --- Lighting -------------------------------------------------------------
scene.add(new THREE.AmbientLight(0x668, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(5, 2, 4);
scene.add(sun);

// --- Starfield ------------------------------------------------------------
function makeStars() {
  const count = 4000;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 120 + Math.random() * 80;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.4, sizeAttenuation: true });
  scene.add(new THREE.Points(geo, mat));
}
makeStars();

// --- Earth ----------------------------------------------------------------
const earth = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_RADIUS_UNITS, 96, 96),
  new THREE.MeshPhongMaterial({ color: 0x223344, shininess: 12 })
);
scene.add(earth);

const loader = new THREE.TextureLoader();
loader.setCrossOrigin('anonymous');
loader.load(EARTH_TEXTURE, (tex) => {
  tex.colorSpace = THREE.SRGBColorSpace;
  earth.material.map = tex;
  earth.material.color.set(0xffffff);
  earth.material.needsUpdate = true;
});
loader.load(EARTH_SPECULAR, (tex) => {
  earth.material.specularMap = tex;
  earth.material.specular = new THREE.Color(0x335577);
  earth.material.needsUpdate = true;
});

// Atmosphere glow (additive back-facing shell).
const atmosphere = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_RADIUS_UNITS * 1.025, 96, 96),
  new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    uniforms: { glowColor: { value: new THREE.Color(0x3a7bd5) } },
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vNormal;
      uniform vec3 glowColor;
      void main() {
        float intensity = pow(0.62 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.0);
        gl_FragColor = vec4(glowColor, 1.0) * intensity;
      }`,
  })
);
scene.add(atmosphere);

// --- Satellite groups -----------------------------------------------------
const loadedGroups = [];
const searchIndex = []; // { name, noradId, group, idx } for every loaded sat
const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.025;
const pointer = new THREE.Vector2();
let hasPointer = false;

const loadingEl = document.getElementById('loading');
const groupsEl = document.getElementById('groups');
const countsEl = document.getElementById('counts');
const tooltipEl = document.getElementById('tooltip');
const clockEl = document.getElementById('clock');
const searchEl = document.getElementById('search');
const searchResultsEl = document.getElementById('search-results');
const detailEl = document.getElementById('detail');
const detailBodyEl = document.getElementById('detail-body');

// --- Selection / highlight marker -----------------------------------------
function makeRingTexture() {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - 12, 0, Math.PI * 2);
  ctx.stroke();
  return new THREE.CanvasTexture(c);
}

const marker = new THREE.Sprite(
  new THREE.SpriteMaterial({
    map: makeRingTexture(),
    color: 0xffffff,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
);
marker.scale.setScalar(0.13);
marker.visible = false;
marker.renderOrder = 5;
scene.add(marker);

let selected = null; // { group, idx }
let follow = false;
let showTrack = true;
let detailCells = null;
let lastDetailUpdate = 0;
let lastTrackBuild = 0;

// Ground track (one orbit, Earth-fixed) and coverage footprint. Both are
// parented to the Earth mesh so they rotate with it.
const TRACK_RADIUS = EARTH_RADIUS_UNITS * 1.004;
const trackLine = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 })
);
trackLine.frustumCulled = false;
trackLine.visible = false;
earth.add(trackLine);

const footprintLine = new THREE.LineLoop(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })
);
footprintLine.frustumCulled = false;
footprintLine.visible = false;
earth.add(footprintLine);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// Observer location for pass predictions, remembered across sessions.
function loadObserver() {
  try {
    const raw = localStorage.getItem('observer');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
let observer = loadObserver(); // { latDeg, lonDeg }

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function azToCompass(deg) {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

function fmtPassTime(date) {
  return date.toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function loadAll() {
  const results = await Promise.allSettled(
    GROUPS.map(async (g) => {
      const sats = await fetchGroup(g.id);
      return new SatelliteGroup(g, sats);
    })
  );

  results.forEach((res, i) => {
    const meta = GROUPS[i];
    if (res.status === 'fulfilled' && res.value.count > 0) {
      const group = res.value;
      group.meta = meta;
      scene.add(group.points);
      loadedGroups.push(group);
      indexGroup(group);
      addGroupRow(meta, group);
    } else {
      addGroupRow(meta, null);
    }
  });

  loadingEl.style.display = 'none';
  updateCounts();
}

// Add every satellite in a group to the global search index.
function indexGroup(group) {
  group.sats.forEach((s, idx) => {
    searchIndex.push({
      name: s.name,
      noradId: String(s.satrec.satnum),
      group,
      idx,
    });
  });
}

function addGroupRow(meta, group) {
  const row = document.createElement('label');
  row.className = 'group-row';
  const enabled = !!group;

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = enabled;
  checkbox.disabled = !enabled;
  checkbox.addEventListener('change', () => {
    if (group) group.setVisible(checkbox.checked);
    updateCounts();
  });
  if (group) group.checkbox = checkbox;

  const swatch = document.createElement('span');
  swatch.className = 'group-swatch';
  swatch.style.background = '#' + meta.color.toString(16).padStart(6, '0');

  const label = document.createElement('span');
  label.textContent = meta.label;

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = group ? group.count : '—';

  row.append(checkbox, swatch, label, count);
  groupsEl.appendChild(row);
}

function updateCounts() {
  const total = loadedGroups
    .filter((g) => g.visible)
    .reduce((sum, g) => sum + g.count, 0);
  countsEl.textContent = `Tracking ${total.toLocaleString()} satellites`;
}

// --- Selection + detail panel ---------------------------------------------
function selectSatellite(group, idx) {
  selected = { group, idx };
  follow = true;

  // Make sure the satellite's group is actually visible.
  if (!group.visible) {
    group.setVisible(true);
    if (group.checkbox) group.checkbox.checked = true;
    updateCounts();
  }

  showDetail(group, idx);
  marker.visible = true;
  buildGroundTrack();
  lastTrackBuild = performance.now();
  trackLine.visible = showTrack;
  footprintLine.visible = showTrack;
  frameSelection();
}

function deselect() {
  selected = null;
  follow = false;
  marker.visible = false;
  trackLine.visible = false;
  footprintLine.visible = false;
  detailCells = null;
  detailEl.hidden = true;
}

function showDetail(group, idx) {
  const sat = group.sats[idx];
  const els = orbitalElements(sat.satrec);
  const groupLabel = group.meta ? group.meta.label : 'Satellite';

  detailBodyEl.innerHTML = `
    <div class="d-name">${escapeHtml(sat.name)}</div>
    <div class="d-sub">NORAD ${escapeHtml(els.noradId)} &middot; ${escapeHtml(groupLabel)}</div>
    <label class="d-follow">
      <input type="checkbox" id="follow-toggle" ${follow ? 'checked' : ''}/>
      Follow with camera
    </label>
    <label class="d-follow">
      <input type="checkbox" id="track-toggle" ${showTrack ? 'checked' : ''}/>
      Show ground track &amp; coverage
    </label>
    <div class="d-grid">
      <div class="cell"><span class="k">Altitude</span><span class="v" data-f="alt">&mdash;</span></div>
      <div class="cell"><span class="k">Speed</span><span class="v" data-f="vel">&mdash;</span></div>
      <div class="cell"><span class="k">Latitude</span><span class="v" data-f="lat">&mdash;</span></div>
      <div class="cell"><span class="k">Longitude</span><span class="v" data-f="lon">&mdash;</span></div>
      <div class="cell"><span class="k">Inclination</span><span class="v">${els.inclinationDeg.toFixed(1)}&deg;</span></div>
      <div class="cell"><span class="k">Period</span><span class="v">${els.periodMin.toFixed(1)} min</span></div>
      <div class="cell"><span class="k">Apogee</span><span class="v">${Math.round(els.apogeeKm).toLocaleString()} km</span></div>
      <div class="cell"><span class="k">Perigee</span><span class="v">${Math.round(els.perigeeKm).toLocaleString()} km</span></div>
    </div>
    <div class="d-export">
      <span class="dp-head">Export one orbit</span>
      <div class="d-export-btns">
        <button id="exp-csv" type="button">CSV</button>
        <button id="exp-json" type="button">JSON</button>
      </div>
    </div>
    <div class="d-passes">
      <div class="dp-head">Visible passes over a location</div>
      <div class="dp-form">
        <input id="obs-lat" type="number" step="0.0001" placeholder="Latitude"
          value="${observer ? observer.latDeg : ''}" />
        <input id="obs-lon" type="number" step="0.0001" placeholder="Longitude"
          value="${observer ? observer.lonDeg : ''}" />
      </div>
      <div class="dp-actions">
        <button id="obs-geo" type="button">My location</button>
        <button id="passes-go" type="button" class="primary">Find passes</button>
      </div>
      <div id="passes-out" class="dp-out"></div>
    </div>`;

  detailCells = {
    alt: detailBodyEl.querySelector('[data-f="alt"]'),
    vel: detailBodyEl.querySelector('[data-f="vel"]'),
    lat: detailBodyEl.querySelector('[data-f="lat"]'),
    lon: detailBodyEl.querySelector('[data-f="lon"]'),
  };
  detailBodyEl.querySelector('#follow-toggle').addEventListener('change', (e) => {
    follow = e.target.checked;
  });
  detailBodyEl.querySelector('#track-toggle').addEventListener('change', (e) => {
    showTrack = e.target.checked;
    trackLine.visible = showTrack;
    footprintLine.visible = showTrack;
    if (showTrack) buildGroundTrack();
  });

  detailBodyEl.querySelector('#exp-csv').addEventListener('click', () => exportSelection('csv'));
  detailBodyEl.querySelector('#exp-json').addEventListener('click', () => exportSelection('json'));

  const latEl = detailBodyEl.querySelector('#obs-lat');
  const lonEl = detailBodyEl.querySelector('#obs-lon');
  const passesOut = detailBodyEl.querySelector('#passes-out');

  detailBodyEl.querySelector('#obs-geo').addEventListener('click', () => {
    if (!navigator.geolocation) {
      passesOut.innerHTML = '<div class="dp-empty">Geolocation not available.</div>';
      return;
    }
    passesOut.innerHTML = '<div class="dp-empty">Locating&hellip;</div>';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        latEl.value = pos.coords.latitude.toFixed(4);
        lonEl.value = pos.coords.longitude.toFixed(4);
        passesOut.innerHTML = '';
        computePasses(latEl, lonEl, passesOut);
      },
      () => {
        passesOut.innerHTML = '<div class="dp-empty">Could not get your location.</div>';
      }
    );
  });

  detailBodyEl.querySelector('#passes-go').addEventListener('click', () => {
    computePasses(latEl, lonEl, passesOut);
  });

  detailEl.hidden = false;
}

// Compute and render the next visible passes of the selected satellite over
// the observer's location.
function computePasses(latEl, lonEl, out) {
  if (!selected) return;
  const latDeg = parseFloat(latEl.value);
  const lonDeg = parseFloat(lonEl.value);
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || Math.abs(latDeg) > 90 || Math.abs(lonDeg) > 180) {
    out.innerHTML = '<div class="dp-empty">Enter a valid latitude and longitude.</div>';
    return;
  }

  observer = { latDeg, lonDeg };
  try {
    localStorage.setItem('observer', JSON.stringify(observer));
  } catch {
    // ignore storage errors
  }

  out.innerHTML = '<div class="dp-empty">Calculating&hellip;</div>';
  // Defer so the "Calculating" message can paint before the heavy loop.
  setTimeout(() => {
    const satrec = selected.group.sats[selected.idx].satrec;
    const passes = predictPasses(
      satrec,
      { latDeg, lonDeg, heightKm: 0 },
      new Date(),
      { hours: 48, stepSec: 30, minElevationDeg: 10 }
    );
    if (!passes.length) {
      out.innerHTML = '<div class="dp-empty">No passes above 10° in the next 48 hours.</div>';
      return;
    }
    out.innerHTML = passes
      .slice(0, 8)
      .map((p) => {
        const durSec = Math.round((p.end - p.start) / 1000);
        const mm = Math.floor(durSec / 60);
        const ss = String(durSec % 60).padStart(2, '0');
        return `<div class="pass">
          <span class="pass-when">${escapeHtml(fmtPassTime(p.start))}</span>
          <span class="pass-meta">max ${Math.round(p.peakElDeg)}° ${azToCompass(
            p.peakAzDeg
          )} &middot; ${mm}m ${ss}s</span>
        </div>`;
      })
      .join('');
  }, 20);
}

// Rebuild the one-orbit ground-track polyline for the selected satellite,
// in Earth-fixed scene coordinates (the line is a child of the Earth mesh).
function buildGroundTrack() {
  if (!selected) return;
  const satrec = selected.group.sats[selected.idx].satrec;
  const pts = groundTrack(satrec, simTime, { orbits: 1, samples: 240 });
  const arr = new Float32Array(pts.length * 3);
  for (let i = 0; i < pts.length; i++) {
    const [x, y, z] = geodeticToScene(pts[i].latDeg, pts[i].lonDeg, TRACK_RADIUS);
    arr[i * 3] = x;
    arr[i * 3 + 1] = y;
    arr[i * 3 + 2] = z;
  }
  trackLine.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  trackLine.geometry.computeBoundingSphere();
  const color = selected.group.meta ? selected.group.meta.color : 0xffffff;
  trackLine.material.color.setHex(color);
  footprintLine.material.color.setHex(color);
}

// Recompute the coverage footprint: the circle on the surface from which the
// satellite is above the horizon, centered on the current sub-satellite point.
const FOOT_SEGMENTS = 96;
const footArr = new Float32Array(FOOT_SEGMENTS * 3);
function updateFootprint(st) {
  const cosA = EARTH_RADIUS_KM / (EARTH_RADIUS_KM + st.altitudeKm);
  const alpha = Math.acos(Math.min(1, Math.max(-1, cosA))); // central angle to horizon
  const [cx, cy, cz] = geodeticToScene(st.latDeg, st.lonDeg, 1);
  const center = new THREE.Vector3(cx, cy, cz);
  const ref = Math.abs(center.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(center, ref).normalize();
  const v = new THREE.Vector3().crossVectors(center, u).normalize();
  const ca = Math.cos(alpha);
  const sa = Math.sin(alpha);
  for (let i = 0; i < FOOT_SEGMENTS; i++) {
    const th = (i / FOOT_SEGMENTS) * Math.PI * 2;
    const k1 = sa * Math.cos(th);
    const k2 = sa * Math.sin(th);
    const x = (center.x * ca + u.x * k1 + v.x * k2) * TRACK_RADIUS;
    const y = (center.y * ca + u.y * k1 + v.y * k2) * TRACK_RADIUS;
    const z = (center.z * ca + u.z * k1 + v.z * k2) * TRACK_RADIUS;
    footArr[i * 3] = x;
    footArr[i * 3 + 1] = y;
    footArr[i * 3 + 2] = z;
  }
  const attr = footprintLine.geometry.getAttribute('position');
  if (!attr || attr.array.length !== footArr.length) {
    footprintLine.geometry.setAttribute('position', new THREE.BufferAttribute(footArr, 3));
  } else {
    attr.array.set(footArr);
    attr.needsUpdate = true;
  }
}

// Center the camera on the selected satellite and dolly to a close framing.
function frameSelection() {
  if (!selected) return;
  const st = satelliteState(selected.group.sats[selected.idx].satrec, simTime);
  if (!st) return;
  const [x, y, z] = eciToScene(st.positionEci);
  const target = new THREE.Vector3(x, y, z);
  // View the satellite from outside, looking back toward Earth, so the planet
  // is always the backdrop and the satellite stays framed against it.
  const outward = target.clone().normalize();
  if (!Number.isFinite(outward.x) || outward.lengthSq() < 1e-6) outward.set(0, 0, 1);
  controls.target.copy(target);
  camera.position.copy(target).add(outward.multiplyScalar(1.6));
}

// Per-frame: track the selected satellite, follow with the camera, refresh
// the live readouts (throttled).
function updateSelection(gmst) {
  if (!selected) return;
  const st = satelliteState(selected.group.sats[selected.idx].satrec, simTime, gmst);
  if (!st) return;

  const [x, y, z] = eciToScene(st.positionEci);
  if (follow) {
    const delta = new THREE.Vector3(x, y, z).sub(marker.position);
    controls.target.add(delta);
    camera.position.add(delta);
  }
  marker.position.set(x, y, z);

  const nowMs = performance.now();
  if (showTrack) {
    updateFootprint(st);
    // Rebuild the ground track occasionally so it stays current as the orbit
    // and Earth rotation shift it (cheap enough twice a second).
    if (nowMs - lastTrackBuild > 500) {
      lastTrackBuild = nowMs;
      buildGroundTrack();
    }
  }
  if (detailCells && nowMs - lastDetailUpdate > 180) {
    lastDetailUpdate = nowMs;
    detailCells.alt.textContent = `${Math.round(st.altitudeKm).toLocaleString()} km`;
    detailCells.vel.textContent = `${st.speedKmS.toFixed(2)} km/s`;
    detailCells.lat.textContent = `${st.latDeg.toFixed(2)}°`;
    detailCells.lon.textContent = `${st.lonDeg.toFixed(2)}°`;
  }
}

// --- Export ---------------------------------------------------------------
function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Export one orbit of the selected satellite (sampled from real "now") as CSV
// or JSON. JSON also carries the derived orbital elements.
function exportSelection(format) {
  if (!selected) return;
  const sat = selected.group.sats[selected.idx];
  const els = orbitalElements(sat.satrec);
  const now = new Date();
  const spanMs = els.periodMin * 60 * 1000;
  const N = 120;
  const samples = [];
  for (let k = 0; k <= N; k++) {
    const t = new Date(now.getTime() + (spanMs * k) / N);
    const s = satelliteState(sat.satrec, t);
    if (s) {
      samples.push({
        timeUtc: t.toISOString(),
        latDeg: s.latDeg,
        lonDeg: s.lonDeg,
        altitudeKm: s.altitudeKm,
        speedKmS: s.speedKmS,
      });
    }
  }
  const base = (sat.name || 'satellite').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '');

  if (format === 'json') {
    const payload = {
      name: sat.name,
      noradId: els.noradId,
      group: selected.group.meta ? selected.group.meta.label : null,
      generatedAt: now.toISOString(),
      elements: els,
      groundTrack: samples,
    };
    download(`${base}_${els.noradId}.json`, JSON.stringify(payload, null, 2), 'application/json');
  } else {
    const rows = [['time_utc', 'lat_deg', 'lon_deg', 'alt_km', 'speed_km_s']];
    for (const s of samples) {
      rows.push([
        s.timeUtc,
        s.latDeg.toFixed(4),
        s.lonDeg.toFixed(4),
        s.altitudeKm.toFixed(2),
        s.speedKmS.toFixed(4),
      ]);
    }
    download(`${base}_${els.noradId}.csv`, rows.map((r) => r.join(',')).join('\n'), 'text/csv');
  }
}

// --- Custom satellites ----------------------------------------------------
let customCount = 0;
const CUSTOM_COLORS = [0xff5fa8, 0x5fffd0, 0xffd45f, 0xb98bff];

// Add a freshly parsed set of sats as a new selectable group, then select the
// first one so the user immediately sees it.
function addCustomGroup(sats, label) {
  if (!sats.length) return null;
  customCount += 1;
  const meta = {
    id: `custom-${customCount}`,
    label: label || `Custom ${customCount}`,
    color: CUSTOM_COLORS[(customCount - 1) % CUSTOM_COLORS.length],
    size: 0.05,
  };
  const group = new SatelliteGroup(meta, sats);
  group.meta = meta;
  scene.add(group.points);
  loadedGroups.push(group);
  indexGroup(group);
  addGroupRow(meta, group);
  updateCounts();
  // Prime positions so it is immediately pickable/selectable.
  group.update(simTime);
  selectSatellite(group, 0);
  return group;
}

function setupCustomControls() {
  const catnrEl = document.getElementById('catnr');
  const catnrGo = document.getElementById('catnr-go');
  const tleInput = document.getElementById('tle-input');
  const tleGo = document.getElementById('tle-go');
  const msg = document.getElementById('custom-msg');

  const say = (text, isError) => {
    msg.textContent = text;
    msg.classList.toggle('error', !!isError);
  };

  catnrGo.addEventListener('click', async () => {
    const id = catnrEl.value.trim();
    if (!/^\d{1,9}$/.test(id)) {
      say('Enter a numeric NORAD ID.', true);
      return;
    }
    say('Fetching…', false);
    try {
      const sats = await fetchByCatnr(id);
      const group = addCustomGroup(sats, sats[0].name || `NORAD ${id}`);
      say(`Added ${group.count} satellite${group.count > 1 ? 's' : ''}.`, false);
      catnrEl.value = '';
    } catch (err) {
      say(err.message || 'Lookup failed.', true);
    }
  });

  tleGo.addEventListener('click', () => {
    const sats = parseTle(tleInput.value);
    if (!sats.length) {
      say('No valid TLE found. Paste name + two element lines.', true);
      return;
    }
    const group = addCustomGroup(sats, sats.length === 1 ? sats[0].name : 'Pasted TLE');
    say(`Added ${group.count} satellite${group.count > 1 ? 's' : ''}.`, false);
    tleInput.value = '';
  });
}

// --- Search ---------------------------------------------------------------
function runSearch() {
  const q = searchEl.value.trim().toLowerCase();
  if (!q) {
    searchResultsEl.innerHTML = '';
    return;
  }
  const matches = [];
  for (const e of searchIndex) {
    if (e.name.toLowerCase().includes(q) || e.noradId.includes(q)) {
      matches.push(e);
      if (matches.length >= 40) break;
    }
  }
  renderSearchResults(matches);
}

function renderSearchResults(matches) {
  searchResultsEl.innerHTML = '';
  if (!matches.length) {
    searchResultsEl.innerHTML = '<div class="search-empty">No matches</div>';
    return;
  }
  for (const e of matches) {
    const row = document.createElement('button');
    row.className = 'search-result';
    row.innerHTML = `<span class="sr-name">${escapeHtml(e.name)}</span><span class="sr-id">${escapeHtml(e.noradId)}</span>`;
    row.addEventListener('click', () => {
      selectSatellite(e.group, e.idx);
      searchEl.value = e.name;
      searchResultsEl.innerHTML = '';
    });
    searchResultsEl.appendChild(row);
  }
}

// --- Time -----------------------------------------------------------------
let timeRate = 1;
let simTime = new Date();
let lastReal = performance.now();

document.querySelectorAll('.time-controls button').forEach((btn) => {
  if (btn.dataset.rate === '1') btn.classList.add('active');
  btn.addEventListener('click', () => {
    timeRate = Number(btn.dataset.rate);
    document
      .querySelectorAll('.time-controls button')
      .forEach((b) => b.classList.toggle('active', b === btn));
  });
});

// --- Interaction ----------------------------------------------------------
canvas.addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  tooltipEl.style.left = e.clientX + 14 + 'px';
  tooltipEl.style.top = e.clientY + 14 + 'px';
  hasPointer = true;
});
canvas.addEventListener('pointerleave', () => {
  hasPointer = false;
  tooltipEl.classList.remove('visible');
});

// Click-to-select: distinguish a click from an orbit-drag by movement.
let pointerDown = null;
canvas.addEventListener('pointerdown', (e) => {
  pointerDown = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', (e) => {
  if (!pointerDown) return;
  const moved = Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y);
  pointerDown = null;
  if (moved > 6) return; // it was a drag, not a click

  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  let best = null;
  for (const group of loadedGroups) {
    if (!group.visible) continue;
    const hits = raycaster.intersectObject(group.points, false);
    if (hits.length && (!best || hits[0].distanceToRay < best.hit.distanceToRay)) {
      best = { hit: hits[0], group };
    }
  }
  if (best) selectSatellite(best.group, best.hit.index);
});

searchEl.addEventListener('input', runSearch);
searchEl.addEventListener('focus', runSearch);
document.getElementById('detail-close').addEventListener('click', deselect);

function pickSatellite() {
  if (!hasPointer) return;
  raycaster.setFromCamera(pointer, camera);

  let best = null;
  for (const group of loadedGroups) {
    if (!group.visible) continue;
    const hits = raycaster.intersectObject(group.points, false);
    if (hits.length && (!best || hits[0].distanceToRay < best.hit.distanceToRay)) {
      best = { hit: hits[0], group };
    }
  }

  if (!best) {
    tooltipEl.classList.remove('visible');
    return;
  }

  const sat = best.group.sats[best.hit.index];
  const altKm = best.group.altitudeKm(best.hit.index);
  const alt = altKm != null ? `${Math.round(altKm)} km` : '—';
  tooltipEl.innerHTML = `<div class="name">${sat.name}</div><div class="detail">alt ${alt}</div>`;
  tooltipEl.classList.add('visible');
}

// --- Resize ---------------------------------------------------------------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// --- Loop -----------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const dtMs = (now - lastReal) * timeRate;
  lastReal = now;
  simTime = new Date(simTime.getTime() + dtMs);

  const gmst = gmstFor(simTime);
  earth.rotation.y = gmst;

  // Cap propagation per group per frame so a huge constellation (Starlink is
  // ~10k) spreads its work across frames instead of stalling the render loop.
  for (const group of loadedGroups) {
    if (group.visible) group.update(simTime, 1500);
  }

  updateSelection(gmst);
  pickSatellite();
  controls.update();
  renderer.render(scene, camera);

  clockEl.textContent = simTime.toUTCString().replace('GMT', 'UTC');
}

setupCustomControls();
loadAll();
animate();
