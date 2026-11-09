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
// Owner code gating the monthly payday run (route reads it per request).
process.env.OWNER_CODE = 'flowerpower';

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
      'check_paystack_balance',
      'check_wallet',
      'list_purchases',
      'list_salaries',
      'list_staff',
      'pay_salaries',
      'record_wallet_funding',
      'validate_meter',
      'validate_phone'
    ].sort()
  );
  assert.ok(!names.includes('generate_design'), 'Kemi must not get design tools');
  assert.ok(!names.includes('list_products'), 'Kemi does not get Ada\'s catalogue tools');
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

// --- sales: catalogue (Paystack fixture), orders, customers ------------------
// No PAYSTACK_SECRET_KEY in tests -> paystack.ts runs its in-process fixture.

test('products list comes from the catalogue with prices, photos and shop url', async () => {
  const { http, json } = await call('GET', '/v1/products');
  assert.equal(http, 200);
  const products = json.data.products as any[];
  assert.equal(products.length, 2);
  const sky = products.find((p) => p.id === 2880906);
  assert.ok(sky, 'sky blue dress should exist');
  assert.equal(sky.price, 1250000); // kobo = NGN 12,500
  assert.match(sky.photo_url, /^https:\/\//);
  assert.match(sky.buy_url, /paystack\.com\/buy\//);
  assert.equal(typeof json.data.storefront_url, 'string');
});

test('catalogue edits need the owner code: without it nothing changes (403)', async () => {
  const noCode = await call('PUT', '/v1/products/2880907', { body: { price: 100 } });
  assert.equal(noCode.http, 403);
  assert.equal(noCode.json.data.error.code, 'FORBIDDEN');

  const wrongCode = await call('PUT', '/v1/products/2880907', {
    body: { price: 100, owner_code: 'letmein' }
  });
  assert.equal(wrongCode.http, 403);

  const list = await call('GET', '/v1/products');
  const mint = (list.json.data.products as any[]).find((p) => p.id === 2880907);
  assert.equal(mint.price, 1150000, 'a refused edit leaves the catalogue untouched');
});

test('owner updates a price -> catalogue reflects it (agent edit path)', async () => {
  const upd = await call('PUT', '/v1/products/2880907', {
    body: { price: 999900, owner_code: 'flowerpower' }
  });
  assert.equal(upd.http, 200);
  assert.equal(upd.json.data.product.price, 999900);

  const list = await call('GET', '/v1/products');
  const mint = (list.json.data.products as any[]).find((p) => p.id === 2880907);
  assert.equal(mint.price, 999900, 'the change must be readable afterwards');

  const bad = await call('PUT', '/v1/products/2880907', {
    body: { owner_code: 'flowerpower' }
  });
  assert.equal(bad.http, 422);
  const missing = await call('PUT', '/v1/products/999', {
    body: { price: 100, owner_code: 'flowerpower' }
  });
  assert.equal(missing.http, 404);
});

test('create order opens a payment window; duplicate open order replays', async () => {
  const created = await call('POST', '/v1/orders', {
    body: {
      product_id: 2880906,
      customer_name: 'Adaeze',
      customer_email: 'adaeze@example.test',
      size: '7–8 Years'
    }
  });
  assert.equal(created.http, 201);
  const order = created.json.data.order;
  assert.equal(order.status, 'pending');
  assert.equal(order.amount, 1250000);
  assert.equal(order.size, '7–8 Years', 'the agreed size rides on the order');
  assert.match(order.payment_url, /^https:\/\/checkout\.paystack\.com\//);
  assert.ok(order.paystack_reference);

  const again = await call('POST', '/v1/orders', {
    body: { product_id: 2880906, customer_name: 'Adaeze', customer_email: 'adaeze@example.test' }
  });
  assert.equal(again.http, 200);
  assert.equal(again.json.data.replay, true);
  assert.equal(again.json.data.id, order.id, 'retry returns the same open order');
});

test('order validation: bad email 422, unknown product 422', async () => {
  const badEmail = await call('POST', '/v1/orders', {
    body: { product_id: 2880906, customer_name: 'X', customer_email: 'not-an-email' }
  });
  assert.equal(badEmail.http, 422);
  const badProduct = await call('POST', '/v1/orders', {
    body: { product_id: 42, customer_name: 'X', customer_email: 'x@example.test' }
  });
  assert.equal(badProduct.http, 422);
  assert.match(badProduct.json.message, /product_id must be one of/);
});

test('verify payment: paid -> order paid + customer recorded (and stays idempotent)', async () => {
  const created = await call('POST', '/v1/orders', {
    body: { product_id: 2880906, customer_name: 'Chidi', customer_email: 'chidi@example.test' }
  });
  const id = created.json.data.order.id;

  const verified = await call('POST', `/v1/orders/${id}/verify`);
  assert.equal(verified.http, 200);
  assert.equal(verified.json.data.paid, true);
  assert.equal(verified.json.data.order.status, 'paid');
  assert.ok(verified.json.data.order.paid_at);
  assert.equal(verified.json.data.customer.email, 'chidi@example.test');
  assert.equal(verified.json.data.customer.orders_count, 1);
  assert.equal(verified.json.data.order.size, null, 'size is optional — absent when not given');

  const again = await call('POST', `/v1/orders/${id}/verify`);
  assert.equal(again.json.data.paid, true, 'verify on a paid order stays paid');

  const customers = await call('GET', '/v1/customers');
  const emails = (customers.json.data.customers as any[]).map((c) => c.email);
  assert.ok(emails.includes('chidi@example.test'));

  const flagged = await call('POST', `/v1/orders/${id}/status`, { body: { status: 'lead' } });
  assert.equal(flagged.http, 409, 'paid orders never change');
});

test('drop-off path: not paid -> lead -> recovery offer -> new window', async () => {
  const created = await call('POST', '/v1/orders', {
    body: { product_id: 2880907, customer_name: 'Ngozi', customer_email: 'unpaid-ngozi@example.test' }
  });
  const id = created.json.data.order.id;

  const verify = await call('POST', `/v1/orders/${id}/verify`);
  assert.equal(verify.json.data.paid, false, 'unpaid window must not read as paid');
  assert.equal(verify.json.data.verification_status, 'abandon');

  const dropped = await call('POST', `/v1/orders/${id}/status`, { body: { status: 'lead' } });
  assert.equal(dropped.http, 200);
  assert.equal(dropped.json.data.order.status, 'lead');

  const offered = await call('POST', `/v1/orders/${id}/status`, {
    body: { status: 'offer_sent', note: '10% off if you pay today' }
  });
  assert.equal(offered.http, 200);
  assert.equal(offered.json.data.order.status, 'offer_sent');
  assert.equal(offered.json.data.order.discount_note, '10% off if you pay today');

  const window = await call('POST', `/v1/orders/${id}/payment-link`, {
    body: { amount: 1035000, note: '10% recovery offer' }
  });
  assert.equal(window.http, 200);
  assert.equal(window.json.data.order.amount, 1035000, 'discounted amount applied');
  assert.match(window.json.data.payment_url, /^https:\/\/checkout\.paystack\.com\//);
  assert.equal(window.json.data.order.link_attempts, 2);

  const filtered = await call('GET', '/v1/orders?status=offer_sent');
  assert.ok((filtered.json.data.orders as any[]).some((o) => o.id === id));
  const badFilter = await call('GET', '/v1/orders?status=weird');
  assert.equal(badFilter.http, 422);
});

test('MCP /mcp/sales serves ONLY the sales bucket (10 tools)', async () => {
  const names = await mcpToolNames('/mcp/sales');
  assert.equal(names.length, 10);
  assert.deepEqual(
    [...names].sort(),
    [
      'create_order',
      'create_payment_link',
      'get_order',
      'list_customers',
      'list_orders',
      'list_products',
      'mark_drop_off',
      'record_follow_up_offer',
      'update_product',
      'verify_payment'
    ].sort()
  );
  assert.ok(!names.includes('check_wallet'), 'money tools are not hers');
  assert.ok(!names.includes('generate_design'), 'design tools are not hers');
  assert.ok(!names.includes('pay_salaries'), 'payroll tools are not hers');
});

// --- staff & monthly payday (Kemi: owner-code gated payroll run) ---------------

test('staff list is the founder only — the AI agents are deliberately NOT paid', async () => {
  const { http, json } = await call('GET', '/v1/staff');
  assert.equal(http, 200);
  const staff = json.data.staff as any[];
  assert.equal(staff.length, 1, 'payroll = the founder draw alone');
  assert.equal(staff[0].name, 'Tosin');
  assert.equal(staff[0].agent, false, 'agents cannot spend money — they are not staff');
  assert.ok(Number.isInteger(staff[0].salary) && staff[0].salary > 0, 'salary is kobo');
});

test('check_paystack_balance reads the BANK (kobo) — the other pot of money', async () => {
  const { http, json } = await call('GET', '/v1/paystack/balance');
  assert.equal(http, 200);
  assert.equal(typeof json.data.balance, 'number');
  assert.ok(Number.isInteger(json.data.balance) && json.data.balance >= 0, 'kobo integer');
  assert.equal(json.data.currency, 'NGN');
});

test('payroll needs the owner code: wrong or missing code runs nothing (403)', async () => {
  const wrong = await call('POST', '/v1/salaries', { body: { owner_code: 'letmein' } });
  assert.equal(wrong.http, 403);
  assert.equal(wrong.json.data.error.code, 'FORBIDDEN');

  const missing = await call('POST', '/v1/salaries', { body: {} });
  assert.equal(missing.http, 403);

  const history = await call('GET', '/v1/salaries');
  assert.equal((history.json.data.salaries as any[]).length, 0, 'no attempt may be recorded without the code');
});

test('payday pays the founder from the VENDING WALLET; rerun skips the month', async () => {
  // Fund the wallet first — petty cash is the payment pot (SALARY_SOURCE=wallet).
  const walletBefore = (await wallet()).json.data.balance;
  const fund = await call('POST', '/v1/wallet/incoming', {
    body: { amount: 5000000, reference: 'TRF-payday-fund' }
  });
  assert.equal(fund.http, 200);

  const run = await call('POST', '/v1/salaries', {
    body: { owner_code: 'flowerpower', month: '2026-11' }
  });
  assert.equal(run.http, 201);
  assert.equal(run.json.data.paid, 1);
  assert.equal(run.json.data.failed, 0);
  assert.equal(run.json.data.skipped, 0);
  assert.equal(run.json.data.paid_from, 'wallet');
  assert.equal(run.json.data.total_paid_kobo, 10000000); // NGN 100,000
  const record = (run.json.data.salaries as any[])[0];
  assert.equal(record.status, 'paid');
  assert.equal(record.source, 'wallet');
  assert.equal(record.staff_name, 'Tosin');
  assert.equal(record.transfer_code, null, 'no Paystack transfer code on a wallet payment');
  assert.match(record.transfer_reference, /^wal-stf_founder-2026-11$/);

  const walletAfter = (await wallet()).json.data.balance;
  assert.equal(
    walletAfter,
    walletBefore + 5000000 - 10000000,
    'the wallet was funded then debited — money actually moved'
  );
  assert.equal(run.json.data.wallet_balance_after, walletAfter);

  const again = await call('POST', '/v1/salaries', {
    body: { owner_code: 'flowerpower', month: '2026-11' }
  });
  assert.equal(again.http, 201);
  assert.equal(again.json.data.paid, 0, 'the same month is never paid twice');
  assert.equal(again.json.data.skipped, 1);

  const history = await call('GET', '/v1/salaries?month=2026-11');
  assert.equal((history.json.data.salaries as any[]).length, 1, 'rerun adds no records');
});

test('payday when the wallet is short: recorded as failed, never a payslip — retry after funding', async () => {
  // Wallet is deliberately low after the run above (< NGN 100,000).
  const poor = await call('POST', '/v1/salaries', {
    body: { owner_code: 'flowerpower', month: '2026-12' }
  });
  assert.equal(poor.http, 201, 'the attempt itself is still recorded');
  assert.equal(poor.json.data.paid, 0);
  assert.equal(poor.json.data.failed, 1);
  const failed = (poor.json.data.salaries as any[])[0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.source, 'wallet');
  assert.match(failed.failure_reason, /wallet balance/i);
  assert.equal(failed.transfer_code, null);

  // Fund the wallet, then the same month pays — failures stay retryable.
  await call('POST', '/v1/wallet/incoming', { body: { amount: 20000000, reference: 'TRF-payday-retry' } });
  const retry = await call('POST', '/v1/salaries', {
    body: { owner_code: 'flowerpower', month: '2026-12' }
  });
  assert.equal(retry.json.data.paid, 1, 'a failed month can be retried after funding');
});

test('SALARY_SOURCE=paystack flips payroll to a real transfer (when the channel works)', async () => {
  process.env.SALARY_SOURCE = 'paystack';
  try {
    const run = await call('POST', '/v1/salaries', {
      body: { owner_code: 'flowerpower', month: '2026-10' }
    });
    assert.equal(run.http, 201);
    assert.equal(run.json.data.paid, 1);
    assert.equal(run.json.data.paid_from, 'paystack');
    const record = (run.json.data.salaries as any[])[0];
    assert.equal(record.source, 'paystack');
    assert.ok(record.transfer_code, 'the paystack path carries a transfer code');
    assert.match(record.transfer_reference, /^sal-stf_founder-2026-10$/);
  } finally {
    delete process.env.SALARY_SOURCE;
  }
});

test('payroll validation: bad month and unknown staff are 422; one-person run works', async () => {
  const badMonth = await call('POST', '/v1/salaries', {
    body: { owner_code: 'flowerpower', month: 'november' }
  });
  assert.equal(badMonth.http, 422);

  const badStaff = await call('POST', '/v1/salaries', {
    body: { owner_code: 'flowerpower', month: '2026-10', staff_id: 'stf_nope' }
  });
  assert.equal(badStaff.http, 422);

  const one = await call('POST', '/v1/salaries', {
    body: { owner_code: 'flowerpower', month: '2026-09', staff_id: 'stf_founder' }
  });
  assert.equal(one.http, 201);
  assert.equal(one.json.data.paid, 1, 'staff_id narrows the run to one person');
  assert.equal((one.json.data.salaries as any[])[0].staff_name, 'Tosin');
});
