import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const ALLOWED_INVOKE_CHANNELS = [
  'browser:navigate',
  'browser:set-bounds',
  'browser:set-inspect-mode',
  'workspace:list',
  'workspace:open',
  'patch:preview',
  'patch:apply',
] as const;

const ALLOWED_EVENT_CHANNELS = [
  'browser:capture',
  'browser:inspect-exit',
] as const;

type InvokeChannel = (typeof ALLOWED_INVOKE_CHANNELS)[number];
type EventChannel = (typeof ALLOWED_EVENT_CHANNELS)[number];

function isInvokeAllowed(channel: string): channel is InvokeChannel {
  return (ALLOWED_INVOKE_CHANNELS as readonly string[]).includes(channel);
}

function isEventAllowed(channel: string): channel is EventChannel {
  return (ALLOWED_EVENT_CHANNELS as readonly string[]).includes(channel);
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
    const listener = (_event: IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
});
