import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  GROUPS,
  fetchGroup,
  SatelliteGroup,
  gmstFor,
  EARTH_RADIUS_UNITS,
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
const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.025;
const pointer = new THREE.Vector2();
let hasPointer = false;

const loadingEl = document.getElementById('loading');
const groupsEl = document.getElementById('groups');
const countsEl = document.getElementById('counts');
const tooltipEl = document.getElementById('tooltip');
const clockEl = document.getElementById('clock');

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
      scene.add(group.points);
      loadedGroups.push(group);
      addGroupRow(meta, group);
    } else {
      addGroupRow(meta, null);
    }
  });

  loadingEl.style.display = 'none';
  updateCounts();
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
  const alt = sat.alt != null ? `${Math.round(sat.alt)} km` : '—';
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

  earth.rotation.y = gmstFor(simTime);

  for (const group of loadedGroups) {
    if (group.visible) group.update(simTime);
  }

  pickSatellite();
  controls.update();
  renderer.render(scene, camera);

  clockEl.textContent = simTime.toUTCString().replace('GMT', 'UTC');
}

loadAll();
animate();
