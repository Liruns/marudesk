import { useEffect, useState } from 'react';
import { Shell } from './views/Shell';
import { ComponentGallery } from './views/ComponentGallery';
import { PatchComposer } from './features/patch/PatchComposer';
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
  return <Shell />;
}

export default App;
