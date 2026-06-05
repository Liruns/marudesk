import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import type { BrowserNativeMenuItem } from '../../shared/browser';

type NativePopupMenu = {
  readonly popup: (options: {
    readonly window: BrowserWindow;
    readonly x: number;
    readonly y: number;
    readonly callback: () => void;
  }) => void;
};

export type NativeMenuBuilder = (template: MenuItemConstructorOptions[]) => NativePopupMenu;

export function isNativeMenuSeparator(
  item: BrowserNativeMenuItem,
): item is Extract<BrowserNativeMenuItem, { readonly type: 'separator' }> {
  return 'type' in item && item.type === 'separator';
}

export function toElectronAccelerator(shortcut: string | undefined): string | undefined {
  switch (shortcut) {
    case 'Ctrl+F':
      return 'CommandOrControl+F';
    case 'Ctrl+J':
      return 'CommandOrControl+J';
    case 'Ctrl+R':
      return 'CommandOrControl+R';
    case 'Ctrl+Shift+R':
      return 'CommandOrControl+Shift+R';
    case 'Ctrl++':
      return 'CommandOrControl+Plus';
    case 'Ctrl+-':
      return 'CommandOrControl+-';
    case 'Ctrl+0':
      return 'CommandOrControl+0';
    case 'Esc':
      return 'Esc';
    case 'F12':
      return 'F12';
    default:
      return undefined;
  }
}

export function nativeMenuTemplate(
  items: readonly BrowserNativeMenuItem[],
  onSelect: (id: string) => void,
): MenuItemConstructorOptions[] {
  return items.map((item) => {
    if (isNativeMenuSeparator(item)) return { type: 'separator' };
    return {
      id: item.id,
      label: item.label,
      enabled: item.enabled ?? true,
      accelerator: toElectronAccelerator(item.shortcut),
      click: () => onSelect(item.id),
    };
  });
}

export function popupNativeMenu(params: {
  readonly window: BrowserWindow;
  readonly x: number;
  readonly y: number;
  readonly items: readonly BrowserNativeMenuItem[];
  readonly buildFromTemplate: NativeMenuBuilder;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let selected: string | null = null;
    const template = nativeMenuTemplate(params.items, (id) => {
      selected = id;
    });
    params.buildFromTemplate(template).popup({
      window: params.window,
      x: Math.round(params.x),
      y: Math.round(params.y),
      callback: () => resolve(selected),
    });
  });
}
