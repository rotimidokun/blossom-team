import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

// Isolate test data BEFORE importing app modules (store reads env at import time).
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'vending-')), 'db.json');
process.env.VENDING_API_KEY = 'test_vending_key';
delete process.env.NODE_ENV;
// Force mock image mode — tests never call a real image provider, never cost money.
process.env.MAE_MOCK = '1';
delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;

// Dynamic import on purpose: the env assignments above must run first.
const { startServer } = await import('../src/server.js');

let server: Server;
let base = '';

before(async () => {
  server = await startServer(0); // ephemeral port
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  base = `http://localhost:${port}`;
});

after(() => server.close());

interface CallOptions {
  body?: unknown;
  idempotencyKey?: string;
}

// `json` is typed any on purpose: assertions read many shapes off one payload,
// and the response envelope is validated field-by-field by each test.
async function call(method: string, path: string, { body, idempotencyKey }: CallOptions = {}) {
  const headers: Record<string, string> = { Authorization: 'Bearer test_vending_key' };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  return { http: res.status, json: (await res.json()) as any };
}

const wallet = () => call('GET', '/v1/wallet');

// --- auth ------------------------------------------------------------------

test('health endpoint needs no auth', async () => {
  const res = await fetch(base + '/health');
  assert.equal(res.status, 200);
  const json = (await res.json()) as any;
  assert.equal(json.status, true);
});

test('missing bearer token is 401 UNAUTHORIZED', async () => {
  const res = await fetch(base + '/v1/wallet');
  assert.equal(res.status, 401);
  const json = (await res.json()) as any;
  assert.equal(json.status, false);
  assert.equal(json.data.error.code, 'UNAUTHORIZED');
});

test('wrong key is 401 UNAUTHORIZED', async () => {
  const res = await fetch(base + '/v1/wallet', {
    headers: { Authorization: 'Bearer wrong_key' }
  });
  assert.equal(res.status, 401);
});

// --- the demo sequence: empty wallet -> fund -> spend ----------------------

test('wallet starts EMPTY (₦0) — funding is the first act', async () => {
  const { http, json } = await wallet();
  assert.equal(http, 200);
  assert.equal(json.data.balance, 0);
  assert.equal(json.data.currency, 'NGN');
});

test('purchase on an empty wallet is 402 INSUFFICIENT_WALLET', async () => {
  const { http, json } = await call('POST', '/v1/purchases/electricity', {
    body: { meter_number: '45123456789', disco: 'IKEDC', amount: 1000000 }
  });
  assert.equal(http, 402);
  assert.equal(json.data.error.code, 'INSUFFICIENT_WALLET');
});

test('bank transfer funds the wallet (made-up account, traced by reference)', async () => {
  const { http, json } = await call('POST', '/v1/wallet/incoming', {
    body: { amount: 5000000, reference: 'TRF-bank-001' } // ₦50,000
  });
  assert.equal(http, 200);
  assert.equal(json.data.source, 'bank_transfer');
  assert.equal(json.data.balance_after, 5000000);

  const after = await wallet();
  assert.equal(after.json.data.balance, 5000000);
});

test('same funding reference cannot be applied twice (409)', async () => {
  const { http, json } = await call('POST', '/v1/wallet/incoming', {
    body: { amount: 5000000, reference: 'TRF-bank-001' }
  });
  assert.equal(http, 409);
  assert.equal(json.data.error.code, 'IDEMPOTENT_REPLAY');
});

test('Paystack-funded top-up records its own reference', async () => {
  const { http, json } = await call('POST', '/v1/wallet/paystack-funded', {
    body: { amount: 2000000, paystack_reference: 'PSK-test-777' } // ₦20,000
  });
  assert.equal(http, 200);
  assert.equal(json.data.source, 'paystack');

  const after = await wallet();
  assert.equal(after.json.data.balance, 7000000); // 50k + 20k
});

test('funding without a reference is 422', async () => {
  const { http, json } = await call('POST', '/v1/wallet/incoming', {
    body: { amount: 100000 }
  });
  assert.equal(http, 422);
  assert.equal(json.data.error.code, 'VALIDATION_FAILED');
});

// --- validation ------------------------------------------------------------

test('valid meter returns registered owner name', async () => {
  const { http, json } = await call('POST', '/v1/validate/meter', {
    body: { meter_number: '45123456789', disco: 'IKEDC' }
  });
  assert.equal(http, 200);
  assert.equal(json.data.valid, true);
  assert.equal(json.data.owner_name, 'BLOSSOM BY TC LIMITED');
});

test('unknown meter is 400 INVALID_METER', async () => {
  const { http, json } = await call('POST', '/v1/validate/meter', {
    body: { meter_number: '00000000000', disco: 'IKEDC' }
  });
  assert.equal(http, 400);
  assert.equal(json.data.error.code, 'INVALID_METER');
});

test('missing fields is 422 VALIDATION_FAILED', async () => {
  const { http, json } = await call('POST', '/v1/validate/meter', { body: {} });
  assert.equal(http, 422);
  assert.equal(json.data.error.code, 'VALIDATION_FAILED');
});

test('invalid phone is 400 INVALID_PHONE', async () => {
  const { http, json } = await call('POST', '/v1/validate/phone', {
    body: { phone_number: '07000000000' }
  });
  assert.equal(http, 400);
  assert.equal(json.data.error.code, 'INVALID_PHONE');
});

// --- purchases (wallet now funded) -----------------------------------------

test('electricity purchase succeeds, debits wallet, returns token', async () => {
  const { http, json } = await call('POST', '/v1/purchases/electricity', {
    body: { meter_number: '45123456789', disco: 'IKEDC', amount: 1000000 } // ₦10,000
  });
  assert.equal(http, 200);
  assert.equal(json.data.status, 'success');
  assert.equal(json.data.amount, 1000000);
  assert.match(json.data.token, /^\d{4}-\d{4}-\d{4}-\d{4}-\d{4}$/);
  assert.equal(json.data.wallet_balance_after, 6000000); // 70k - 10k
});

test('disco outage is 503 DISCO_UNAVAILABLE (failure path demo)', async () => {
  const { http, json } = await call('POST', '/v1/purchases/electricity', {
    body: { meter_number: '11223344556', disco: 'EKEDC', amount: 500000 }
  });
  assert.equal(http, 503);
  assert.equal(json.data.error.code, 'DISCO_UNAVAILABLE');
});

test('amount above balance is 402 INSUFFICIENT_WALLET', async () => {
  const { http, json } = await call('POST', '/v1/purchases/electricity', {
    body: { meter_number: '45123456789', disco: 'IKEDC', amount: 999999999 }
  });
  assert.equal(http, 402);
  assert.equal(json.data.error.code, 'INSUFFICIENT_WALLET');
});

test('same Idempotency-Key never double-buys', async () => {
  const key = 'test-idem-key-1';
  const body = { meter_number: '45123456789', disco: 'IKEDC', amount: 200000 };

  const first = await call('POST', '/v1/purchases/electricity', { body, idempotencyKey: key });
  assert.equal(first.http, 200);
  assert.equal(first.json.data.replayed, undefined);

  const balanceAfterFirst = first.json.data.wallet_balance_after;

  const second = await call('POST', '/v1/purchases/electricity', { body, idempotencyKey: key });
  assert.equal(second.http, 200);
  assert.equal(second.json.data.replayed, true);
  assert.equal(second.json.data.id, first.json.data.id);
  assert.equal(second.json.data.wallet_balance_after, balanceAfterFirst); // wallet untouched
});

test('airtime purchase succeeds for a valid line', async () => {
  const walletBefore = (await wallet()).json.data.balance;
  const { http, json } = await call('POST', '/v1/purchases/airtime', {
    body: { phone_number: '08031234567', amount: 200000 }
  });
  assert.equal(http, 200);
  assert.equal(json.data.kind, 'airtime');
  assert.equal(json.data.network, 'MTN');
  assert.equal(json.data.wallet_balance_after, walletBefore - 200000);
});

test('airtime with wrong network is 400', async () => {
  const { http, json } = await call('POST', '/v1/purchases/airtime', {
    body: { phone_number: '08031234567', network: 'GLO', amount: 100000 }
  });
  assert.equal(http, 400);
  assert.equal(json.data.error.code, 'VALIDATION_FAILED');
});

// --- receipt lookup --------------------------------------------------------

test('purchase receipt retrievable by id; unknown id is 404', async () => {
  const list = await call('GET', '/v1/purchases');
  assert.equal(list.http, 200);
  const first = list.json.data.purchases[0];
  assert.ok(first, 'purchases should persist across requests');

  const found = await call('GET', `/v1/purchases/${first.id}`);
  assert.equal(found.http, 200);
  assert.equal(found.json.data.id, first.id);

  const missing = await call('GET', '/v1/purchases/pur_nope');
  assert.equal(missing.http, 404);
  assert.equal(missing.json.data.error.code, 'NOT_FOUND');
});

test('unknown route is 404 with envelope', async () => {
  const { http, json } = await call('GET', '/v1/nope');
  assert.equal(http, 404);
  assert.equal(json.status, false);
  assert.equal(json.data.error.code, 'NOT_FOUND');
});

// --- designs (Mae's approval queue, mock image mode) ------------------------

/**
 * Generation is ASYNC: POST answers in milliseconds with status "creating"
 * and the image is produced in the background (so a slow provider can never
 * hold an HTTP/MCP connection open). Tests poll until it settles.
 */
async function awaitDesignReady(id: string, tries = 80): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const { http, json } = await call('GET', `/v1/designs/${id}`);
    if (http === 200 && json.data.status !== 'creating') return json.data;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`design ${id} never finished creating`);
}

test('generate a design -> 201 creating immediately, then pending with image_url', async () => {
  const { http, json } = await call('POST', '/v1/designs/generate', {
    body: { kind: 'flyer', brief: 'June sale - 20% off all dresses' }
  });
  assert.equal(http, 201);
  assert.equal(json.data.status, 'creating'); // answers before the image exists
  assert.equal(json.data.kind, 'flyer');
  assert.equal(json.data.image_url, ''); // no link until ready
  assert.ok(json.data.prompt_used.includes('June sale'));

  const ready = await awaitDesignReady(json.data.id);
  assert.equal(ready.status, 'pending');
  assert.equal(ready.provider, 'mock');
  assert.match(ready.image_url, /^\/images\/des_[a-f0-9]+\.png$/);
});

test('generated image is served at /images (no auth)', async () => {
  const created = await call('POST', '/v1/designs/generate', {
    body: { kind: 'social', brief: 'New arrivals post' }
  });
  const ready = await awaitDesignReady(created.json.data.id);
  const res = await fetch(base + ready.image_url);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /image/);
});

test('generate without brief is 422 VALIDATION_FAILED', async () => {
  const { http, json } = await call('POST', '/v1/designs/generate', {
    body: { kind: 'flyer' }
  });
  assert.equal(http, 422);
  assert.equal(json.data.error.code, 'VALIDATION_FAILED');
});

test('generate with unknown kind is 422', async () => {
  const { http, json } = await call('POST', '/v1/designs/generate', {
    body: { kind: 'meme', brief: 'anything' }
  });
  assert.equal(http, 422);
  assert.equal(json.data.error.code, 'VALIDATION_FAILED');
});

test('approval queue filters by status=pending (creating designs excluded)', async () => {
  const created = await call('POST', '/v1/designs/generate', {
    body: { kind: 'slide', brief: 'Q3 deck cover' }
  });
  await awaitDesignReady(created.json.data.id);
  const queue = await call('GET', '/v1/designs?status=pending');
  assert.equal(queue.http, 200);
  const ids = queue.json.data.designs.map((d: any) => d.id);
  assert.ok(ids.includes(created.json.data.id));
  assert.ok(queue.json.data.designs.every((d: any) => d.status === 'pending'));
});

test('approve flips pending -> approved; approving twice is 409 INVALID_STATE', async () => {
  const created = await call('POST', '/v1/designs/generate', {
    body: { kind: 'flyer', brief: 'Easter special' }
  });
  const id = created.json.data.id;
  await awaitDesignReady(id); // approval only applies once the image exists

  const first = await call('POST', `/v1/designs/${id}/approve`);
  assert.equal(first.http, 200);
  assert.equal(first.json.data.status, 'approved');

  const second = await call('POST', `/v1/designs/${id}/approve`);
  assert.equal(second.http, 409);
  assert.equal(second.json.data.error.code, 'INVALID_STATE');
});

test('reject records a reason; rejected design leaves the pending queue', async () => {
  const created = await call('POST', '/v1/designs/generate', {
    body: { kind: 'model-shot', brief: 'Yellow dress on model' }
  });
  const id = created.json.data.id;
  await awaitDesignReady(id);

  const rejected = await call('POST', `/v1/designs/${id}/reject`, {
    body: { reason: 'Colors off-brand' }
  });
  assert.equal(rejected.http, 200);
  assert.equal(rejected.json.data.status, 'rejected');
  assert.equal(rejected.json.data.rejection_reason, 'Colors off-brand');

  const queue = await call('GET', '/v1/designs?status=pending');
  assert.ok(!queue.json.data.designs.some((d: any) => d.id === id));
});

test('unknown design id is 404 NOT_FOUND', async () => {
  const { http, json } = await call('GET', '/v1/designs/des_nope');
  assert.equal(http, 404);
  assert.equal(json.data.error.code, 'NOT_FOUND');
});

test('PUBLIC_BASE_URL makes image_url absolute so chat links are clickable', async () => {
  process.env.PUBLIC_BASE_URL = 'https://chat.example.test';
  try {
    const created = await call('POST', '/v1/designs/generate', {
      body: { kind: 'flyer', brief: 'absolute url check flyer' }
    });
    const ready = await awaitDesignReady(created.json.data.id);
    assert.match(ready.image_url, /^https:\/\/chat\.example\.test\/images\/des_/);

    const one = await call('GET', `/v1/designs/${created.json.data.id}`);
    assert.match(one.json.data.image_url, /^https:\/\//);

    // without the env var, responses stay relative (the default in tests)
    delete process.env.PUBLIC_BASE_URL;
    const rel = await call('GET', `/v1/designs/${created.json.data.id}`);
    assert.match(rel.json.data.image_url, /^\/images\//);
  } finally {
    delete process.env.PUBLIC_BASE_URL;
  }
});

test('garment store lists the brand dresses from brand/dresses/', async () => {
  const { http, json } = await call('GET', '/v1/garments');
  assert.equal(http, 200);
  const slugs = json.data.garments.map((g: { slug: string }) => g.slug);
  assert.ok(slugs.includes('mint-green-dress'), `expected mint-green-dress in ${slugs}`);
  assert.ok(slugs.includes('sky-blue-dress'), `expected sky-blue-dress in ${slugs}`);
  // photo is served without auth, like generated images
  const photo = await fetch(base + json.data.garments[0].image_url);
  assert.equal(photo.status, 200);
});

test('generate with a garment that is not in the store is 422', async () => {
  const { http, json } = await call('POST', '/v1/designs/generate', {
    body: { kind: 'flyer', brief: 'sale flyer', garment: 'invented-dress-xyz' }
  });
  assert.equal(http, 422);
  assert.equal(json.data.error.code, 'VALIDATION_FAILED');
  assert.match(json.message, /garment must be one of/);
});

test('generation cap returns 429 GENERATION_LIMIT', async () => {
  // Set the cap to the count already generated, then try one more.
  const before = (await call('GET', '/v1/designs')).json.data.designs.length;
  process.env.MAE_MAX_GENERATIONS = String(before);
  try {
    const { http, json } = await call('POST', '/v1/designs/generate', {
      body: { kind: 'flyer', brief: 'one too many' }
    });
    assert.equal(http, 429);
    assert.equal(json.data.error.code, 'GENERATION_LIMIT');
  } finally {
    delete process.env.MAE_MAX_GENERATIONS;
  }
});

test('logo stamping composites the real logo file onto a design', async () => {
  const { default: sharp } = await import('sharp');
  const { stampLogo } = await import('../src/logo.js');

  const bg = { r: 250, g: 230, b: 240 };
  const canvas = await sharp({
    create: { width: 400, height: 500, channels: 3, background: bg }
  })
    .png()
    .toBuffer();

  const stamped = await stampLogo(canvas);
  const meta = await sharp(stamped).metadata();
  assert.equal(meta.format, 'png'); // stamped output is normalised to PNG

  // Logo lands top-centre (18% width, 3.5% from the top) — that region must
  // now contain real logo pixels, not the plain background.
  const { data } = await sharp(stamped)
    .extract({ left: 150, top: 10, width: 100, height: 80 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hasLogoPixels = Array.from(data).some((v, i) => {
    const base = [bg.r, bg.g, bg.b][i % 3] as number;
    return Math.abs(v - base) > 25;
  });
  assert.ok(hasLogoPixels, 'expected real logo pixels near the top-centre');
});

// --- MCP: two endpoints, two tool buckets ------------------------------------

/** One JSON-RPC POST against an MCP endpoint; the reply arrives as SSE `data:` lines. */
async function mcpCall(path: string, payload: Record<string, unknown>) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test_vending_key',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  const dataLine = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .pop();
  return { http: res.status, json: dataLine ? (JSON.parse(dataLine.slice(5)) as any) : null };
}

async function mcpToolNames(path: string): Promise<string[]> {
  const init = await mcpCall(path, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'api-tests', version: '1.0.0' }
    }
  });
  assert.equal(init.http, 200, `initialize on ${path}`);
  const list = await mcpCall(path, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(list.http, 200, `tools/list on ${path}`);
  const tools = (list.json?.result?.tools ?? []) as { name: string }[];
  return tools.map((t) => t.name);
}

test('MCP /mcp serves ONLY the ops bucket (no design tools)', async () => {
  const names = await mcpToolNames('/mcp');
  assert.deepEqual(
    [...names].sort(),
    [
      'buy_airtime',
      'buy_electricity',
      'check_wallet',
      'list_purchases',
      'record_wallet_funding',
      'validate_meter',
      'validate_phone'
    ].sort()
  );
  assert.ok(!names.includes('generate_design'), 'Kemi must not get design tools');
});

test('MCP /mcp/design serves ONLY the design bucket (no money tools)', async () => {
  const names = await mcpToolNames('/mcp/design');
  assert.deepEqual([...names].sort(), ['generate_design', 'list_designs', 'list_garments'].sort());
  assert.ok(!names.includes('buy_airtime'), 'Mae must not get money tools');
});

test('MCP endpoints reject a missing bearer token', async () => {
  const res = await fetch(base + '/mcp/design', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
  assert.equal(res.status, 401);
});
