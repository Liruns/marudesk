import { register } from 'node:module';

/**
 * Registers the harness's `.ts`-extension resolve hook (./harness-loader.mjs) on
 * the module loader before the harness entry runs. Used only via the
 * `harness:server` npm script — see ./harness-loader.mjs for the why.
 */
register('./harness-loader.mjs', import.meta.url);
