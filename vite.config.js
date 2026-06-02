import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Served from https://perkinscole.github.io/satellite-visualizer/ in
// production, so the built assets need that base path. Dev stays at root.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/satellite-visualizer/' : '/',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        learn: resolve(__dirname, 'learn.html'),
        launches: resolve(__dirname, 'launches.html'),
      },
    },
  },
}));
