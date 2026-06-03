# Orbital — Satellite Visualizer

A 3D web app that shows real satellites orbiting Earth in real time, built for the classroom. It pulls live orbital data from CelesTrak, propagates each satellite's position with SGP4, and renders the whole thing in the browser with Three.js.

**Live site:** https://perkinscole.github.io/satellite-visualizer/

## Pages

- **Visualizer** (`index.html`) — A rotating 3D Earth with live satellite positions. Toggle groups (Space Stations, GPS, Galileo, Starlink, Weather), hover any point to see its name and altitude, and speed up time from real time to 3600x to watch orbits sweep around the planet. The globe is lit from the real direction of the Sun, with a day/night terminator and city lights on the dark side. Beyond the basics, it includes a set of tools for educators and researchers:
  - **Sun, terminator & eclipse** — the Earth is shaded by the true Sun position for the simulated moment, so you see day, night, and the dawn/dusk line sweep across the surface. Satellites dim as they cross into Earth's shadow and brighten again in sunlight, and the detail panel reports whether the selected satellite is currently sunlit or eclipsed. This is exactly why the ISS is only visible from the ground at dawn and dusk, when it is still catching sunlight while the observer is in darkness.
  - **Live Earth imagery** — the day side of the globe is wrapped in NASA's most recent daily satellite mosaic (VIIRS true-color via GIBS), so the clouds and weather you see are the actual clouds photographed from space, not a static map. It falls back to a built-in blue-marble texture if the live imagery is unavailable.
  - **Search & select** — find any satellite by name or NORAD ID, or click a point. The camera flies to frame it against Earth and follows it.
  - **Detail panel** — live altitude, speed, latitude/longitude plus derived orbital elements (inclination, period, apogee, perigee) read from the TLE.
  - **Ground track & coverage** — the selected satellite's one-orbit ground track and horizon coverage footprint drawn on the Earth's surface.
  - **Pass predictions** — enter a latitude/longitude (or use the browser's geolocation) to list the next visible passes over the next 48 hours, with local time, max elevation, compass bearing, and duration.
  - **Custom data** — add any satellite by NORAD catalog number (fetched live from CelesTrak) or by pasting raw TLE text.
  - **Export** — download one orbit of the selected satellite as CSV (time/lat/lon/altitude/speed) or JSON (with the orbital elements).
- **Learn** (`learn.html`) — A student-friendly explainer: what a satellite is, a short history, what satellites do, and the main orbit types.
- **Launches** (`launches.html`) — Upcoming rocket launches from around the world with a live countdown to the next liftoff.

## How it works

- **Orbital data** comes from [CelesTrak](https://celestrak.org) as TLE (two-line element) sets. CelesTrak sends an open CORS header, so the browser fetches it directly with no backend needed.
- **Position propagation** uses [satellite.js](https://github.com/shashwatak/satellite-js) (SGP4) to turn each TLE into an ECI coordinate, mapped into the Three.js scene while the Earth mesh is counter-rotated by GMST to keep everything aligned.
- **Sun & shadow:** the Sun's direction is computed from a low-precision solar-position formula for the simulated time. A custom day/night shader blends a daytime map and a city-lights map across a soft terminator, and each satellite is tested against Earth's cylindrical shadow (umbra) so eclipsed satellites dim in real time.
- **Live imagery:** the daytime map is fetched from [NASA GIBS](https://nasa-gibs.github.io/gibs-api-docs/) (VIIRS true-color) as a single equirectangular WMS image for the most recent fully populated day. GIBS sends an open CORS header, so the browser loads it directly, and the static blue-marble texture stands in if the request fails.
- **Caching:** TLE data is cached in `localStorage` for 2 hours so the app does not re-download on every visit (and to stay within CelesTrak's per-IP rate limit). Launch data is cached for 30 minutes.
- **Performance:** Large constellations like Starlink (~10k satellites) are propagated with a round-robin per-frame budget, so the work spreads across frames instead of stalling the render loop.

## Development

```bash
npm install
npm run dev      # start the Vite dev server
npm run build    # production build to dist/
npm run preview  # preview the production build locally
```

Built with [Vite](https://vitejs.dev), [Three.js](https://threejs.org), and [satellite.js](https://github.com/shashwatak/satellite-js).

## Deployment

The site deploys automatically to GitHub Pages via GitHub Actions on every push to `master` (see `.github/workflows/deploy.yml`). The Vite `base` path is set to `/satellite-visualizer/` for production builds so assets resolve correctly under the project subpath.

## Note for classroom use

Because each browser fetches data directly from CelesTrak, a whole class behind a single shared (NAT'd) school IP could occasionally trip CelesTrak's per-IP rate limit if everyone loads at the exact same moment. The `localStorage` cache and graceful fallback to cached data soften this, and once a machine has loaded once it will not re-fetch for 2 hours.
