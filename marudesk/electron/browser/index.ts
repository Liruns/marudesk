/**
 * Public surface of the embedded-browser/tab subsystem. main.ts imports the
 * mount/dispose lifecycle and handler registration from here; the
 * implementation is split across this directory (state / layout / devtools /
 * inspect / context-menu / tabs / navigation / handlers).
 */
export { disposeBrowserView, mountBrowserView } from './tabs';
export { registerBrowserHandlers } from './handlers';
