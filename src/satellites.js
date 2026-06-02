import * as THREE from 'three';
import * as satellite from 'satellite.js';

export const EARTH_RADIUS_KM = 6371;
export const EARTH_RADIUS_UNITS = 1;
const KM_TO_UNITS = EARTH_RADIUS_UNITS / EARTH_RADIUS_KM;

// CelesTrak satellite groups to offer. Fetched through our own /api/tle
// endpoint (a Netlify function in prod, a Vite dev middleware locally) so the
// data is proxied and edge-cached rather than hitting CelesTrak per-browser.
export const GROUPS = [
  { id: 'stations', label: 'Space Stations', color: 0xffe27a, size: 0.05 },
  { id: 'gps-ops', label: 'GPS', color: 0x7affc0, size: 0.03 },
  { id: 'galileo', label: 'Galileo', color: 0xc89bff, size: 0.03 },
  { id: 'starlink', label: 'Starlink', color: 0x5fa8ff, size: 0.02 },
  { id: 'weather', label: 'Weather', color: 0xff9b6b, size: 0.03 },
];

function tleUrl(groupId) {
  return `/api/tle?group=${encodeURIComponent(groupId)}`;
}

// A soft circular sprite so points render as glowing dots, not squares.
let dotTexture = null;
function getDotTexture() {
  if (dotTexture) return dotTexture;
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  dotTexture = new THREE.CanvasTexture(c);
  return dotTexture;
}

// Parse a 3-line-element text blob into satellite records.
function parseTle(text) {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\r/g, '').trimEnd())
    .filter((l) => l.length > 0);

  const sats = [];
  for (let i = 0; i + 2 < lines.length + 1; i += 3) {
    const name = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (!line1 || !line2 || line1[0] !== '1' || line2[0] !== '2') continue;
    try {
      const satrec = satellite.twoline2satrec(line1, line2);
      if (satrec.error === 0) {
        sats.push({ name: name.trim(), satrec });
      }
    } catch {
      // skip malformed record
    }
  }
  return sats;
}

// CelesTrak asks clients not to re-download a group more than once every
// couple of hours, and 403s repeat requests. Cache TLE text in localStorage
// and reuse it within the window; on a throttled/failed fetch, fall back to
// whatever cached copy we have.
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

function cacheKey(groupId) {
  return `tle:${groupId}`;
}

function readCache(groupId) {
  try {
    const raw = localStorage.getItem(cacheKey(groupId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCache(groupId, text) {
  try {
    localStorage.setItem(cacheKey(groupId), JSON.stringify({ text, ts: Date.now() }));
  } catch {
    // storage full or unavailable — non-fatal
  }
}

export async function fetchGroup(groupId) {
  const cached = readCache(groupId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return parseTle(cached.text);
  }

  try {
    const res = await fetch(tleUrl(groupId));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (/^\s*GP data has not updated/i.test(text)) throw new Error('throttled');
    writeCache(groupId, text);
    return parseTle(text);
  } catch (err) {
    if (cached) return parseTle(cached.text);
    throw new Error(`Failed to load ${groupId}: ${err.message}`);
  }
}

// A renderable cloud of satellites for one group.
export class SatelliteGroup {
  constructor({ id, color, size }, sats) {
    this.id = id;
    this.sats = sats;
    this.visible = true;

    const count = sats.length;
    this.positions = new Float32Array(count * 3);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));

    const material = new THREE.PointsMaterial({
      color,
      size,
      map: getDotTexture(),
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
  }

  // Propagate every satellite to `date` and update GPU positions.
  // Positions are in the ECI frame (the Earth mesh is counter-rotated by GMST).
  update(date) {
    const gmst = satellite.gstime(date);
    const pos = this.positions;
    let w = 0;
    for (let i = 0; i < this.sats.length; i++) {
      const sat = this.sats[i];
      const pv = satellite.propagate(sat.satrec, date);
      const eci = pv.position;
      if (!eci) {
        pos[w] = pos[w + 1] = pos[w + 2] = 0;
        sat.alt = null;
      } else {
        // ECI km -> scene units. Map ECI Z (north) to scene +Y.
        pos[w] = eci.x * KM_TO_UNITS;
        pos[w + 1] = eci.z * KM_TO_UNITS;
        pos[w + 2] = -eci.y * KM_TO_UNITS;
        const geo = satellite.eciToGeodetic(eci, gmst);
        sat.alt = geo.height;
        sat.lat = satellite.degreesLat(geo.latitude);
        sat.lon = satellite.degreesLong(geo.longitude);
      }
      w += 3;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }

  setVisible(v) {
    this.visible = v;
    this.points.visible = v;
  }

  get count() {
    return this.sats.length;
  }
}

// Current GMST rotation (radians) so the caller can align the Earth mesh.
export function gmstFor(date) {
  return satellite.gstime(date);
}
