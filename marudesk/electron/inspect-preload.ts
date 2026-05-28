import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('__marudeskBridge', {
  capture(payload: unknown) {
    ipcRenderer.send('inspect:capture', payload);
  },
  exit() {
    ipcRenderer.send('inspect:exit');
  },
});
