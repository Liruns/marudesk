import { defineConfig } from 'vite';

// Isolated preview build for the @pierre/trees spike screenshot. Kept separate
// from the Electron vite config so it bundles as a plain web page.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
});
