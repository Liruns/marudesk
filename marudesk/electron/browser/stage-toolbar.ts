import type { TabRecord } from './state';

/**
 * Floating in-page stage toolbar (docs/runtime-agent-absorption-2026-06.md §3.2,
 * stagewise pattern). A small pill injected into the live page with one action —
 * start the element picker and send the pick to the agent. It calls the always-
 * present inspect preload bridge (`window.__marudeskBridge.startInspect`), which
 * routes to the existing inspect → capture → agent flow, so this adds an in-page
 * entry point without a new channel. Module-level `enabled` so it re-injects
 * after navigation (did-finish-load). Self-contained injected string (no app
 * styles reach the page).
 */

const TOOLBAR_ID = '__marudesk_stage_toolbar';
let enabled = false;

export function isStageToolbarEnabled(): boolean {
  return enabled;
}
export function setStageToolbarEnabled(on: boolean): void {
  enabled = on;
}

/** The page-injected script that adds (on) or removes (off) the floating toolbar. */
export function buildStageToolbarScript(on: boolean): string {
  const id = JSON.stringify(TOOLBAR_ID);
  if (!on) {
    return `(function(){var e=document.getElementById(${id});if(e&&e.parentNode)e.parentNode.removeChild(e);})();`;
  }
  return `(function(){
    var ID=${id};
    if(document.getElementById(ID))return;
    var bar=document.createElement('div');
    bar.id=ID;
    bar.setAttribute('data-marudesk','stage-toolbar');
    bar.style.cssText='position:fixed;z-index:2147483646;bottom:16px;right:16px;display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:9999px;background:rgba(20,20,28,.92);box-shadow:0 4px 16px rgba(0,0,0,.4);font:500 12px system-ui,-apple-system,sans-serif;color:#fff;';
    var btn=document.createElement('button');
    btn.type='button';
    btn.textContent='\\u2316 Send element to agent';
    btn.style.cssText='all:unset;cursor:pointer;padding:2px 6px;border-radius:9999px;color:#fff;';
    btn.addEventListener('click',function(){try{var b=window.__marudeskBridge;if(b&&b.startInspect)b.startInspect();}catch(e){}});
    bar.appendChild(btn);
    (document.body||document.documentElement).appendChild(bar);
  })();`;
}

export function applyStageToolbar(rec: TabRecord, on: boolean): void {
  if (!rec.view) return;
  rec.view.webContents.executeJavaScript(buildStageToolbarScript(on), true).catch(() => undefined);
}

/** Re-inject after a navigation if the toolbar is currently enabled. */
export function reapplyStageToolbar(rec: TabRecord): void {
  if (enabled && rec.view) applyStageToolbar(rec, true);
}
