import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config for the marudesk mobile bridge client.
 *
 * `webDir` is the Vite build output (`npm run build` → `dist/`). After a build,
 * `npx cap sync android` copies `dist/` into the native Android project. See
 * README.md for the full APK build prerequisites (JDK + Android SDK/Gradle) and
 * commands — this environment has no Android SDK, so only the web/PWA build and
 * the Capacitor scaffold are produced here.
 *
 * `server.cleartext` + `androidScheme: 'http'` are enabled so a DEV build can
 * reach a relay over plain `http://`/`ws://` (e.g. the default
 * `http://127.0.0.1:8788` on a LAN). For a production APK pointing at a TLS
 * relay, drop `cleartext` and prefer `https`.
 */
const config: CapacitorConfig = {
  appId: 'com.marudesk.mobile',
  appName: 'marudesk',
  webDir: 'dist',
  server: {
    androidScheme: 'http',
    cleartext: true,
  },
};

export default config;
