import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Isolated preview build for the @pierre/diffs spike screenshot + bundle
// measurement. Separate from the Electron config so it bundles as a web page.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
