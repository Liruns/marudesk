// Pane — toolbar (chrome) entry. Wires the feature modules; each owns its own DOM
// and its own subscriptions to the window.pane bridge.
import { initTabs } from './features/tabs.js';
import { initNavigation } from './features/navigation.js';
import { initAddressBar } from './features/address-bar.js';
import { initLoadingBar } from './features/loading-bar.js';
import { initWindowControls } from './features/window-controls.js';
import { initWindowActive } from './features/window-active.js';
import { initMenu } from './features/menu.js';
import { initFind } from './features/find.js';
import { initCommandPalette } from './features/command-palette.js';
import { initToast } from './features/toast.js';

initTabs();
initNavigation();
initAddressBar();
initLoadingBar();
initWindowControls();
initWindowActive();
initMenu();
initFind();
initCommandPalette();
initToast();
