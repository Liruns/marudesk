import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Mobile thin-client for the marudesk Model-B bridge.
// `base: ''` keeps asset URLs relative so the same `dist/` works both as a PWA
// served from any path and inside the Capacitor WebView (file:// / capacitor://).
export default defineConfig({
  base: '',
  plugins: [react()],
  build: {
    // Capacitor copies this directory into the native app (see capacitor.config.ts → webDir).
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    host: true,
    port: 5273,
  },
});
