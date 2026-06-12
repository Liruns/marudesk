import type { StoreApi } from 'zustand';
import { cdpTry } from './cdp';
import { indexNode, setAttr, removeAttr } from './dom-index';
import { consoleKindFromApi, consoleKindFromLog } from './console-kind';
import { boundedNetworkPayload, entryId, MAX_CONSOLE, MAX_NETWORK } from './store-internals';
import {
  MAX_FRAME_CONNECTIONS,
  makeSseFrame,
  makeWsFrame,
  pushFrame,
  type WsFrame,
} from './ws-frames';
import type {
  CdpNode,
  ConsoleEntry,
  NetworkEntry,
  NodeId,
  RemoteObject,
} from './types';
import type { DevtoolsState, DevtoolsActions } from './store';

type DevtoolsStore = DevtoolsState & DevtoolsActions;
type SetState = StoreApi<DevtoolsStore>['setState'];
type GetState = StoreApi<DevtoolsStore>['getState'];

/**
 * Apply one coalesced batch of CDP events to the devtools store (extracted from
 * store.ts to keep the live-update reducer — the single largest action — on its
 * own). It folds DOM/console/network/stylesheet/lifecycle events into the next
 * state via a single `set`, queueing post-commit `effects` that run afterward.
 * Behavior is identical to the inline action; `set`/`get` are passed in.
 */
export function applyIngestBatch(
  set: SetState,
  get: GetState,
  items: { method: string; params: unknown }[],
  dropped?: number,
): void {
      const effects: Array<() => void> = [];
      set((s) => {
        let nodes = s.nodes;
        let childIds = s.childIds;
        let domDirty = false;
        let consoleArr = s.console;
        let consoleDirty = false;
        let network = s.network;
        let netIndex: Map<string, number> | null = null;
        let netDirty = false;
        let wsFrames = s.wsFrames;
        let framesDirty = false;
        // Connections whose buffer was already copied this batch (copy-on-write
        // against the previous state; later pushes mutate the fresh copy).
        const framesTouched = new Set<string>();
        let styleSheets = s.styleSheets;
        let sheetsDirty = false;
        // Page-lifecycle timing for the Network summary bar (CDP seconds).
        let navStart = s.navStartTime;
        let domContent = s.domContentTime;
        let load = s.loadTime;

        const ensureDom = () => {
          if (!domDirty) {
            nodes = new Map(nodes);
            childIds = new Map(childIds);
            domDirty = true;
          }
        };
        const ensureSheets = () => {
          if (!sheetsDirty) {
            styleSheets = new Map(styleSheets);
            sheetsDirty = true;
          }
        };
        const ensureNet = () => {
          if (!netDirty) {
            network = [...network];
            netIndex = new Map(network.map((e, i) => [e.requestId, i]));
            netDirty = true;
          } else if (!netIndex) {
            netIndex = new Map(network.map((e, i) => [e.requestId, i]));
          }
        };
        // Frame buffer for one WS/SSE connection, safe to mutate this batch.
        // Evicts the oldest connection beyond MAX_FRAME_CONNECTIONS (Map keeps
        // insertion order) so a page cycling sockets can't grow the store.
        const framesFor = (requestId: string): WsFrame[] => {
          if (!framesDirty) {
            wsFrames = new Map(wsFrames);
            framesDirty = true;
          }
          let arr = wsFrames.get(requestId);
          if (!arr) {
            if (wsFrames.size >= MAX_FRAME_CONNECTIONS) {
              const oldest = wsFrames.keys().next().value;
              if (oldest !== undefined) wsFrames.delete(oldest);
            }
            arr = [];
            wsFrames.set(requestId, arr);
            framesTouched.add(requestId);
          } else if (!framesTouched.has(requestId)) {
            arr = [...arr];
            wsFrames.set(requestId, arr);
            framesTouched.add(requestId);
          }
          return arr;
        };
        const pushConsole = (e: ConsoleEntry) => {
          if (!consoleDirty) {
            consoleArr = [...consoleArr];
            consoleDirty = true;
          }
          consoleArr.push(e);
        };

        for (const { method, params } of items) {
          const pAny = params as Record<string, unknown>;
          switch (method) {
            /* DOM */
            case 'DOM.setChildNodes': {
              ensureDom();
              const parentId = pAny.parentId as NodeId;
              const kids = (pAny.nodes as CdpNode[]) ?? [];
              for (const k of kids) indexNode(k, nodes, childIds);
              childIds.set(
                parentId,
                kids.map((k) => k.nodeId),
              );
              break;
            }
            case 'DOM.childNodeInserted': {
              ensureDom();
              const parentId = pAny.parentNodeId as NodeId;
              const prev = pAny.previousNodeId as NodeId;
              const node = pAny.node as CdpNode;
              indexNode(node, nodes, childIds);
              const list = [...(childIds.get(parentId) ?? [])];
              const at = prev === 0 ? 0 : list.indexOf(prev) + 1;
              list.splice(at, 0, node.nodeId);
              childIds.set(parentId, list);
              break;
            }
            case 'DOM.childNodeRemoved': {
              ensureDom();
              const parentId = pAny.parentNodeId as NodeId;
              const nodeId = pAny.nodeId as NodeId;
              const list = (childIds.get(parentId) ?? []).filter((x) => x !== nodeId);
              childIds.set(parentId, list);
              nodes.delete(nodeId);
              break;
            }
            case 'DOM.attributeModified': {
              ensureDom();
              const nodeId = pAny.nodeId as NodeId;
              const node = nodes.get(nodeId);
              if (node) {
                nodes.set(nodeId, {
                  ...node,
                  attributes: setAttr(
                    node.attributes,
                    pAny.name as string,
                    pAny.value as string,
                  ),
                });
              }
              break;
            }
            case 'DOM.attributeRemoved': {
              ensureDom();
              const nodeId = pAny.nodeId as NodeId;
              const node = nodes.get(nodeId);
              if (node) {
                nodes.set(nodeId, {
                  ...node,
                  attributes: removeAttr(node.attributes, pAny.name as string),
                });
              }
              break;
            }
            case 'DOM.childNodeCountUpdated': {
              ensureDom();
              const nodeId = pAny.nodeId as NodeId;
              const node = nodes.get(nodeId);
              if (node) {
                nodes.set(nodeId, {
                  ...node,
                  childNodeCount: pAny.childNodeCount as number,
                });
              }
              break;
            }
            case 'DOM.documentUpdated': {
              // Major DOM swap (e.g. document.write) without a frame nav.
              effects.push(() => void get().refreshDocument());
              break;
            }
            case 'Page.frameNavigated': {
              // Main frame only — subframes/ad-iframes carry a parentId and must
              // not thrash the session (§11.3). Re-enable domains + clear stale
              // per-page state for the new document.
              const frame = pAny.frame as { parentId?: string } | undefined;
              if (frame && frame.parentId === undefined) {
                effects.push(() => get()._handleNavigated());
              }
              break;
            }
            case 'Page.domContentEventFired': {
              domContent = pAny.timestamp as number;
              break;
            }
            case 'Page.loadEventFired': {
              load = pAny.timestamp as number;
              break;
            }

            /* Overlay (element picker) */
            case 'Overlay.inspectNodeRequested': {
              const backendNodeId = pAny.backendNodeId as number;
              effects.push(() => void get()._finishPick(backendNodeId));
              break;
            }

            /* CSS (stylesheet headers for the source-patch hook §9-B) */
            case 'CSS.styleSheetAdded': {
              ensureSheets();
              const h = pAny.header as {
                styleSheetId: string;
                sourceURL?: string;
                origin: string;
                isInline?: boolean;
              };
              styleSheets.set(h.styleSheetId, {
                styleSheetId: h.styleSheetId,
                sourceURL: h.sourceURL ?? '',
                origin: h.origin,
                isInline: !!h.isInline,
              });
              break;
            }
            case 'CSS.styleSheetRemoved': {
              ensureSheets();
              styleSheets.delete(pAny.styleSheetId as string);
              break;
            }

            /* Console */
            case 'Runtime.consoleAPICalled': {
              pushConsole({
                id: entryId(),
                kind: consoleKindFromApi(pAny.type as string),
                args: (pAny.args as RemoteObject[]) ?? [],
                timestamp: (pAny.timestamp as number) || Date.now(),
                stackTrace: pAny.stackTrace as ConsoleEntry['stackTrace'],
              });
              break;
            }
            case 'Runtime.exceptionThrown': {
              const det = pAny.exceptionDetails as {
                text: string;
                exception?: RemoteObject;
                lineNumber?: number;
                url?: string;
                stackTrace?: ConsoleEntry['stackTrace'];
              };
              pushConsole({
                id: entryId(),
                kind: 'exception',
                args: det.exception ? [det.exception] : [],
                text: det.exception ? undefined : det.text,
                timestamp: (pAny.timestamp as number) || Date.now(),
                stackTrace: det.stackTrace,
                url: det.url,
                lineNumber: det.lineNumber,
              });
              break;
            }
            case 'Log.entryAdded': {
              const entry = pAny.entry as {
                level: string;
                text: string;
                timestamp?: number;
                url?: string;
                lineNumber?: number;
              };
              pushConsole({
                id: entryId(),
                kind: consoleKindFromLog(entry.level),
                args: [],
                text: entry.text,
                timestamp: entry.timestamp || Date.now(),
                url: entry.url,
                lineNumber: entry.lineNumber,
              });
              break;
            }

            /* Network */
            case 'Network.requestWillBeSent': {
              ensureNet();
              const requestId = pAny.requestId as string;
              const req = pAny.request as {
                url: string;
                method: string;
                headers: Record<string, string>;
                postData?: string;
                hasPostData?: boolean;
              };
              const requestPostData = boundedNetworkPayload(req.postData);
              const entry: NetworkEntry = {
                requestId,
                url: req.url,
                method: req.method,
                resourceType: pAny.type as string | undefined,
                startTime: pAny.timestamp as number,
                wallTime:
                  typeof pAny.wallTime === 'number' ? pAny.wallTime * 1000 : undefined,
                requestHeaders: req.headers,
                requestPostData: requestPostData?.text,
                requestPostDataTruncated: requestPostData?.truncated,
                initiator: pAny.initiator as NetworkEntry['initiator'],
              };
              // First request of the document is the navigation baseline the
              // waterfall + DOMContentLoaded/Load offsets are measured against.
              if (navStart === null) navStart = entry.startTime;
              const idx = netIndex!.get(requestId);
              if (idx === undefined) {
                netIndex!.set(requestId, network.length);
                network.push(entry);
              } else {
                network[idx] = { ...network[idx], ...entry };
              }
              const tabId = get().tabId;
              if (tabId && req.hasPostData && !req.postData) {
                effects.push(() => {
                  void cdpTry<{ postData: string }>(tabId, 'Network.getRequestPostData', { requestId }).then((res) => {
                    const loaded = boundedNetworkPayload(res?.postData);
                    if (!loaded) return;
                    set((current) => {
                      if (current.tabId !== tabId) return {};
                      const updateIndex = current.network.findIndex((item) => item.requestId === requestId);
                      if (updateIndex < 0) return {};
                      const next = [...current.network];
                      const currentEntry = next[updateIndex];
                      if (!currentEntry) return {};
                      next[updateIndex] = {
                        ...currentEntry,
                        requestPostData: loaded.text,
                        requestPostDataTruncated: loaded.truncated,
                      };
                      return { network: next };
                    });
                  });
                });
              }
              break;
            }
            case 'Network.responseReceived': {
              ensureNet();
              const requestId = pAny.requestId as string;
              const resp = pAny.response as {
                status: number;
                statusText: string;
                headers: Record<string, string>;
                mimeType: string;
                fromDiskCache?: boolean;
                remoteIPAddress?: string;
                timing?: NetworkEntry['timing'];
              };
              const idx = netIndex!.get(requestId);
              if (idx !== undefined) {
                network[idx] = {
                  ...network[idx],
                  status: resp.status,
                  statusText: resp.statusText,
                  responseHeaders: resp.headers,
                  mimeType: resp.mimeType,
                  fromCache: resp.fromDiskCache,
                  remoteIPAddress: resp.remoteIPAddress,
                  timing: resp.timing ?? network[idx].timing,
                  resourceType: (pAny.type as string) ?? network[idx].resourceType,
                };
              }
              break;
            }
            case 'Network.loadingFinished': {
              ensureNet();
              const requestId = pAny.requestId as string;
              const idx = netIndex!.get(requestId);
              if (idx !== undefined) {
                network[idx] = {
                  ...network[idx],
                  endTime: pAny.timestamp as number,
                  encodedDataLength: pAny.encodedDataLength as number,
                };
              }
              break;
            }
            case 'Network.loadingFailed': {
              ensureNet();
              const requestId = pAny.requestId as string;
              const idx = netIndex!.get(requestId);
              if (idx !== undefined) {
                network[idx] = {
                  ...network[idx],
                  endTime: pAny.timestamp as number,
                  failed: true,
                  errorText: pAny.errorText as string,
                };
              }
              break;
            }

            /* WebSocket / SSE (Frames tab). WS connections never emit
               requestWillBeSent — webSocketCreated seeds the row, the handshake
               events fill in timing/headers/status, frames go to the per-
               connection ring buffer. SSE rides a normal request row (resource-
               type EventSource); only its messages land here. */
            case 'Network.webSocketCreated': {
              ensureNet();
              const requestId = pAny.requestId as string;
              const entry: NetworkEntry = {
                requestId,
                url: pAny.url as string,
                method: 'GET',
                resourceType: 'WebSocket',
                // Placeholder until webSocketWillSendHandshakeRequest delivers
                // the real timestamp (it follows within the same connection).
                startTime: navStart ?? 0,
                initiator: pAny.initiator as NetworkEntry['initiator'],
              };
              const idx = netIndex!.get(requestId);
              if (idx === undefined) {
                netIndex!.set(requestId, network.length);
                network.push(entry);
              } else {
                network[idx] = { ...network[idx], ...entry };
              }
              break;
            }
            case 'Network.webSocketWillSendHandshakeRequest': {
              ensureNet();
              const idx = netIndex!.get(pAny.requestId as string);
              if (idx !== undefined) {
                const req = pAny.request as { headers: Record<string, string> };
                network[idx] = {
                  ...network[idx],
                  startTime: pAny.timestamp as number,
                  wallTime:
                    typeof pAny.wallTime === 'number' ? pAny.wallTime * 1000 : undefined,
                  requestHeaders: req.headers,
                };
              }
              break;
            }
            case 'Network.webSocketHandshakeResponseReceived': {
              ensureNet();
              const idx = netIndex!.get(pAny.requestId as string);
              if (idx !== undefined) {
                const resp = pAny.response as {
                  status: number;
                  statusText: string;
                  headers: Record<string, string>;
                  requestHeaders?: Record<string, string>;
                };
                network[idx] = {
                  ...network[idx],
                  status: resp.status,
                  statusText: resp.statusText,
                  responseHeaders: resp.headers,
                  requestHeaders: resp.requestHeaders ?? network[idx].requestHeaders,
                };
              }
              break;
            }
            case 'Network.webSocketFrameSent':
            case 'Network.webSocketFrameReceived': {
              const frame = pAny.response as { opcode: number; payloadData: string };
              pushFrame(
                framesFor(pAny.requestId as string),
                makeWsFrame(
                  method === 'Network.webSocketFrameSent' ? 'sent' : 'received',
                  frame.opcode,
                  frame.payloadData,
                  pAny.timestamp as number,
                ),
              );
              break;
            }
            case 'Network.webSocketFrameError': {
              ensureNet();
              const idx = netIndex!.get(pAny.requestId as string);
              if (idx !== undefined) {
                network[idx] = {
                  ...network[idx],
                  failed: true,
                  errorText: pAny.errorMessage as string,
                };
              }
              break;
            }
            case 'Network.webSocketClosed': {
              ensureNet();
              const idx = netIndex!.get(pAny.requestId as string);
              if (idx !== undefined) {
                network[idx] = { ...network[idx], endTime: pAny.timestamp as number };
              }
              break;
            }
            case 'Network.eventSourceMessageReceived': {
              pushFrame(
                framesFor(pAny.requestId as string),
                makeSseFrame(
                  pAny.eventName as string,
                  pAny.data as string,
                  pAny.timestamp as number,
                ),
              );
              break;
            }
          }
        }

        if (netDirty && network.length > MAX_NETWORK) {
          network = network.slice(network.length - MAX_NETWORK);
        }
        if (consoleDirty && consoleArr.length > MAX_CONSOLE) {
          consoleArr = consoleArr.slice(consoleArr.length - MAX_CONSOLE);
        }

        const next: Partial<DevtoolsState> = {};
        if (domDirty) {
          next.nodes = nodes;
          next.childIds = childIds;
        }
        if (consoleDirty) next.console = consoleArr;
        if (netDirty) next.network = network;
        if (framesDirty) next.wsFrames = wsFrames;
        if (sheetsDirty) next.styleSheets = styleSheets;
        if (navStart !== s.navStartTime) next.navStartTime = navStart;
        if (domContent !== s.domContentTime) next.domContentTime = domContent;
        if (load !== s.loadTime) next.loadTime = load;
        if (dropped) next.dropped = s.dropped + dropped;
        return next;
      });
      for (const fn of effects) fn();
}
