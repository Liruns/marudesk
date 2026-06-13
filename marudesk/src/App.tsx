import { useEffect, useState } from 'react';
import { Shell } from './views/Shell';
import { ComponentGallery } from './views/ComponentGallery';
import { PatchComposer } from './features/patch/PatchComposer';
import { DevtoolsWindow } from './features/devtools/DevtoolsWindow';
import { useSettingsStore } from './features/settings/store';

function readRoute() {
  return window.location.hash.replace(/^#/, '') || '/';
}

function App() {
  const [route, setRoute] = useState(readRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Load + apply persisted settings (theme, zoom, fonts) once on startup.
  useEffect(() => {
    void useSettingsStore.getState().init();
  }, []);

  if (route === '/dev/components') {
    return <ComponentGallery />;
  }
  if (route === '/dev/patch') {
    return <PatchComposer />;
  }
  // Pop-out DevTools window (electron/browser/devtools-window.ts loads this
  // route). The tabId is the bound web tab; DevtoolsWindow runs a self-contained
  // event bridge + session for it, full-window instead of the Shell.
  if (route.startsWith('/devtools/')) {
    const tabId = decodeURIComponent(route.slice('/devtools/'.length));
    if (tabId) return <DevtoolsWindow tabId={tabId} />;
  }
  return <Shell />;
}

export default App;
