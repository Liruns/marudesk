import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type EventChannel,
  type InvokeChannel,
} from '../shared/ipc';

function isInvokeAllowed(channel: string): channel is InvokeChannel {
  return (INVOKE_CHANNELS as readonly string[]).includes(channel);
}

function isEventAllowed(channel: string): channel is EventChannel {
  return (EVENT_CHANNELS as readonly string[]).includes(channel);
}

contextBridge.exposeInMainWorld('marudesk', {
  invoke(channel: InvokeChannel, ...args: unknown[]): Promise<unknown> {
    if (!isInvokeAllowed(channel)) {
      return Promise.reject(
        new Error(`marudesk: invoke channel "${channel}" is not allowed`),
      );
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel: EventChannel, handler: (payload: unknown) => void): () => void {
    if (!isEventAllowed(channel)) {
      throw new Error(`marudesk: event channel "${channel}" is not allowed`);
    }
    const listener = (_event: IpcRendererEvent, payload: unknown) =>
      handler(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
  // Resolve the absolute path of a file dropped from the OS onto the window.
  // Electron 32+ removed the non-standard `File.path`; `webUtils.getPathForFile`
  // is the supported replacement and must run here in the preload. Returns '' for
  // anything that isn't a real on-disk file (e.g. a synthetic File).
  getPathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});
