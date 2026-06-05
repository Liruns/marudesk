import assert from 'node:assert/strict';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import type { BrowserNativeMenuItem } from '../../shared/browser';
import { nativeMenuTemplate, popupNativeMenu, toElectronAccelerator } from './native-menu.ts';

let passed = 0;

function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const selected: string[] = [];
const items: BrowserNativeMenuItem[] = [
  { id: 'find', label: 'Find', shortcut: 'Ctrl+F' },
  { type: 'separator' },
  { id: 'downloads', label: 'Downloads', enabled: false, shortcut: 'Ctrl+J' },
  { id: 'zoom-in', label: 'Zoom in', shortcut: 'Ctrl++' },
  { id: 'unknown', label: 'Unknown', shortcut: 'Ctrl+Alt+Nope' },
];

const template = nativeMenuTemplate(items, (id) => selected.push(id));

check('template keeps the same item count', template.length === items.length);
check('template maps separators', template[1]?.type === 'separator');
check('template preserves labels', template[0]?.label === 'Find');
check('template maps Ctrl+F to Electron accelerator', template[0]?.accelerator === 'CommandOrControl+F');
check('template preserves disabled items', template[2]?.enabled === false);
check('template maps Ctrl++ safely', template[3]?.accelerator === 'CommandOrControl+Plus');
check('template omits unknown accelerators', template[4]?.accelerator === undefined);

const findClick = (template[0] as MenuItemConstructorOptions).click;
check('click callback is wired for selectable items', typeof findClick === 'function');
findClick?.({} as never, undefined as never, {} as never);
check('click callback resolves the selected id', selected[0] === 'find');

check('accelerator helper maps F12', toElectronAccelerator('F12') === 'F12');
check('accelerator helper rejects unknown shortcuts', toElectronAccelerator('Ctrl+Alt+Nope') === undefined);

let popupTemplate: MenuItemConstructorOptions[] = [];
let popupOptions: { readonly x: number; readonly y: number } | null = null;
const selectedId = await popupNativeMenu({
  window: {} as BrowserWindow,
  x: 12.4,
  y: 9.6,
  items,
  buildFromTemplate: (builtTemplate) => {
    popupTemplate = builtTemplate;
    return {
      popup: (options) => {
        popupOptions = { x: options.x, y: options.y };
        builtTemplate[3]?.click?.({} as never, undefined as never, {} as never);
        options.callback();
      },
    };
  },
});
check('popup helper passes the native template to the builder', popupTemplate[1]?.type === 'separator');
check('popup helper rounds x/y coordinates for Electron', popupOptionsRounded(popupOptions));
check('popup helper resolves the clicked item id after callback', selectedId === 'zoom-in');

const dismissedId = await popupNativeMenu({
  window: {} as BrowserWindow,
  x: 0,
  y: 0,
  items,
  buildFromTemplate: () => ({
    popup: (options) => options.callback(),
  }),
});
check('popup helper resolves null when the menu is dismissed', dismissedId === null);

console.log(`\nbrowser native menu harness: ${passed} assertions passed`);

function popupOptionsRounded(options: { readonly x: number; readonly y: number } | null): boolean {
  return options !== null && options.x === 12 && options.y === 10;
}
