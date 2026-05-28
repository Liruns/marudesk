import type { Capture } from './capture';

export {};

declare global {
  type MarudeskInvokeChannel =
    | 'browser:navigate'
    | 'browser:set-bounds'
    | 'browser:set-inspect-mode'
    | 'workspace:list'
    | 'workspace:open'
    | 'patch:preview'
    | 'patch:apply';

  type MarudeskEventChannel = 'browser:capture' | 'browser:inspect-exit';

  type MarudeskEventPayload<C extends MarudeskEventChannel> =
    C extends 'browser:capture' ? Capture
    : C extends 'browser:inspect-exit' ? void
    : never;

  interface Window {
    marudesk: {
      invoke<T = unknown>(
        channel: MarudeskInvokeChannel,
        ...args: unknown[]
      ): Promise<T>;
      on<C extends MarudeskEventChannel>(
        channel: C,
        handler: (payload: MarudeskEventPayload<C>) => void,
      ): () => void;
    };
  }
}
