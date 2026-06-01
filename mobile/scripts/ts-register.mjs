import { register } from 'node:module';

/** Registers the `.ts`-extension resolve hook before the smoke entry runs. */
register('./ts-resolve.mjs', import.meta.url);
