import * as THREE from 'three';
import * as satellite from 'satellite.js';

export const EARTH_RADIUS_KM = 6371;
export const EARTH_RADIUS_UNITS = 1;
export const KM_TO_UNITS = EARTH_RADIUS_UNITS / EARTH_RADIUS_KM;
export const MU_EARTH = 398600.4418; // gravitational parameter, km^3 / s^2

// CelesTrak satellite groups to offer. CelesTrak sends an open CORS header
// (access-control-allow-origin: *), so we fetch it directly from the browser.
// Results are cached in localStorage to avoid re-downloading (CelesTrak 403s
// repeat downloads of the same group within a couple of hours).
export const GROUPS = [
  { id: 'stations', label: 'Space Stations', color: 0xffe27a, size: 0.05 },
  { id: 'gps-ops', label: 'GPS', color: 0x7affc0, size: 0.03 },
  { id: 'galileo', label: 'Galileo', color: 0xc89bff, size: 0.03 },
  { id: 'starlink', label: 'Starlink', color: 0x5fa8ff, size: 0.02 },
  { id: 'weather', label: 'Weather', color: 0xff9b6b, size: 0.03 },
];

function tleUrl(groupId) {
  return `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(groupId)}&FORMAT=tle`;
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
export function parseTle(text) {
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
    this.cursor = 0; // round-robin position for budgeted propagation

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

  // Propagate up to `budget` satellites to `date` and update their GPU
  // positions, advancing a round-robin cursor so the work per frame is bounded
  // no matter how large the group is (a 10k-satellite group like Starlink
  // refreshes over a handful of frames instead of stalling one).
  // Positions are in the ECI frame (the Earth mesh is counter-rotated by GMST).
  // Geodetic altitude is intentionally NOT computed here; it is derived on
  // demand for the single hovered satellite (see altitudeKm).
  update(date, budget = Infinity) {
    const n = this.sats.length;
    if (n === 0) return;
    const count = Math.min(budget, n);
    const pos = this.positions;
    let i = this.cursor;
    for (let k = 0; k < count; k++) {
      const eci = satellite.propagate(this.sats[i].satrec, date).position;
      const w = i * 3;
      if (eci) {
        // ECI km -> scene units. Map ECI Z (north) to scene +Y.
        pos[w] = eci.x * KM_TO_UNITS;
        pos[w + 1] = eci.z * KM_TO_UNITS;
        pos[w + 2] = -eci.y * KM_TO_UNITS;
      } else {
        pos[w] = pos[w + 1] = pos[w + 2] = 0;
      }
      i = (i + 1) % n;
    }
    this.cursor = i;
    this.points.geometry.attributes.position.needsUpdate = true;
  }

  // Altitude (km) of satellite `index`, derived from its current scene
  // position. Cheap enough to call per hover instead of per frame.
  altitudeKm(index) {
    const w = index * 3;
    const p = this.positions;
    const r = Math.hypot(p[w], p[w + 1], p[w + 2]) * EARTH_RADIUS_KM;
    return r > 0 ? r - EARTH_RADIUS_KM : null;
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

// --- Orbital analysis helpers --------------------------------------------

// Static orbital elements derived from a TLE record. Period and semi-major
// axis come from the mean motion; apogee/perigee from the eccentricity.
export function orbitalElements(satrec) {
  const n = satrec.no_kozai ?? satrec.no; // mean motion, rad/min
  const e = satrec.ecco;
  const periodMin = (2 * Math.PI) / n;
  const nRadPerSec = n / 60;
  const a = Math.cbrt(MU_EARTH / (nRadPerSec * nRadPerSec)); // semi-major axis, km
  return {
    noradId: satrec.satnum,
    inclinationDeg: satrec.inclo * (180 / Math.PI),
    raanDeg: satrec.nodeo * (180 / Math.PI),
    eccentricity: e,
    argPerigeeDeg: satrec.argpo * (180 / Math.PI),
    periodMin,
    semiMajorAxisKm: a,
    apogeeKm: a * (1 + e) - EARTH_RADIUS_KM,
    perigeeKm: a * (1 - e) - EARTH_RADIUS_KM,
  };
}

// Live geodetic state of a satellite at `date`. Pass `gmst` (= gmstFor(date))
// when a caller already computed it once for the frame, to avoid recomputing.
export function satelliteState(satrec, date, gmst = satellite.gstime(date)) {
  const pv = satellite.propagate(satrec, date);
  if (!pv.position || !pv.velocity) return null;
  const geo = satellite.eciToGeodetic(pv.position, gmst);
  const v = pv.velocity;
  return {
    positionEci: pv.position,
    velocityEci: v,
    speedKmS: Math.hypot(v.x, v.y, v.z),
    latDeg: satellite.degreesLat(geo.latitude),
    lonDeg: satellite.degreesLong(geo.longitude),
    altitudeKm: geo.height,
  };
}

// Convert an ECI position (km) to a scene-space [x, y, z] triple, matching the
// mapping used for the point clouds (ECI Z -> scene +Y, ECI Y -> scene -Z).
export function eciToScene(eci) {
  return [eci.x * KM_TO_UNITS, eci.z * KM_TO_UNITS, -eci.y * KM_TO_UNITS];
}

// Ground track: geodetic lat/lon samples along the orbit across `orbits`
// revolutions starting at `date`. Returns [{ latDeg, lonDeg, altitudeKm }].
export function groundTrack(satrec, date, { orbits = 1, samples = 180 } = {}) {
  const els = orbitalElements(satrec);
  const spanMs = els.periodMin * 60 * 1000 * orbits;
  const pts = [];
  for (let k = 0; k <= samples; k++) {
    const t = new Date(date.getTime() + (spanMs * k) / samples);
    const st = satelliteState(satrec, t);
    if (st) pts.push({ latDeg: st.latDeg, lonDeg: st.lonDeg, altitudeKm: st.altitudeKm });
  }
  return pts;
}

// Predict visible passes over a ground observer for the next `hours`.
// observer = { latDeg, lonDeg, heightKm }. A pass is a contiguous interval
// where elevation exceeds `minElevationDeg`. Returns [{ start, end, peakTime,
// peakElDeg, peakAzDeg }].
export function predictPasses(
  satrec,
  observer,
  date = new Date(),
  { hours = 24, stepSec = 30, minElevationDeg = 10 } = {}
) {
  const observerGd = {
    longitude: satellite.degreesToRadians(observer.lonDeg),
    latitude: satellite.degreesToRadians(observer.latDeg),
    height: observer.heightKm ?? 0,
  };
  const passes = [];
  let current = null;
  const steps = Math.ceil((hours * 3600) / stepSec);
  for (let s = 0; s <= steps; s++) {
    const t = new Date(date.getTime() + s * stepSec * 1000);
    const pv = satellite.propagate(satrec, t);
    if (!pv.position) continue;
    const gmst = satellite.gstime(t);
    const ecf = satellite.eciToEcf(pv.position, gmst);
    const look = satellite.ecfToLookAngles(observerGd, ecf);
    const elDeg = look.elevation * (180 / Math.PI);
    const azDeg = ((look.azimuth * 180) / Math.PI + 360) % 360;
    if (elDeg >= minElevationDeg) {
      if (!current) {
        current = { start: t, end: t, peakTime: t, peakElDeg: elDeg, peakAzDeg: azDeg };
      } else if (elDeg > current.peakElDeg) {
        current.peakElDeg = elDeg;
        current.peakTime = t;
        current.peakAzDeg = azDeg;
      }
      current.end = t;
    } else if (current) {
      passes.push(current);
      current = null;
    }
  }
  if (current) passes.push(current);
  return passes;
}
