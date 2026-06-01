/**
 * Optional native (Capacitor) integration, guarded so the web/PWA build is
 * unaffected when the plugins aren't present. Currently wires the Android
 * hardware back button to the in-app router and logs network changes; both are
 * best-effort and silently skipped on the web.
 */
import { useAppStore } from './store/useAppStore';

function isNative(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

export async function initNative(): Promise<void> {
  if (!isNative()) return;

  // Hardware back button: navigate within the app instead of closing it.
  try {
    const { App } = await import('@capacitor/app');
    void App.addListener('backButton', ({ canGoBack }) => {
      const { route, setRoute } = useAppStore.getState();
      if (route === 'account') setRoute('chat');
      else if (route === 'login') setRoute('connect');
      else if (!canGoBack) void App.exitApp();
    });
  } catch {
    // @capacitor/app not installed — ignore.
  }

  // Network status → trigger a reconnect when connectivity returns.
  try {
    const { Network } = await import('@capacitor/network');
    void Network.addListener('networkStatusChange', (s) => {
      if (s.connected) void useAppStore.getState().reconnect();
    });
  } catch {
    // @capacitor/network not installed — ignore.
  }
}
