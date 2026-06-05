import type { AgentChatState } from '../types';
import { Emitter } from './emitter';
import type { TransportStatusInfo, Unsubscribe } from './types';

/**
 * Shared fan-out plumbing for every {@link Transport}. The agent-state and
 * connection-status emitters, their `onState`/`onStatus` subscriptions, and the
 * `setStatus`/`emitState` helpers are identical across the relay, direct, and
 * stub transports, so they live here. Concrete transports add only their
 * connect/send/disconnect behavior.
 */
export abstract class BaseTransport {
  protected readonly stateEmitter = new Emitter<AgentChatState>();
  protected readonly statusEmitter = new Emitter<TransportStatusInfo>();

  onState(cb: (state: AgentChatState) => void): Unsubscribe {
    return this.stateEmitter.subscribe(cb);
  }

  onStatus(cb: (info: TransportStatusInfo) => void): Unsubscribe {
    return this.statusEmitter.subscribe(cb);
  }

  /** Push a fresh agent-state snapshot to subscribers. */
  protected emitState(state: AgentChatState): void {
    this.stateEmitter.emit(state);
  }

  /** Push a coarse connection-status update to subscribers. */
  protected setStatus(info: TransportStatusInfo): void {
    this.statusEmitter.emit(info);
  }
}
