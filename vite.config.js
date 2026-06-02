import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const CELESTRAK = 'https://celestrak.org/NORAD/elements/gp.php';

// In dev there is no Netlify function, so this middleware serves the same
// /api/tle?group=ID endpoint by proxying CelesTrak server-side. Keeps local
// behavior identical to production.
function tleDevApi() {
  return {
    name: 'tle-dev-api',
    configureServer(server) {
      server.middlewares.use('/api/tle', async (req, res) => {
        const { searchParams } = new URL(req.url, 'http://localhost');
        const group = (searchParams.get('group') || '').trim();
        if (!/^[a-z0-9-]{1,32}$/.test(group)) {
          res.statusCode = 400;
          res.end('Invalid group');
          return;
        }
        try {
          const upstream = await fetch(`${CELESTRAK}?GROUP=${group}&FORMAT=tle`);
          const text = await upstream.text();
          if (!upstream.ok || /^\s*GP data has not updated/i.test(text)) {
            res.statusCode = 503;
            res.end('Upstream temporarily unavailable');
            return;
          }
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(text);
        } catch {
          res.statusCode = 502;
          res.end('Fetch failed');
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [tleDevApi()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        learn: resolve(__dirname, 'learn.html'),
        launches: resolve(__dirname, 'launches.html'),
      },
    },
  },
});
