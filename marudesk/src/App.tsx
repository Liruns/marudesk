import { useEffect, useState } from 'react';
import { Shell } from './views/Shell';
import { ComponentGallery } from './views/ComponentGallery';

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

  if (route === '/dev/components') {
    return <ComponentGallery />;
  }
  return <Shell />;
}

export default App;
