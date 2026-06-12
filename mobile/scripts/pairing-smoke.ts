import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { runPairing } from '../src/auth/pairing.ts';
import {
  E2E_VERSION,
  b64urlToBytes,
  bytesToB64url,
  deriveSharedSecret,
  encodeQrPayload,
  generateKeyPair,
  importAesKey,
  resAad,
  seal,
  verifyPairProof,
  type PairRequestBody,
} from '../src/lib/e2e.ts';

let failures = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${msg}`);
  }
}

function fail(msg: string): void {
  failures += 1;
  console.error(`FAIL  ${msg}`);
}

async function expectReject(label: string, run: () => Promise<unknown>, expectedText: string): Promise<void> {
  try {
    await run();
    fail(`${label} should reject`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert(message.includes(expectedText), `${label} surfaces "${expectedText}"`);
  }
}

async function withFetchProbe(run: (getCalls: () => number) => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const probe: typeof fetch = async () => {
    calls += 1;
    throw new Error('fetch should not have been called');
  };
  globalThis.fetch = probe;
  try {
    await run(() => calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

type PairServer = {
  readonly url: string;
  readonly getRequestCount: () => number;
  readonly close: () => Promise<void>;
};

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function startPairServer(
  handlePair: (body: PairRequestBody, req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<PairServer> {
  let requestCount = 0;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/pair') {
        res.writeHead(404).end();
        return;
      }
      requestCount += 1;
      const body = (await readJsonBody(req)) as PairRequestBody;
      await handlePair(body, req, res);
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    getRequestCount: () => requestCount,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function makeQr(pcPub: Uint8Array, code: string, urls: readonly { label: string; url: string }[], exp: number): string {
  return encodeQrPayload({
    v: E2E_VERSION,
    code,
    pcPub: bytesToB64url(pcPub),
    urls: [...urls],
    name: 'Desk',
    exp,
  });
}

async function testValidPairing(): Promise<void> {
  const pc = await generateKeyPair();
  const code = 'pair-code-1';
  const expectedDeviceId = 'device-123';
  const server = await startPairServer(async (body, req, res) => {
    assert(req.headers['content-type'] === 'application/json', 'pairing posts JSON');
    assert(body.code === code, 'pairing request carries the QR code');
    assert(body.deviceName === 'Pixel 9', 'pairing request carries the device name');

    const keyBytes = await deriveSharedSecret(pc.privateKey, b64urlToBytes(body.phPub), code);
    const key = await importAesKey(keyBytes);
    const proofOk = await verifyPairProof(key, code, body.proof);
    assert(proofOk, 'pairing proof verifies on the fake PC');

    const result = await seal(key, { deviceId: expectedDeviceId }, resAad('/pair'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  });

  try {
    const qr = makeQr(
      pc.publicKeyRaw,
      code,
      [
        { label: 'offline', url: 'http://127.0.0.1:1' },
        { label: 'local', url: server.url },
      ],
      Date.now() + 60_000,
    );

    const creds = await runPairing(qr, 'Pixel 9');
    assert(creds.baseUrl === server.url, 'pairing returns the reachable base URL');
    assert(creds.deviceId === expectedDeviceId, 'pairing returns the sealed device id');
    assert(creds.keyB64.length > 0, 'pairing returns a non-empty session key');
    assert(server.getRequestCount() === 1, 'reachable PC receives exactly one /pair request');
    assert(
      JSON.stringify(creds.urls) === JSON.stringify([server.url, 'http://127.0.0.1:1']),
      'pairing returns every candidate URL with the answering one first',
    );
  } finally {
    await server.close();
  }
}

async function testTunnelUrl(): Promise<void> {
  const pc = await generateKeyPair();
  const code = 'pair-code-tunnel';
  const server = await startPairServer(async (body, _req, res) => {
    const keyBytes = await deriveSharedSecret(pc.privateKey, b64urlToBytes(body.phPub), code);
    const key = await importAesKey(keyBytes);
    const result = await seal(key, { deviceId: 'device-tunnel' }, resAad('/pair'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  });

  try {
    // The QR only carries an unreachable LAN candidate; the user-supplied tunnel
    // URL (with a trailing slash to exercise normalization) is tried FIRST and wins.
    const qr = makeQr(
      pc.publicKeyRaw,
      code,
      [{ label: 'lan', url: 'http://127.0.0.1:1' }],
      Date.now() + 60_000,
    );
    const creds = await runPairing(qr, 'Pixel 9', `${server.url}/`);
    assert(creds.baseUrl === server.url, 'a user tunnel URL is tried first and normalized');
    assert(
      JSON.stringify(creds.urls) === JSON.stringify([server.url, 'http://127.0.0.1:1']),
      'the tunnel URL joins the failover candidates ahead of the QR ones',
    );
    assert(server.getRequestCount() === 1, 'the tunnel endpoint receives exactly one /pair request');
  } finally {
    await server.close();
  }
}

async function testInvalidQr(): Promise<void> {
  await withFetchProbe(async (getCalls) => {
    await expectReject(
      'invalid QR',
      () => runPairing('not-a-marudesk-qr', 'Pixel 9'),
      'That isn’t a valid marudesk pairing QR.',
    );
    assert(getCalls() === 0, 'invalid QR is rejected before any network request');
  });
}

async function testShortCodePaste(): Promise<void> {
  await withFetchProbe(async (getCalls) => {
    // The 8-char check code shown beside the desktop QR can't pair on its own;
    // the error must point at "Copy pairing code" rather than a generic failure.
    for (const paste of ['ABCD2345', 'abcd-2345', ' AB CD 23 45 ']) {
      await expectReject(
        `short-code paste "${paste}"`,
        () => runPairing(paste, 'Pixel 9'),
        'Copy pairing code',
      );
    }
    assert(getCalls() === 0, 'a short-code paste is rejected before any network request');
  });
}

async function testWhitespaceMangledPaste(): Promise<void> {
  const pc = await generateKeyPair();
  const code = 'pair-code-ws';
  const server = await startPairServer(async (body, _req, res) => {
    const keyBytes = await deriveSharedSecret(pc.privateKey, b64urlToBytes(body.phPub), code);
    const key = await importAesKey(keyBytes);
    const result = await seal(key, { deviceId: 'device-ws' }, resAad('/pair'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  });

  try {
    const qr = makeQr(pc.publicKeyRaw, code, [{ label: 'local', url: server.url }], Date.now() + 60_000);
    // A payload copied through a chat app / terminal often gains line wraps —
    // pairing must strip ALL whitespace, not just trim the ends.
    const mangled = `  ${qr.slice(0, 40)}\n${qr.slice(40, 120)} \n ${qr.slice(120)}  `;
    const creds = await runPairing(mangled, 'Pixel 9');
    assert(creds.deviceId === 'device-ws', 'a whitespace-mangled payload still pairs');
  } finally {
    await server.close();
  }
}

async function testExpiredQr(): Promise<void> {
  const pc = await generateKeyPair();
  await withFetchProbe(async (getCalls) => {
    const qr = makeQr(
      pc.publicKeyRaw,
      'expired-code',
      [{ label: 'local', url: 'http://127.0.0.1:1' }],
      Date.now() - 1,
    );
    await expectReject(
      'expired QR',
      () => runPairing(qr, 'Pixel 9'),
      'This pairing code expired',
    );
    assert(getCalls() === 0, 'expired QR is rejected before any network request');
  });
}

async function testServerError(): Promise<void> {
  const pc = await generateKeyPair();
  const server = await startPairServer(async (_body, _req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Pairing code was denied' }));
  });

  try {
    const qr = makeQr(
      pc.publicKeyRaw,
      'denied-code',
      [{ label: 'local', url: server.url }],
      Date.now() + 60_000,
    );
    await expectReject(
      'server-side denial',
      () => runPairing(qr, 'Pixel 9'),
      'Pairing code was denied',
    );
    assert(server.getRequestCount() === 1, 'denied pairing still reaches the PC once');
  } finally {
    await server.close();
  }
}

async function testNoUrls(): Promise<void> {
  const pc = await generateKeyPair();
  await withFetchProbe(async (getCalls) => {
    const qr = makeQr(pc.publicKeyRaw, 'no-urls', [], Date.now() + 60_000);
    await expectReject(
      'QR without URLs',
      () => runPairing(qr, 'Pixel 9'),
      'The QR had no addresses to connect to.',
    );
    assert(getCalls() === 0, 'QR without URLs does not attempt any network request');
  });
}

async function main(): Promise<void> {
  await testValidPairing();
  await testTunnelUrl();
  await testInvalidQr();
  await testShortCodePaste();
  await testWhitespaceMangledPaste();
  await testExpiredQr();
  await testServerError();
  await testNoUrls();

  console.log(
    failures === 0 ? '\nMOBILE PAIRING SMOKE: PASS' : `\nMOBILE PAIRING SMOKE: FAIL (${failures})`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
