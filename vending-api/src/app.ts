/**
 * Blossom by TC — mock vending API (Express).
 *
 * One server, three teammates' tools:
 *   Kemi — wallet, validation, purchases (utility bills)
 *   Mae  — designs: generate -> link -> improve loop (no approval ceremony)
 *   Ada  — sales: Paystack catalogue, orders, payment windows, customers
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
import { buildPrompt, generateImage, isMockMode } from './imagegen.js';
import { mountMcp } from './mcp.js';
import {
  getProduct,
  initializeTransaction,
  listProducts,
  storefrontUrl,
  updateProduct,
  verifyTransaction
} from './paystack.js';
import { GARMENTS_DIR, garmentReferenceDataUrl, listGarments } from './garments.js';
import { stampLogo } from './logo.js';
import type {
  AirtimePurchase,
  Db,
  Customer,
  Design,
  ElectricityPurchase,
  ErrorCode,
  ErrorEnvelope,
  FundingSource,
  ImageGenError,
  Order
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
//   b) Paystack pull (AVAILABLE since 2026-11-05 — Registered Business account
//      lifted the starter payouts gate) -> src/paystack.ts moves money, we'd
//      record it via /v1/wallet/paystack-funded. Test balance is currently
//      ₦0, so push remains the demo path until test funds exist.

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

// The garment store — the brand's real dresses, read from brand/dresses/.
// Mae lists these first, the client picks one, and the photo is sent to the
// image model as an input_reference so the design shows the actual dress.
app.get('/v1/garments', (_req, res) => {
  const garments = listGarments();
  res.json(
    envelope(
      true,
      garments.length
        ? 'Garments retrieved'
        : 'Garment store is empty — drop photos into brand/dresses/',
      { garments }
    )
  );
});

/** Serve a garment photo by filename (no auth — shareable like /images). */
app.get('/garments/:file', (req, res) => {
  const file = req.params.file.replace(/[^a-zA-Z0-9._-]/g, ''); // no path traversal
  const path = join(GARMENTS_DIR, file);
  if (!existsSync(path)) {
    return res.status(404).json(errorEnvelope(404, 'NOT_FOUND', 'Garment not found'));
  }
  res.sendFile(path);
});

// Generate an image -> save file -> queue as pending.
/**
 * Absolute image URLs in API responses when PUBLIC_BASE_URL is set, so chat
 * replies contain a clickable link instead of a bare "/images/..." path.
 * The DB always stores the canonical relative path — only the response is
 * rewritten (unset in tests and local dev -> unchanged behaviour).
 */
function withPublicImageUrl<T extends { image_url: string }>(design: T): T {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !design.image_url || design.image_url.startsWith('http')) {
    return design;
  }
  return { ...design, image_url: `${base}${design.image_url}` };
}

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

  // garment is a slug from GET /v1/garments — resolve it to the real photo.
  let referenceUrls: string[] = [];
  if (garment) {
    const dataUrl = garmentReferenceDataUrl(String(garment));
    if (!dataUrl) {
      const available = listGarments()
        .map((g) => g.slug)
        .join(', ');
      return res.status(422).json(
        errorEnvelope(
          422,
          'VALIDATION_FAILED',
          available
            ? `garment must be one of: ${available}`
            : `garment "${garment}" is not in the store — brand/dresses/ is empty`
        )
      );
    }
    referenceUrls = [dataUrl];
  }

  const briefText = brief.trim();

  // Same brief already generating? Chord retries when a connection drops —
  // never let a retry double-generate (money) or double-count the cap.
  const inFlight = db.designs.find(
    (d) =>
      d.status === 'creating' &&
      d.kind === kind &&
      d.brief === briefText &&
      (d.garment || null) === (garment || null)
  );
  if (inFlight) {
    return res.status(409).json(
      errorEnvelope(
        409,
        'GENERATION_IN_PROGRESS',
        `Design ${inFlight.id} for this exact brief is already generating — poll GET /v1/designs/${inFlight.id}`
      )
    );
  }

  // Create the record FIRST and answer immediately. The 15-45s image call
  // runs in the background so no HTTP/MCP connection stays open long enough
  // for a flaky link to kill the turn — 2026-11-05: synchronous generation
  // over the ngrok tunnel produced 502s, "unexpected EOF", and an aborted
  // process while Mae waited. Now the caller polls for image_url instead.
  const id = `des_${randomUUID().slice(0, 8)}`;
  const design: Design = {
    id,
    kind,
    brief: briefText,
    garment: garment || null,
    prompt_used: buildPrompt({ kind, brief: briefText, garment }),
    provider: '',
    model: '',
    mock: false,
    image_file: '',
    image_url: '',
    status: 'creating',
    rejection_reason: null,
    created_at: new Date().toISOString()
  };
  db.designs.push(design);
  db.generation_count += 1;
  saveDb(db);

  res
    .status(201)
    .json(
      envelope(true, 'Design queued — generating now (15-45s); poll this design for image_url', {
        ...withPublicImageUrl(design)
      })
    );

  // Background generation — deliberately detached from the response above.
  void (async () => {
    try {
      const result = await generateImage({
        kind,
        brief: briefText,
        garment,
        referenceUrls
      });

      let ext = result.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      let imageBuffer: Buffer = Buffer.from(result.imageBase64, 'base64');

      // Stamp the REAL logo on top (guardrail #1) — the model is told never
      // to draw it, so the only logo that ships is the actual file. Mock
      // images skip this; a stamping failure never fails the generation.
      if (!result.mock) {
        try {
          imageBuffer = await stampLogo(imageBuffer);
          ext = 'png'; // stamped output is normalised to PNG
        } catch (stampErr) {
          console.warn(`[logo] stamp skipped: ${(stampErr as Error).message}`);
        }
      }

      const filename = `${id}.${ext}`;
      mkdirSync(IMAGES_DIR, { recursive: true });
      writeFileSync(join(IMAGES_DIR, filename), imageBuffer);

      const fresh = loadDb();
      const record = fresh.designs.find((d) => d.id === id);
      if (record) {
        record.prompt_used = result.prompt;
        record.provider = result.provider;
        record.model = result.model;
        record.mock = result.mock;
        record.image_file = filename;
        record.image_url = `/images/${filename}`;
        record.status = 'pending';
        saveDb(fresh);
      }
      console.log(`[design] ${id} ready (${result.provider}/${result.model})`);
    } catch (err) {
      const e = err as Partial<ImageGenError>;
      const fresh = loadDb();
      const record = fresh.designs.find((d) => d.id === id);
      if (record) {
        record.status = 'failed';
        record.rejection_reason = e.message || 'Image generation failed';
      }
      // Failed generations are not charged by the provider — give the attempt
      // back to the session cap.
      fresh.generation_count = Math.max(0, fresh.generation_count - 1);
      saveDb(fresh);
      console.error(`[design] ${id} failed: ${e.message} (${e.code || 'IMAGE_API_UNAVAILABLE'})`);
    }
  })();
});

// The approval queue — filter with ?status=pending
app.get('/v1/designs', (req, res) => {
  const db = loadDb();
  const status = req.query.status;
  const designs = status ? db.designs.filter((d) => d.status === String(status)) : db.designs;
  res.json(envelope(true, 'Designs retrieved', { designs: designs.map(withPublicImageUrl) }));
});

app.get('/v1/designs/:id', (req, res) => {
  const db = loadDb();
  const design = db.designs.find((d) => d.id === req.params.id);
  if (!design) {
    return res.status(404).json(errorEnvelope(404, 'NOT_FOUND', 'Design not found'));
  }
  res.json(envelope(true, 'Design retrieved', { ...withPublicImageUrl(design) }));
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
  res.json(envelope(true, 'Design approved — ready to post', { ...withPublicImageUrl(design) }));
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
  res.json(envelope(true, 'Design rejected', { ...withPublicImageUrl(design) }));
});

// --- Sales: catalogue (Paystack), orders, customers (Ada) ---------------------
// Product truth (name/price/stock/photo) lives in PAYSTACK — external system,
// agent-readable and agent-updatable. Orders/customers live here. Kobo in/out
// (Paystack's NGN subunit is kobo too). Without PAYSTACK_SECRET_KEY the client
// runs an in-process fixture, so tests never dial out.

function paystackHttpError(res: Response, err: any): void {
  if (err?.code === 'PAYSTACK_NOT_FOUND') {
    res.status(404).json(errorEnvelope(404, 'NOT_FOUND', err.message || 'Not found'));
    return;
  }
  res
    .status(503)
    .json(errorEnvelope(503, 'PAYSTACK_UNAVAILABLE', err?.message || 'Paystack request failed'));
}

// GET /v1/products — the catalogue Ada quotes from (+ the hosted shop link).
app.get('/v1/products', async (_req, res) => {
  try {
    const products = await listProducts();
    res.json(envelope(true, 'Products retrieved', { storefront_url: storefrontUrl(), products }));
  } catch (err) {
    paystackHttpError(res, err);
  }
});

// GET /v1/products/:id — one product (photo, price, stock, buy link).
app.get('/v1/products/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res
      .status(422)
      .json(errorEnvelope(422, 'VALIDATION_FAILED', 'product id must be a number'));
  }
  try {
    res.json(envelope(true, 'Product retrieved', { product: await getProduct(id) }));
  } catch (err) {
    paystackHttpError(res, err);
  }
});

// PUT /v1/products/:id — the agent's catalogue edit: change price in chat,
// see it change in Paystack (the owner beat from the storyboard).
app.put('/v1/products/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res
      .status(422)
      .json(errorEnvelope(422, 'VALIDATION_FAILED', 'product id must be a number'));
  }
  const body = req.body || {};
  const patch: Record<string, unknown> = {};
  if (body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isInteger(price) || price <= 0) {
      return res
        .status(422)
        .json(errorEnvelope(422, 'VALIDATION_FAILED', 'price must be a positive integer in kobo'));
    }
    patch.price = price;
  }
  for (const field of ['name', 'description'] as const) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== 'string' || !String(body[field]).trim()) {
        return res
          .status(422)
          .json(errorEnvelope(422, 'VALIDATION_FAILED', `${field} must be a non-empty string`));
      }
      patch[field] = String(body[field]).trim();
    }
  }
  if (body.quantity !== undefined) {
    const qty = Number(body.quantity);
    if (!Number.isInteger(qty) || qty < 0) {
      return res
        .status(422)
        .json(errorEnvelope(422, 'VALIDATION_FAILED', 'quantity must be a whole number 0 or more'));
    }
    patch.quantity = qty;
  }
  if (Object.keys(patch).length === 0) {
    return res
      .status(422)
      .json(
        errorEnvelope(422, 'VALIDATION_FAILED', 'provide at least one of: price, name, description, quantity')
      );
  }
  try {
    const product = await updateProduct(id, patch);
    res.json(envelope(true, 'Product updated', { product }));
  } catch (err) {
    paystackHttpError(res, err);
  }
});

// POST /v1/orders — customer wants a product: record the order and open a
// real Paystack payment window in one call. Retry-safe: an open order for the
// same customer+product returns the existing one instead of doubling.
app.post('/v1/orders', async (req, res) => {
  const db = loadDb();
  const body = req.body || {};
  const productId = Number(body.product_id);
  const name = typeof body.customer_name === 'string' ? body.customer_name.trim() : '';
  const email = typeof body.customer_email === 'string' ? body.customer_email.trim().toLowerCase() : '';

  if (!Number.isInteger(productId) || productId <= 0) {
    return res
      .status(422)
      .json(errorEnvelope(422, 'VALIDATION_FAILED', 'product_id is required (Paystack product id)'));
  }
  if (!name) {
    return res.status(422).json(errorEnvelope(422, 'VALIDATION_FAILED', 'customer_name is required'));
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res
      .status(422)
      .json(errorEnvelope(422, 'VALIDATION_FAILED', 'customer_email must be an email address'));
  }

  let product;
  try {
    product = await getProduct(productId);
  } catch (err) {
    if ((err as any)?.code === 'PAYSTACK_NOT_FOUND') {
      try {
        const ids = (await listProducts()).map((p) => p.id).join(', ');
        return res
          .status(422)
          .json(errorEnvelope(422, 'VALIDATION_FAILED', `product_id must be one of: ${ids}`));
      } catch {
        return paystackHttpError(res, err);
      }
    }
    return paystackHttpError(res, err);
  }

  const existing = db.orders.find(
    (o) =>
      o.product_id === productId &&
      o.customer_email === email &&
      (o.status === 'pending' || o.status === 'offer_sent')
  );
  if (existing) {
    return res.json(
      envelope(true, 'An open order for this customer and product already exists', {
        ...existing,
        replay: true
      })
    );
  }

  // Optional size agreed in chat (the skill's age/measure chart) — recorded on
  // the order; Paystack has no size field, so ours is the system of record.
  const size =
    typeof body.size === 'string' && body.size.trim() ? body.size.trim().slice(0, 24) : null;

  const id = `OR_${randomUUID().slice(0, 8)}`;
  // Test hook: email 'unpaid-…' opens a window that verifies as NOT paid, so
  // the drop-off path is demoable without a real checkout (mirrors the seed's
  // deliberate failure-path fixtures).
  const reference = email.startsWith('unpaid-')
    ? `unpaid-${id.slice(3)}`
    : `blsm-or-${id.slice(3)}`;

  let payment;
  try {
    payment = await initializeTransaction({
      amountKobo: product.price,
      email,
      reference,
      metadata: { order_id: id, product_id: productId }
    });
  } catch (err) {
    return paystackHttpError(res, err);
  }

  const order: Order = {
    id,
    product_id: productId,
    product_name: product.name,
    amount: product.price,
    currency: 'NGN',
    customer_name: name,
    customer_email: email,
    size,
    status: 'pending',
    paystack_reference: payment.reference,
    payment_url: payment.authorization_url,
    link_attempts: 1,
    discount_note: null,
    created_at: new Date().toISOString()
  };
  db.orders.push(order);
  saveDb(db);
  res
    .status(201)
    .json(envelope(true, 'Order created — payment window is open', { order: { ...order } }));
});

// GET /v1/orders — pipeline view (?status=pending|offer_sent|paid|lead)
app.get('/v1/orders', (req, res) => {
  const db = loadDb();
  const status = req.query.status;
  if (status !== undefined) {
    const allowed = ['pending', 'offer_sent', 'paid', 'lead'];
    if (!allowed.includes(String(status))) {
      return res
        .status(422)
        .json(errorEnvelope(422, 'VALIDATION_FAILED', `status must be one of: ${allowed.join(', ')}`));
    }
  }
  const orders = status ? db.orders.filter((o) => o.status === String(status)) : db.orders;
  res.json(envelope(true, 'Orders retrieved', { orders: orders.map((o) => ({ ...o })) }));
});

// GET /v1/orders/:id — one order.
app.get('/v1/orders/:id', (req, res) => {
  const db = loadDb();
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) {
    return res.status(404).json(errorEnvelope(404, 'NOT_FOUND', 'Order not found'));
  }
  res.json(envelope(true, 'Order retrieved', { order: { ...order } }));
});

// POST /v1/orders/:id/payment-link — (re)open a payment window; optional
// amount in kobo powers the 10%-off recovery offer from the storyboard.
app.post('/v1/orders/:id/payment-link', async (req, res) => {
  const db = loadDb();
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) {
    return res.status(404).json(errorEnvelope(404, 'NOT_FOUND', 'Order not found'));
  }
  if (order.status === 'paid') {
    return res
      .status(409)
      .json(errorEnvelope(409, 'INVALID_STATE', 'Order is already paid'));
  }
  const body = req.body || {};
  if (body.amount !== undefined) {
    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      return res
        .status(422)
        .json(errorEnvelope(422, 'VALIDATION_FAILED', 'amount must be a positive integer in kobo'));
    }
    order.amount = amount;
    if (body.note) order.discount_note = String(body.note);
  }

  const attempts = order.link_attempts + 1;
  const reference = order.customer_email.startsWith('unpaid-')
    ? `unpaid-${order.id.slice(3)}-${attempts}`
    : `blsm-or-${order.id.slice(3)}-${attempts}`;

  let payment;
  try {
    payment = await initializeTransaction({
      amountKobo: order.amount,
      email: order.customer_email,
      reference,
      metadata: { order_id: order.id, product_id: order.product_id }
    });
  } catch (err) {
    return paystackHttpError(res, err);
  }

  order.paystack_reference = payment.reference;
  order.payment_url = payment.authorization_url;
  order.link_attempts = attempts;
  saveDb(db);
  res.json(
    envelope(true, 'Payment window opened', { order: { ...order }, payment_url: payment.authorization_url })
  );
});

// POST /v1/orders/:id/verify — did they actually pay? Only 'success' flips the
// order; a verified customer is recorded as a Customer (or their count grows).
app.post('/v1/orders/:id/verify', async (req, res) => {
  const db = loadDb();
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) {
    return res.status(404).json(errorEnvelope(404, 'NOT_FOUND', 'Order not found'));
  }
  if (order.status === 'paid') {
    const customer = db.customers.find((c) => c.email === order.customer_email);
    return res.json(
      envelope(true, 'Order is already paid', { paid: true, order: { ...order }, customer: customer ? { ...customer } : null })
    );
  }
  if (!order.paystack_reference) {
    return res
      .status(409)
      .json(errorEnvelope(409, 'INVALID_STATE', 'No payment window has been opened for this order'));
  }

  const verification = await verifyTransaction(order.paystack_reference);
  if (!verification.paid) {
    return res.json(
      envelope(true, 'Payment not confirmed yet', {
        paid: false,
        verification_status: verification.status,
        order: { ...order }
      })
    );
  }

  order.status = 'paid';
  order.paid_at = verification.paid_at || new Date().toISOString();

  let customer = db.customers.find((c) => c.email === order.customer_email);
  if (customer) {
    customer.orders_count += 1;
    customer.total_spent += order.amount;
    customer.updated_at = new Date().toISOString();
  } else {
    customer = {
      id: `cus_${randomUUID().slice(0, 8)}`,
      name: order.customer_name,
      email: order.customer_email,
      orders_count: 1,
      total_spent: order.amount,
      created_at: new Date().toISOString()
    };
    db.customers.push(customer);
  }
  saveDb(db);
  res.json(
    envelope(true, 'Payment confirmed — order paid', {
      paid: true,
      order: { ...order },
      customer: { ...customer }
    })
  );
});

// POST /v1/orders/:id/status — tag the pipeline: follow-up offer sent, or
// drop-off (lead). Paid orders never change.
app.post('/v1/orders/:id/status', (req, res) => {
  const db = loadDb();
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) {
    return res.status(404).json(errorEnvelope(404, 'NOT_FOUND', 'Order not found'));
  }
  const { status, note } = req.body || {};
  if (status !== 'offer_sent' && status !== 'lead') {
    return res
      .status(422)
      .json(errorEnvelope(422, 'VALIDATION_FAILED', 'status must be one of: offer_sent, lead'));
  }
  if (order.status === 'paid') {
    return res.status(409).json(errorEnvelope(409, 'INVALID_STATE', 'Order is already paid'));
  }
  if (order.status === status) {
    return res.json(envelope(true, `Order is already marked ${status}`, { order: { ...order } }));
  }
  // pending -> offer_sent | lead ; lead <-> offer_sent (a new round); nothing else.
  const allowed =
    order.status === 'pending' ||
    (order.status === 'offer_sent' && status === 'lead') ||
    (order.status === 'lead' && status === 'offer_sent');
  if (!allowed) {
    return res
      .status(409)
      .json(errorEnvelope(409, 'INVALID_STATE', `Cannot move an order from ${order.status} to ${status}`));
  }
  order.status = status;
  order.flagged_at = new Date().toISOString();
  if (status === 'offer_sent' && note) order.discount_note = String(note);
  saveDb(db);
  res.json(envelope(true, `Order marked ${status}`, { order: { ...order } }));
});

// GET /v1/customers — everyone who has paid (the customers list).
app.get('/v1/customers', (_req, res) => {
  const db = loadDb();
  res.json(envelope(true, 'Customers retrieved', { customers: db.customers.map((c) => ({ ...c })) }));
});

// --- MCP (Chord's tool surface) ---------------------------------------------
// Stateless Streamable HTTP at POST /mcp — own Bearer auth, registered in
// Admin -> Channels & Tools -> Custom tools (MCP). Tools self-call /v1 below.
mountMcp(app);

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
