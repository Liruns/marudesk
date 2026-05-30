import type {
  EventChannel,
  EventPayload,
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
} from '../../shared/ipc';

export {};

declare global {
  interface Window {
    marudesk: {
      invoke<C extends InvokeChannel>(
        channel: C,
        ...args: InvokeArgs<C>
      ): Promise<InvokeResult<C>>;
      on<C extends EventChannel>(
        channel: C,
        handler: (payload: EventPayload<C>) => void,
      ): () => void;
    };
  }
}
