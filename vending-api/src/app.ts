/**
 * Blossom by TC — mock vending API (Express).
 *
 * One server, two teammates' tools:
 *   Kemi — wallet, validation, purchases (utility bills)
 *   Mae  — designs: generate -> approval queue -> approve/reject
 *
 * Conventions, deliberately mirroring the APIs we studied:
 *  - Response envelope { status, message, data }  (Paystack-style)
 *  - Bearer auth on every /v1 route                (Chord + Paystack style)
 *  - Amounts in kobo (NGN x100)                    (Paystack-style)
 *  - Idempotency-Key header on purchases           (safe retries, no double-buy)
 *  - Machine-readable error codes                  (what the skill branches on)
 *
 * Kemi's flow: validate -> show owner -> confirm -> purchase.
 * Mae's flow:  generate -> pending -> human approves/rejects -> human posts.
 */
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDb, saveDb, resetDb } from './store.js';
import { generateImage, isMockMode } from './imagegen.js';
import type {
  AirtimePurchase,
  Db,
  Design,
  ElectricityPurchase,
  ErrorCode,
  ErrorEnvelope,
  FundingSource,
  ImageGenError
} from './types.js';

const API_KEY = process.env.VENDING_API_KEY || 'test_vending_key';

// --- small helpers ---------------------------------------------------------

function envelope<T extends object>(status: boolean, message: string, data?: T) {
  return { status, message, data: (data ?? {}) as T };
}

function errorEnvelope(httpStatus: number, code: ErrorCode, message: string): ErrorEnvelope {
  return {
    status: false,
    message,
    data: { error: { code, status: httpStatus } }
  };
}

/** Positive integer amount in kobo, or null if invalid. */
function parseAmount(value: unknown): number | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

const naira = (kobo: number): string => `NGN ${(kobo / 100).toFixed(2)}`;
const newReference = (): string => `blsm_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

// Where Mae's generated images live (served unauthenticated at /images/:file).
const IMAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'images');
const DESIGN_KINDS = ['model-shot', 'flyer', 'slide', 'social'] as const;
// Cost cap: refuse to burn through credits in one session (override: MAE_MAX_GENERATIONS).
// Read at request time so tests (and ops) can change it without a restart.
function maxGenerations(): number {
  return Number(process.env.MAE_MAX_GENERATIONS) || 10;
}

// --- app -------------------------------------------------------------------

export const app = express();
app.use(express.json());

// Health check — no auth.
app.get('/health', (_req, res) => {
  res.json(envelope(true, 'ok'));
});

// Bearer auth for everything below (Chord/Paystack pattern).
app.use('/v1', (req: Request, res: Response, next: NextFunction) => {
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
//   b) Paystack pull (BLOCKED on our starter account) -> src/paystack.ts
//      would move money, we'd record it via /v1/wallet/paystack-funded.
//      Kept as the go-live upgrade path; see the transfer_unavailable note
//      in src/paystack.ts and field-notes.md.

function fundWallet(
  db: Db,
  res: Response,
  amount: number | null,
  source: FundingSource,
  reference?: string
): Response | void {
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
    currency: 'NGN' as const,
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
function replayIfDuplicate(
  db: Db,
  res: Response,
  idempotencyKey: string | undefined
): boolean {
  if (!idempotencyKey || !db.idempotency[idempotencyKey]) return false;
  const original = db.purchases.find((p) => p.id === db.idempotency[idempotencyKey]);
  res.json(
    envelope(true, 'Idempotent replay — original result returned', { ...original, replayed: true })
  );
  return true;
}

function walletTooSmall(res: Response, db: Db, amount: number): boolean {
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
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

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
  const purchase: ElectricityPurchase = {
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
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

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
  const purchase: AirtimePurchase = {
    id: `pur_${randomUUID().slice(0, 8)}`,
    kind: 'airtime',
    status: 'success',
    amount,
    currency: 'NGN',
    phone_number: entry.phone_number,
    // Valid seeded lines always carry a network; the cast keeps the response
    // shape identical to the JS version.
    network: entry.network as string,
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

// --- designs (Mae's approval queue) ----------------------------------------
// Mae creates -> status pending -> owner approves/rejects -> owner posts.
// The agent NEVER publishes; the queue is the real action the tool takes.

/** Serve a generated image by filename (no auth — it's a shareable link). */
app.get('/images/:file', (req, res) => {
  const file = req.params.file.replace(/[^a-zA-Z0-9._-]/g, ''); // no path traversal
  const path = join(IMAGES_DIR, file);
  if (!existsSync(path)) {
    return res.status(404).json(errorEnvelope(404, 'NOT_FOUND', 'Image not found'));
  }
  res.sendFile(path);
});

// Generate an image -> save file -> queue as pending.
app.post('/v1/designs/generate', async (req, res) => {
  const db = loadDb();
  const { kind, brief, garment } = req.body || {};

  if (!kind || !DESIGN_KINDS.includes(kind)) {
    return res
      .status(422)
      .json(
        errorEnvelope(422, 'VALIDATION_FAILED', `kind must be one of: ${DESIGN_KINDS.join(', ')}`)
      );
  }
  if (!brief || typeof brief !== 'string' || !brief.trim()) {
    return res
      .status(422)
      .json(errorEnvelope(422, 'VALIDATION_FAILED', 'brief is required — describe the visual'));
  }
  const cap = maxGenerations();
  if (db.generation_count >= cap) {
    return res
      .status(429)
      .json(
        errorEnvelope(
          429,
          'GENERATION_LIMIT',
          `Generation cap reached (${cap} this session) — reset or raise MAE_MAX_GENERATIONS`
        )
      );
  }

  try {
    const result = await generateImage({ kind, brief: brief.trim(), garment });

    const id = `des_${randomUUID().slice(0, 8)}`;
    const ext = result.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const filename = `${id}.${ext}`;
    mkdirSync(IMAGES_DIR, { recursive: true });
    writeFileSync(join(IMAGES_DIR, filename), Buffer.from(result.imageBase64, 'base64'));

    const design: Design = {
      id,
      kind,
      brief: brief.trim(),
      garment: garment || null,
      prompt_used: result.prompt,
      provider: result.provider,
      model: result.model,
      mock: result.mock,
      image_file: filename,
      image_url: `/images/${filename}`,
      status: 'pending',
      rejection_reason: null,
      created_at: new Date().toISOString()
    };
    db.designs.push(design);
    db.generation_count += 1;
    saveDb(db);

    res.status(201).json(envelope(true, 'Design created — queued for approval', { ...design }));
  } catch (err) {
    const e = err as Partial<ImageGenError>;
    const code: ErrorCode = e.code || 'IMAGE_API_UNAVAILABLE';
    const status = code === 'GENERATION_LIMIT' ? 429 : 503;
    res.status(status).json(errorEnvelope(status, code, e.message || 'Image generation failed'));
  }
});

// The approval queue — filter with ?status=pending
app.get('/v1/designs', (req, res) => {
  const db = loadDb();
  const status = req.query.status;
  const designs = status ? db.designs.filter((d) => d.status === String(status)) : db.designs;
  res.json(envelope(true, 'Designs retrieved', { designs }));
});

app.get('/v1/designs/:id', (req, res) => {
  const db = loadDb();
  const design = db.designs.find((d) => d.id === req.params.id);
  if (!design) {
    return res.status(404).json(errorEnvelope(404, 'NOT_FOUND', 'Design not found'));
  }
  res.json(envelope(true, 'Design retrieved', { ...design }));
});

// Human flips pending -> approved (then posts manually).
app.post('/v1/designs/:id/approve', (req, res) => {
  const db = loadDb();
  const design = db.designs.find((d) => d.id === req.params.id);
  if (!design) {
    return res.status(404).json(errorEnvelope(404, 'NOT_FOUND', 'Design not found'));
  }
  if (design.status !== 'pending') {
    return res
      .status(409)
      .json(errorEnvelope(409, 'INVALID_STATE', `Design is already ${design.status}`));
  }
  design.status = 'approved';
  design.approved_at = new Date().toISOString();
  saveDb(db);
  res.json(envelope(true, 'Design approved — ready to post', { ...design }));
});

// Human flips pending -> rejected, with a reason Mae can act on.
app.post('/v1/designs/:id/reject', (req, res) => {
  const db = loadDb();
  const design = db.designs.find((d) => d.id === req.params.id);
  if (!design) {
    return res.status(404).json(errorEnvelope(404, 'NOT_FOUND', 'Design not found'));
  }
  if (design.status !== 'pending') {
    return res
      .status(409)
      .json(errorEnvelope(409, 'INVALID_STATE', `Design is already ${design.status}`));
  }
  const { reason } = req.body || {};
  design.status = 'rejected';
  design.rejection_reason = reason || null;
  design.rejected_at = new Date().toISOString();
  saveDb(db);
  res.json(envelope(true, 'Design rejected', { ...design }));
});

// --- unknown routes --------------------------------------------------------

app.use((req, res) => {
  res
    .status(404)
    .json(errorEnvelope(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`));
});

// Malformed JSON body -> standard envelope, not an HTML stack trace.
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === 'entity.parse.failed') {
    return res
      .status(400)
      .json(errorEnvelope(400, 'VALIDATION_FAILED', 'Request body is not valid JSON'));
  }
  res.status(500).json(errorEnvelope(500, 'INTERNAL_ERROR', 'Unexpected server error'));
});
