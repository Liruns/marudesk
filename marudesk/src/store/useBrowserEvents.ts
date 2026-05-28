import { useEffect } from 'react';
import { useBrowserStore } from './browser';

export function useBrowserEvents(): void {
  useEffect(() => {
    const offCapture = window.marudesk.on('browser:capture', (capture) => {
      useBrowserStore.getState().addCapture(capture);
    });
    const offExit = window.marudesk.on('browser:inspect-exit', () => {
      useBrowserStore.setState({ inspectMode: false });
    });
    return () => {
      offCapture();
      offExit();
    };
  }, []);
}
