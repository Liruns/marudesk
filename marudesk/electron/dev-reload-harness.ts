import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { __test } from '../vite.config.ts';

async function main(): Promise<void> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });

  try {
    const before = child.listenerCount('error');

    __test.installClosedIpcErrorHandler(child);
    __test.installClosedIpcErrorHandler(child);

    assert.equal(child.listenerCount('error'), before + 1);
    assert.doesNotThrow(() => {
      child.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    });
    assert.throws(() => {
      child.emit('error', Object.assign(new Error('boom'), { code: 'EACCES' }));
    }, /boom/);
  } finally {
    child.kill();
    await once(child, 'exit');
  }
}

await main();
