import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverLocalSshConfigConnections } from './config-discovery.ts';

let passed = 0;

function ok(label: string): void {
  passed += 1;
  console.log(`ok ${passed}: ${label}`);
}

function withTempHome(fn: (home: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-ssh-config-'));
  try {
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

withTempHome((home) => {
  const keyPath = path.join(home, '.ssh', 'id_ed25519');
  const includeDir = path.join(home, '.ssh', 'config.d');
  fs.writeFileSync(keyPath, 'not-a-real-key');
  fs.mkdirSync(includeDir, { recursive: true });
  fs.writeFileSync(
    path.join(includeDir, 'prod.conf'),
    ['Host prod', '  HostName prod.example.com', '  User admin'].join('\n'),
  );
  fs.writeFileSync(
    path.join(home, '.ssh', 'config'),
    [
      'Include ~/.ssh/config.d/*',
      '',
      'Host devbox',
      '  HostName dev.example.com',
      '  User ubuntu',
      '  Port 2222',
      '  IdentityFile ~/.ssh/id_ed25519',
      '',
      'Host staging staging-api',
      '  HostName staging.internal',
      '  User deploy',
      '',
      'Host *',
      '  User ignored-list-entry',
    ].join('\n'),
  );

  const connections = discoverLocalSshConfigConnections({
    homeDir: home,
    localUsername: 'local-user',
  });

  assert.deepEqual(
    connections.map((conn) => conn.info.label),
    ['prod', 'devbox', 'staging', 'staging-api'],
  );
  ok('lists concrete Host aliases, included files, and excludes wildcard Host blocks');

  const devbox = connections.find((conn) => conn.info.label === 'devbox');
  assert.ok(devbox);
  assert.equal(devbox.info.host, 'dev.example.com');
  assert.equal(devbox.info.username, 'ubuntu');
  assert.equal(devbox.info.port, 2222);
  assert.equal(devbox.auth.method, 'key');
  if (devbox.auth.method === 'key') {
    assert.equal(devbox.auth.privateKeyPath, keyPath);
  }
  assert.equal(devbox.info.authMethod, 'key');
  assert.equal(devbox.info.source, 'ssh-config');
  assert.equal(devbox.info.connected, false);
  assert.equal(devbox.info.id.includes('/'), false);
  ok('resolves host, user, port, key auth, source, and safe deterministic id');

  const staging = connections.find((conn) => conn.info.label === 'staging');
  assert.ok(staging);
  assert.equal(staging.info.host, 'staging.internal');
  assert.equal(staging.info.username, 'deploy');
  assert.equal(staging.info.port, 22);
  assert.equal(staging.auth.method, 'agent');
  ok('defaults missing port to 22 and missing key to agent auth');

  const prod = connections.find((conn) => conn.info.label === 'prod');
  assert.ok(prod);
  assert.equal(prod.info.host, 'prod.example.com');
  assert.equal(prod.info.username, 'admin');
  ok('discovers hosts from Include files');
});

console.log(`\nssh config discovery harness: ${passed} assertions passed`);
