/**
 * Blossom by TC — mock vending API (Express).
 *
 * Conventions, deliberately mirroring the APIs we studied:
 *  - Response envelope { status, message, data }  (Paystack-style)
 *  - Bearer auth on every /v1 route                (Chord + Paystack style)
 *  - Amounts in kobo (NGN x100)                    (Paystack-style)
 *  - Idempotency-Key header on purchases           (safe retries, no double-buy)
 *  - Machine-readable error codes                  (what the skill branches on)
 *
 * Flow the skill enforces: validate -> show owner -> confirm -> purchase.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { loadDb, saveDb, resetDb } from './store.js';

const API_KEY = process.env.VENDING_API_KEY || 'test_vending_key';

// --- small helpers ---------------------------------------------------------

const envelope = (status, message, data = {}) => ({ status, message, data });

const errorEnvelope = (httpStatus, code, message) => ({
  status: false,
  message,
  data: { error: { code, status: httpStatus } }
});

/** Positive integer amount in kobo, or null if invalid. */
function parseAmount(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

const naira = (kobo) => `NGN ${(kobo / 100).toFixed(2)}`;
const newReference = () => `blsm_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

// --- app -------------------------------------------------------------------

export const app = express();
app.use(express.json());

// Health check — no auth.
app.get('/health', (_req, res) => {
  res.json(envelope(true, 'ok'));
});

// Bearer auth for everything below (Chord/Paystack pattern).
app.use('/v1', (req, res, next) => {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${API_KEY}`) {
    return res
      .status(401)
      .json(errorEnvelope(401, 'UNAUTHORIZED', 'Missing or invalid API key'));
  }
  next();
});

// --- wallet ----------------------------------------------------------------

app.get('/v1/wallet', (req, res) => {
  const db = loadDb();
  res.json(envelope(true, 'Balance retrieved', { ...db.wallet }));
});

// --- wallet funding --------------------------------------------------------
// Two ways in, both recorded against a reference so the same money
// can never be counted twice:
//   a) bank transfer (PUSH, the path that works today) -> owner sends to the
//      biller account, we record detection via /v1/wallet/incoming
//   b) Paystack pull (BLOCKED on our starter account) -> src/paystack.js
//      would move money, we'd record it via /v1/wallet/paystack-funded.
//      Kept as the go-live upgrade path; see the transfer_unavailable note
//      in src/paystack.js and field-notes.md.

function fundWallet(db, res, amount, source, reference) {
  if (amount === null) {
    return res
      .status(422)
      .json(errorEnvelope(422, 'VALIDATION_FAILED', 'amount (integer kobo) is required'));
  }
  if (!reference) {
    return res
      .status(422)
      .json(errorEnvelope(422, 'VALIDATION_FAILED', 'reference is required to trace the funding'));
  }
  if (db.incoming.some((t) => t.reference === reference)) {
    return res
      .status(409)
      .json(errorEnvelope(409, 'IDEMPOTENT_REPLAY', 'This reference was already applied'));
  }

  db.wallet.balance += amount;
  const credit = {
    id: `cr_${randomUUID().slice(0, 8)}`,
    amount,
    currency: 'NGN',
    source, // 'bank_transfer' | 'paystack'
    reference,
    balance_after: db.wallet.balance,
    created_at: new Date().toISOString()
  };
  db.incoming.push(credit);
  saveDb(db);
  res.json(envelope(true, 'Wallet funded', { ...credit }));
}

// a) Bank transfer detected by the biller (made-up account details)
app.post('/v1/wallet/incoming', (req, res) => {
  const db = loadDb();
  const { reference, source } = req.body || {};
  fundWallet(db, res, parseAmount(req.body?.amount), source || 'bank_transfer', reference);
});

// b) Funding recorded after a Paystack test transfer succeeded
app.post('/v1/wallet/paystack-funded', (req, res) => {
  const db = loadDb();
  const { paystack_reference } = req.body || {};
  fundWallet(db, res, parseAmount(req.body?.amount), 'paystack', paystack_reference);
});

// --- validation (always before a purchase) ---------------------------------

app.post('/v1/validate/meter', (req, res) => {
  const db = loadDb();
  const { meter_number, disco, type } = req.body || {};

  if (!meter_number || !disco) {
    return res
      .status(422)
      .json(errorEnvelope(422, 'VALIDATION_FAILED', 'meter_number and disco are required'));
  }

  const meter = db.meters.find((m) => String(m.meter_number) === String(meter_number));
  if (!meter || meter.disco !== disco) {
    return res
      .status(400)
      .json(errorEnvelope(400, 'INVALID_METER', 'Meter number is not valid for this disco'));
  }

  res.json(
    envelope(true, 'Meter validated', {
      valid: true,
      meter_number: meter.meter_number,
      disco: meter.disco,
      type: type || meter.type,
      owner_name: meter.owner_name
    })
  );
});

app.post('/v1/validate/phone', (req, res) => {
  const db = loadDb();
  const { phone_number } = req.body || {};

  if (!phone_number) {
    return res
      .status(422)
      .json(errorEnvelope(422, 'VALIDATION_FAILED', 'phone_number is required'));
  }

  const entry = db.phones.find((p) => p.phone_number === String(phone_number));
  if (!entry || !entry.valid) {
    return res
      .status(400)
      .json(errorEnvelope(400, 'INVALID_PHONE', 'Phone number is not a valid Nigerian line'));
  }

  res.json(
    envelope(true, 'Phone validated', {
      valid: true,
      phone_number: entry.phone_number,
      network: entry.network
    })
  );
});

// --- purchases -------------------------------------------------------------

/** If this Idempotency-Key was used before, return the original result (no new buy). */
function replayIfDuplicate(db, res, idempotencyKey) {
  if (!idempotencyKey || !db.idempotency[idempotencyKey]) return false;
  const original = db.purchases.find((p) => p.id === db.idempotency[idempotencyKey]);
  res.json(
    envelope(true, 'Idempotent replay — original result returned', { ...original, replayed: true })
  );
  return true;
}

function walletTooSmall(res, db, amount) {
  if (db.wallet.balance >= amount) return false;
  res
    .status(402)
    .json(
      errorEnvelope(
        402,
        'INSUFFICIENT_WALLET',
        `Wallet balance ${naira(db.wallet.balance)} is below the purchase amount`
      )
    );
  return true;
}

app.post('/v1/purchases/electricity', (req, res) => {
  const db = loadDb();
  const { meter_number, disco, type } = req.body || {};
  const amount = parseAmount(req.body?.amount);
  const idempotencyKey = req.headers['idempotency-key'];

  if (!meter_number || !disco || amount === null) {
    return res
      .status(422)
      .json(
        errorEnvelope(
          422,
          'VALIDATION_FAILED',
          'meter_number, disco and amount (integer kobo) are required'
        )
      );
  }
  if (replayIfDuplicate(db, res, idempotencyKey)) return;

  const meter = db.meters.find((m) => String(m.meter_number) === String(meter_number));
  if (!meter || meter.disco !== disco) {
    return res
      .status(400)
      .json(errorEnvelope(400, 'INVALID_METER', 'Meter number is not valid for this disco'));
  }
  if (!meter.available) {
    return res
      .status(503)
      .json(
        errorEnvelope(503, 'DISCO_UNAVAILABLE', `${disco} is currently unavailable — try again later`)
      );
  }
  if (walletTooSmall(res, db, amount)) return;

  db.wallet.balance -= amount;
  const purchase = {
    id: `pur_${randomUUID().slice(0, 8)}`,
    kind: 'electricity',
    status: 'success',
    amount,
    currency: 'NGN',
    meter_number: meter.meter_number,
    disco: meter.disco,
    type: type || meter.type,
    owner_name: meter.owner_name,
    units: (amount / 100 / 23.75).toFixed(2),
    token: Array.from({ length: 5 }, () => Math.floor(1000 + Math.random() * 9000)).join('-'),
    reference: newReference(),
    wallet_balance_after: db.wallet.balance,
    created_at: new Date().toISOString()
  };
  db.purchases.push(purchase);
  if (idempotencyKey) db.idempotency[idempotencyKey] = purchase.id;
  saveDb(db);

  res.json(envelope(true, 'Electricity purchased', { ...purchase }));
});

app.post('/v1/purchases/airtime', (req, res) => {
  const db = loadDb();
  const { phone_number, network } = req.body || {};
  const amount = parseAmount(req.body?.amount);
  const idempotencyKey = req.headers['idempotency-key'];

  if (!phone_number || amount === null) {
    return res
      .status(422)
      .json(
        errorEnvelope(422, 'VALIDATION_FAILED', 'phone_number and amount (integer kobo) are required')
      );
  }
  if (replayIfDuplicate(db, res, idempotencyKey)) return;

  const entry = db.phones.find((p) => p.phone_number === String(phone_number));
  if (!entry || !entry.valid) {
    return res
      .status(400)
      .json(errorEnvelope(400, 'INVALID_PHONE', 'Phone number is not a valid Nigerian line'));
  }
  if (network && network !== entry.network) {
    return res
      .status(400)
      .json(
        errorEnvelope(400, 'VALIDATION_FAILED', `Phone belongs to ${entry.network}, not ${network}`)
      );
  }
  if (walletTooSmall(res, db, amount)) return;

  db.wallet.balance -= amount;
  const purchase = {
    id: `pur_${randomUUID().slice(0, 8)}`,
    kind: 'airtime',
    status: 'success',
    amount,
    currency: 'NGN',
    phone_number: entry.phone_number,
    network: entry.network,
    reference: newReference(),
    wallet_balance_after: db.wallet.balance,
    created_at: new Date().toISOString()
  };
  db.purchases.push(purchase);
  if (idempotencyKey) db.idempotency[idempotencyKey] = purchase.id;
  saveDb(db);

  res.json(envelope(true, 'Airtime purchased', { ...purchase }));
});

// --- receipts --------------------------------------------------------------

app.get('/v1/purchases', (_req, res) => {
  const db = loadDb();
  res.json(envelope(true, 'Purchases retrieved', { purchases: db.purchases }));
});

app.get('/v1/purchases/:id', (req, res) => {
  const db = loadDb();
  const purchase = db.purchases.find((p) => p.id === req.params.id || p.reference === req.params.id);
  if (!purchase) {
    return res.status(404).json(errorEnvelope(404, 'NOT_FOUND', 'Purchase not found'));
  }
  res.json(envelope(true, 'Purchase retrieved', { ...purchase }));
});

// --- test-only reset (disabled in production) ------------------------------

app.post('/v1/reset', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json(errorEnvelope(403, 'FORBIDDEN', 'Reset is disabled in production'));
  }
  resetDb();
  res.json(envelope(true, 'Database reset to seed state'));
});

// --- unknown routes --------------------------------------------------------

app.use((req, res) => {
  res
    .status(404)
    .json(errorEnvelope(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`));
});

// Malformed JSON body -> standard envelope, not an HTML stack trace.
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res
      .status(400)
      .json(errorEnvelope(400, 'VALIDATION_FAILED', 'Request body is not valid JSON'));
  }
  res.status(500).json(errorEnvelope(500, 'INTERNAL_ERROR', 'Unexpected server error'));
});
