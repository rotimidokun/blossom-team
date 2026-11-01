import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate test data BEFORE importing app modules (store reads env at import time).
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'vending-')), 'db.json');
process.env.VENDING_API_KEY = 'test_vending_key';
delete process.env.NODE_ENV;

const { startServer } = await import('../src/server.js');

let server;
let base;

before(async () => {
  server = await startServer(0); // ephemeral port
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

async function call(method, path, { body, idempotencyKey } = {}) {
  const headers = { Authorization: 'Bearer test_vending_key' };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  return { http: res.status, json: await res.json() };
}

const wallet = () => call('GET', '/v1/wallet');

// --- auth ------------------------------------------------------------------

test('health endpoint needs no auth', async () => {
  const res = await fetch(base + '/health');
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.status, true);
});

test('missing bearer token is 401 UNAUTHORIZED', async () => {
  const res = await fetch(base + '/v1/wallet');
  assert.equal(res.status, 401);
  const json = await res.json();
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
