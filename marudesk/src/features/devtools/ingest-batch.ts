import type { StoreApi } from 'zustand';
import { cdpTry } from './cdp';
import { indexNode, setAttr, removeAttr } from './dom-index';
import { consoleKindFromApi, consoleKindFromLog } from './console-kind';
import {
  boundedFramePayload,
  boundedNetworkPayload,
  entryId,
  MAX_CONSOLE,
  MAX_NETWORK,
  MAX_SCRIPTS,
  MAX_STREAM_MESSAGES,
} from './store-internals';
import { isInternalScriptUrl } from './sources-utils';
import type {
  CdpNode,
  ConsoleEntry,
  NetworkEntry,
  NodeId,
  RemoteObject,
  ScriptInfo,
  SwRegistration,
  SwVersion,
  WsFrame,
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
        let styleSheets = s.styleSheets;
        let sheetsDirty = false;
        let scripts = s.scripts;
        let scriptsDirty = false;
        let swRegs = s.swRegistrations;
        let swVers = s.swVersions;
        let swDirty = false;
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
        const ensureScripts = () => {
          if (!scriptsDirty) {
            scripts = new Map(scripts);
            scriptsDirty = true;
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
        const pushConsole = (e: ConsoleEntry) => {
          if (!consoleDirty) {
            consoleArr = [...consoleArr];
            consoleDirty = true;
          }
          consoleArr.push(e);
        };
        const ensureSw = () => {
          if (!swDirty) {
            swRegs = new Map(swRegs);
            swVers = new Map(swVers);
            swDirty = true;
          }
        };
        // Append one WS frame to its connection's row, dropping the oldest past
        // the per-connection cap (the Messages tab surfaces the dropped count).
        const pushWsFrame = (requestId: string, frame: WsFrame) => {
          ensureNet();
          const idx = netIndex!.get(requestId);
          if (idx === undefined) return;
          const e = network[idx];
          const frames = [...(e.frames ?? []), frame];
          let droppedFrames = e.framesDropped ?? 0;
          if (frames.length > MAX_STREAM_MESSAGES) {
            droppedFrames += frames.length - MAX_STREAM_MESSAGES;
            frames.splice(0, frames.length - MAX_STREAM_MESSAGES);
          }
          network[idx] = {
            ...e,
            frames,
            framesDropped: droppedFrames || undefined,
          };
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

            /* Debugger (Sources) */
            case 'Debugger.scriptParsed': {
              const scriptId = pAny.scriptId as string;
              const url = pAny.url as string | undefined;
              // Skip eval/internal scripts (no url / extension scheme) and stop
              // growing past the cap — a heavy SPA can parse thousands.
              if (!scriptId || !url || isInternalScriptUrl(url)) break;
              if (scripts.size >= MAX_SCRIPTS && !scripts.has(scriptId)) break;
              ensureScripts();
              const info: ScriptInfo = { scriptId, url };
              scripts.set(scriptId, info);
              break;
            }
            case 'Debugger.paused': {
              // Post-commit effect: the pause handler selects + fetches the top
              // frame's script (Debugger/Runtime only — safe while paused).
              const pausedParams = params;
              effects.push(() => get()._handlePaused(pausedParams));
              break;
            }
            case 'Debugger.resumed': {
              effects.push(() => get()._handleResumed());
              break;
            }

            /* Security */
            case 'Security.visibleSecurityStateChanged': {
              // Post-commit effect: parsed through a typed guard in
              // slice-security (the wire shape is validated there, not here).
              const securityParams = params;
              effects.push(() => get()._handleSecurityState(securityParams));
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

            /* Network: WebSockets + SSE */
            case 'Network.webSocketCreated': {
              ensureNet();
              const requestId = pAny.requestId as string;
              const entry: NetworkEntry = {
                requestId,
                url: pAny.url as string,
                method: 'GET',
                resourceType: 'WebSocket',
                isWebSocket: true,
                // This event carries no timestamp — anchor to the navigation
                // baseline until webSocketWillSendHandshakeRequest refines it,
                // so the shared waterfall window isn't dragged to 0.
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
              const requestId = pAny.requestId as string;
              const idx = netIndex!.get(requestId);
              if (idx !== undefined) {
                const req = pAny.request as { headers: Record<string, string> };
                network[idx] = {
                  ...network[idx],
                  startTime: pAny.timestamp as number,
                  wallTime:
                    typeof pAny.wallTime === 'number' ? pAny.wallTime * 1000 : undefined,
                  requestHeaders: req?.headers ?? network[idx].requestHeaders,
                };
              }
              break;
            }
            case 'Network.webSocketHandshakeResponseReceived': {
              ensureNet();
              const requestId = pAny.requestId as string;
              const idx = netIndex!.get(requestId);
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
              const resp = pAny.response as { opcode: number; payloadData: string };
              if (!resp) break;
              const direction =
                method === 'Network.webSocketFrameSent' ? 'sent' : 'received';
              // Binary frames (opcode 2) arrive base64-encoded — keep only the
              // decoded size, not the payload (the tab shows a length note).
              if (resp.opcode === 2) {
                const b64 = resp.payloadData ?? '';
                const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
                pushWsFrame(pAny.requestId as string, {
                  direction,
                  timestamp: pAny.timestamp as number,
                  opcode: resp.opcode,
                  payloadData: '',
                  payloadBytes: Math.max(0, Math.floor((b64.length * 3) / 4) - padding),
                });
              } else {
                const bounded = boundedFramePayload(resp.payloadData ?? '');
                pushWsFrame(pAny.requestId as string, {
                  direction,
                  timestamp: pAny.timestamp as number,
                  opcode: resp.opcode,
                  payloadData: bounded.text,
                  payloadTruncated: bounded.truncated || undefined,
                });
              }
              break;
            }
            case 'Network.webSocketFrameError': {
              pushWsFrame(pAny.requestId as string, {
                direction: 'error',
                timestamp: pAny.timestamp as number,
                opcode: -1,
                payloadData: (pAny.errorMessage as string) || 'WebSocket frame error',
              });
              break;
            }
            case 'Network.webSocketClosed': {
              ensureNet();
              const requestId = pAny.requestId as string;
              const idx = netIndex!.get(requestId);
              if (idx !== undefined) {
                network[idx] = { ...network[idx], endTime: pAny.timestamp as number };
              }
              break;
            }
            case 'Network.eventSourceMessageReceived': {
              ensureNet();
              const requestId = pAny.requestId as string;
              const idx = netIndex!.get(requestId);
              if (idx === undefined) break;
              const e = network[idx];
              const bounded = boundedFramePayload((pAny.data as string) ?? '');
              const messages = [
                ...(e.sseMessages ?? []),
                {
                  eventName: (pAny.eventName as string) ?? 'message',
                  eventId: (pAny.eventId as string) ?? '',
                  data: bounded.text,
                  dataTruncated: bounded.truncated || undefined,
                  timestamp: pAny.timestamp as number,
                },
              ];
              let droppedSse = e.sseDropped ?? 0;
              if (messages.length > MAX_STREAM_MESSAGES) {
                droppedSse += messages.length - MAX_STREAM_MESSAGES;
                messages.splice(0, messages.length - MAX_STREAM_MESSAGES);
              }
              network[idx] = {
                ...e,
                sseMessages: messages,
                sseDropped: droppedSse || undefined,
              };
              break;
            }

            /* Service workers (read-only registration/version status) */
            case 'ServiceWorker.workerRegistrationUpdated': {
              ensureSw();
              const regs = (pAny.registrations as SwRegistration[]) ?? [];
              for (const r of regs) {
                if (r.isDeleted) {
                  swRegs.delete(r.registrationId);
                  for (const [id, v] of swVers) {
                    if (v.registrationId === r.registrationId) swVers.delete(id);
                  }
                } else {
                  swRegs.set(r.registrationId, r);
                }
              }
              break;
            }
            case 'ServiceWorker.workerVersionUpdated': {
              ensureSw();
              const versions = (pAny.versions as SwVersion[]) ?? [];
              for (const v of versions) swVers.set(v.versionId, v);
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
        if (sheetsDirty) next.styleSheets = styleSheets;
        if (scriptsDirty) next.scripts = scripts;
        if (swDirty) {
          next.swRegistrations = swRegs;
          next.swVersions = swVers;
        }
        if (navStart !== s.navStartTime) next.navStartTime = navStart;
        if (domContent !== s.domContentTime) next.domContentTime = domContent;
        if (load !== s.loadTime) next.loadTime = load;
        if (dropped) next.dropped = s.dropped + dropped;
        return next;
      });
      for (const fn of effects) fn();
}
