import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Renderer unit/component tests. Kept separate from vite.config.ts so the
 * Electron plugin (which spawns the app) never runs under the test runner — we
 * only need React + a jsdom DOM. Tests live next to the code as `*.test.tsx`.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
