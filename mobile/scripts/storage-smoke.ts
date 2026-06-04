import { StorageKeys, storageGet, storageRemove, storageSet } from '../src/auth/storage.ts';

let failures = 0;

type LocalStorageProbe = {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
};

function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${msg}`);
  }
}

function createLocalStorageProbe(): LocalStorageProbe {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
}

function installRuntimeProbe(preferencesAvailable: boolean, localStorage?: LocalStorageProbe): void {
  Object.assign(globalThis, {
    Capacitor: {
      isNativePlatform: () => true,
      isPluginAvailable: (pluginName: string) => pluginName === 'Preferences' && preferencesAvailable,
    },
    localStorage,
  });
}

async function main(): Promise<void> {
  installRuntimeProbe(false, createLocalStorageProbe());

  console.log('native Preferences unavailable -> fallback storage');
  assert((await storageGet(StorageKeys.relayUrl)) === null, 'missing key resolves to null');

  await storageSet(StorageKeys.relayUrl, 'http://relay.local:8788');
  assert(
    (await storageGet(StorageKeys.relayUrl)) === 'http://relay.local:8788',
    'fallback storage persists a value',
  );

  await storageRemove(StorageKeys.relayUrl);
  assert((await storageGet(StorageKeys.relayUrl)) === null, 'fallback storage removes a value');

  installRuntimeProbe(true, createLocalStorageProbe());

  console.log('\nnative Preferences operation rejects -> fallback storage');
  assert((await storageGet(StorageKeys.directBaseUrl)) === null, 'rejected native read resolves to null');

  await storageSet(StorageKeys.directBaseUrl, 'http://pc.local:38901');
  assert(
    (await storageGet(StorageKeys.directBaseUrl)) === 'http://pc.local:38901',
    'rejected native write falls back and remains readable',
  );

  await storageRemove(StorageKeys.directBaseUrl);
  assert((await storageGet(StorageKeys.directBaseUrl)) === null, 'rejected native remove clears fallback value');

  installRuntimeProbe(false);

  console.log('\nlocalStorage unavailable -> memo storage');
  await storageSet(StorageKeys.directDeviceId, 'phone-1');
  assert((await storageGet(StorageKeys.directDeviceId)) === 'phone-1', 'memo storage persists a value');

  await storageRemove(StorageKeys.directDeviceId);
  assert((await storageGet(StorageKeys.directDeviceId)) === null, 'memo storage removes a value');

  console.log(failures === 0 ? '\nSTORAGE SMOKE: PASS' : `\nSTORAGE SMOKE: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
