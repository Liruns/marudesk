import type { StoreApi } from 'zustand';
import { parseVisibleSecurityState } from './security-utils';
import type { DevtoolsState, DevtoolsActions } from './store';

type DevtoolsStore = DevtoolsState & DevtoolsActions;
type SetState = StoreApi<DevtoolsStore>['setState'];

type SecurityActions = Pick<DevtoolsActions, '_handleSecurityState'>;

/**
 * The Security panel actions for the devtools store. The panel is read-only:
 * Security.enable (via _enablePanel) makes Chromium emit
 * `Security.visibleSecurityStateChanged` immediately and on every transport
 * change; ingest-batch relays the event here as an effect. The snapshot is
 * strictly per-navigation — `_handleNavigated` clears it so stale certificate
 * details never show for a new origin (the post-navigation re-enable then
 * replays the fresh state).
 */
export function createSecuritySlice(set: SetState): SecurityActions {
  return {
    _handleSecurityState: (params) => {
      const parsed = parseVisibleSecurityState(params);
      if (parsed) set({ securityState: parsed });
    },
  };
}
