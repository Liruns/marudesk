import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('__marudeskBridge', {
  capture(payload: unknown) {
    ipcRenderer.send('inspect:capture', payload);
  },
  exit() {
    ipcRenderer.send('inspect:exit');
  },
  // Floating stage toolbar (§3.2): start the element picker from inside the page.
  startInspect() {
    ipcRenderer.send('inspect:start');
  },
});
