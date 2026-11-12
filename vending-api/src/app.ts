/**
 * Blossom by TC API (Express) — one server, three teammates' tools:
 * Kemi (wallet/validation/purchases/payroll), Mae (design approval queue),
 * Ada (Paystack catalogue/orders/payments).
 *
 * Conventions mirror the APIs we studied: Paystack-style {status,message,data}
 * envelope, bearer auth on /v1, amounts in kobo, Idempotency-Key on purchases,
 * machine-readable error codes the skills branch on.
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
  checkBalance,
  getProduct,
  initializeTransaction,
  listProducts,
  storefrontUrl,
  transfer,
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
  Order,
  SalaryPayment,
  Staff
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
// Cost cap — read at request time so tests/ops can change it without a restart.
function maxGenerations(): number {
  return Number(process.env.MAE_MAX_GENERATIONS) || 10;
}

// --- app -------------------------------------------------------------------

export const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json(envelope(true, 'ok'));
});

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
// Two paths, both traced by reference so the same money can never count twice:
//   a) push — owner transfers to the biller account -> /v1/wallet/incoming
//   b) pull — Paystack test POST /transfer -> /v1/wallet/paystack-funded

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

// --- phone resolution ---------------------------------------------------------
// NOTHING is stored (ground rules: no real personal numbers) — validity and
// network are computed per call. MNP: a prefix is only a hint, so for unknown
// numbers the buyer's stated network wins; seed fixtures are exact truth.
const NETWORK_PREFIXES: [string, string][] = (
  [
    // MTN (5-digit sub-prefixes first via longest-match sorting)
    ['07025', 'MTN'], ['07026', 'MTN'],
    ['0803', 'MTN'], ['0806', 'MTN'], ['0703', 'MTN'], ['0706', 'MTN'], ['0704', 'MTN'],
    ['0810', 'MTN'], ['0813', 'MTN'], ['0814', 'MTN'], ['0816', 'MTN'],
    ['0903', 'MTN'], ['0906', 'MTN'], ['0913', 'MTN'], ['0916', 'MTN'],
    // Glo
    ['0805', 'GLO'], ['0807', 'GLO'], ['0705', 'GLO'], ['0811', 'GLO'],
    ['0815', 'GLO'], ['0905', 'GLO'], ['0915', 'GLO'],
    // Airtel
    ['0802', 'AIRTEL'], ['0808', 'AIRTEL'], ['0701', 'AIRTEL'], ['0708', 'AIRTEL'],
    ['0812', 'AIRTEL'], ['0901', 'AIRTEL'], ['0902', 'AIRTEL'], ['0904', 'AIRTEL'],
    ['0907', 'AIRTEL'], ['0911', 'AIRTEL'], ['0912', 'AIRTEL'],
    // 9mobile
    ['0809', '9MOBILE'], ['0817', '9MOBILE'], ['0818', '9MOBILE'],
    ['0908', '9MOBILE'], ['0909', '9MOBILE']
  ] as [string, string][]
).sort((a, b) => b[0].length - a[0].length); // longest prefix first (07025 beats 0702/0703...)

/** Accept 0XXXXXXXXXX, +234XXXXXXXXXX, 234XXXXXXXXXX, and formatted input;
 *  everything becomes the canonical 11-digit 0-form. Nothing is persisted. */
function normalizePhone(raw: string): string {
  let s = String(raw).replace(/[\s\-().]/g, '');
  if (s.startsWith('+234')) s = `0${s.slice(4)}`;
  else if (s.startsWith('234') && s.length === 13) s = `0${s.slice(3)}`;
  return s;
}

function detectNetwork(normalized: string): string | null {
  for (const [prefix, network] of NETWORK_PREFIXES) {
    if (normalized.startsWith(prefix)) return network;
  }
  return null;
}

interface ResolvedPhone {
  phone_number: string;
  network: string | null;
  valid: boolean;
  /** true = came from the seeded fixtures (exact truth, strict cross-check). */
  from_fixture: boolean;
}

/** Fixture first (incl. the deliberately-invalid demo line), then format+prefix. */
function resolvePhone(db: Db, raw: string): ResolvedPhone {
  const normalized = normalizePhone(raw);
  const fixture = db.phones.find((p) => p.phone_number === normalized);
  if (fixture) {
    return { phone_number: fixture.phone_number, network: fixture.network, valid: fixture.valid, from_fixture: true };
  }
  // 11 digits total: leading 0, then 7/8/9, then 9 more (a 10-digit tail).
  if (!/^0[789]\d{9}$/.test(normalized)) {
    return { phone_number: normalized, network: null, valid: false, from_fixture: false };
  }
  return { phone_number: normalized, network: detectNetwork(normalized), valid: true, from_fixture: false };
}

app.post('/v1/validate/phone', (req, res) => {
  const db = loadDb();
  const { phone_number } = req.body || {};

  if (!phone_number) {
    return res
      .status(422)
      .json(errorEnvelope(422, 'VALIDATION_FAILED', 'phone_number is required'));
  }

  const resolved = resolvePhone(db, String(phone_number));
  if (!resolved.valid) {
    return res
      .status(400)
      .json(errorEnvelope(400, 'INVALID_PHONE', 'Phone number is not a valid Nigerian line'));
  }

  res.json(
    envelope(true, 'Phone validated', {
      valid: true,
      phone_number: resolved.phone_number,
      network: resolved.network
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

  const resolved = resolvePhone(db, String(phone_number));
  if (!resolved.valid) {
    return res
      .status(400)
      .json(errorEnvelope(400, 'INVALID_PHONE', 'Phone number is not a valid Nigerian line'));
  }
  // Strict cross-check only for fixture numbers (we KNOW their network). For
  // prefix-detected numbers MNP means the prefix can lag reality — the buyer's
  // stated network wins rather than hard-failing a legitimately ported line.
  if (network && resolved.from_fixture && resolved.network && network !== resolved.network) {
    return res
      .status(400)
      .json(
        errorEnvelope(400, 'VALIDATION_FAILED', `Phone belongs to ${resolved.network}, not ${network}`)
      );
  }
  const finalNetwork = network || resolved.network || 'Unknown';
  if (walletTooSmall(res, db, amount)) return;

  db.wallet.balance -= amount;
  const purchase: AirtimePurchase = {
    id: `pur_${randomUUID().slice(0, 8)}`,
    kind: 'airtime',
    status: 'success',
    amount,
    currency: 'NGN',
    phone_number: resolved.phone_number,
    // Buyer-stated network when given (MNP), else prefix detection, else Unknown.
    network: finalNetwork,
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

// --- designs (Mae's approval queue) — the agent NEVER publishes; approve and
// reject are the human's action.

/** Serve a generated image by filename (no auth — it's a shareable link). */
app.get('/images/:file', (req, res) => {
  const file = req.params.file.replace(/[^a-zA-Z0-9._-]/g, ''); // no path traversal
  const path = join(IMAGES_DIR, file);
  if (!existsSync(path)) {
    return res.status(404).json(errorEnvelope(404, 'NOT_FOUND', 'Image not found'));
  }
  res.sendFile(path);
});

// The garment store — the brand's real dresses, used as image-model references.
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
 * Rewrite image_url to an absolute PUBLIC_BASE_URL link in responses only —
 * the DB always keeps the canonical relative path.
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

  // Record first, answer immediately; the 15-45s generation runs detached so
  // no connection stays open long enough for a flaky link to kill the turn
  // (2026-11-05: sync generation produced 502s and an aborted process).
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

      // Stamp the real logo (the model is told never to draw it); mock skips
      // this, and a stamping failure never fails the generation.
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

// --- Sales (Ada): product truth lives in PAYSTACK; orders/customers live here.
// Without PAYSTACK_SECRET_KEY the client runs an in-process fixture, so tests
// never dial out.

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

// PUT /v1/products/:id — the agent's catalogue edit (visible in Paystack too).
app.put('/v1/products/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res
      .status(422)
      .json(errorEnvelope(422, 'VALIDATION_FAILED', 'product id must be a number'));
  }
  const body = req.body || {};

  // Owner-code gate — server-side check; the agent's claim is never taken at
  // face value (same tier as payroll).
  const expectedCode = process.env.OWNER_CODE || '';
  const ownerCode = typeof body.owner_code === 'string' ? body.owner_code : '';
  if (!expectedCode) {
    return res
      .status(503)
      .json(errorEnvelope(503, 'FORBIDDEN', 'OWNER_CODE is not configured on this server'));
  }
  if (ownerCode !== expectedCode) {
    return res
      .status(403)
      .json(errorEnvelope(403, 'FORBIDDEN', 'Owner code is not valid — catalogue unchanged'));
  }

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
  const startedAt = Date.now();
  console.log(`[orders] POST /v1/orders received`);
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

  // Size agreed in chat — Paystack has no size field, so ours is the record.
  const size =
    typeof body.size === 'string' && body.size.trim() ? body.size.trim().slice(0, 24) : null;

  const id = `OR_${randomUUID().slice(0, 8)}`;
  // Test hook: email 'unpaid-…' verifies as NOT paid — drop-off demo path.
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
  console.log(`[orders] ${id} created in ${Date.now() - startedAt}ms`);
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

// POST /v1/orders/:id/payment-link — (re)open a window; optional amount powers
// the discounted recovery offer.
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

  // Stock: a verified payment sells one unit (capped at 0; unlimited/null
  // untouched). Best-effort — a stock-update failure never fails an order
  // that Paystack already confirmed as paid.
  try {
    const product = await getProduct(order.product_id);
    if (typeof product.quantity === 'number' && product.quantity > 0) {
      await updateProduct(order.product_id, { quantity: Math.max(0, product.quantity - 1) });
    }
  } catch (err) {
    console.warn(
      `[stock] decrement failed for product ${order.product_id} (order ${order.id}): ${(err as Error).message}`
    );
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

// --- Paystack bank balance — the OTHER pot: wallet = petty cash, this = bank.
app.get('/v1/paystack/balance', async (_req, res) => {
  try {
    const balance = await checkBalance();
    res.json(
      envelope(true, 'Paystack balance retrieved', {
        balance: balance.balance,
        currency: balance.currency
      })
    );
  } catch (err) {
    paystackHttpError(res, err);
  }
});

// --- Staff & salaries (Kemi: monthly payday, owner-code gated) ----------------
// Every attempt is recorded `paid` or `failed` (exact reason) — a failure is
// never dressed up as a payslip. SALARY_SOURCE picks the pot: 'wallet'
// (default — Paystack's test transfer channel rejects sends, 403, 2026-11-09)
// or 'paystack' (real POST /transfer; flip when the channel works).

/** YYYY-MM, e.g. 2026-11. */
function isValidMonth(m: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
}

app.get('/v1/staff', (_req, res) => {
  const db = loadDb();
  res.json(envelope(true, 'Staff retrieved', { staff: db.staff.map((s) => ({ ...s })) }));
});

app.get('/v1/salaries', (req, res) => {
  const db = loadDb();
  const staffId = req.query.staff_id;
  const month = req.query.month;
  let salaries: SalaryPayment[] = db.salaries;
  if (staffId !== undefined) salaries = salaries.filter((s) => s.staff_id === String(staffId));
  if (month !== undefined) salaries = salaries.filter((s) => s.month === String(month));
  res.json(envelope(true, 'Salary history retrieved', { salaries: salaries.map((s) => ({ ...s })) }));
});

app.post('/v1/salaries', async (req, res) => {
  const db = loadDb();
  const body = req.body || {};
  const month = body.month === undefined ? new Date().toISOString().slice(0, 7) : String(body.month);
  const ownerCode = typeof body.owner_code === 'string' ? body.owner_code : '';
  const expectedCode = process.env.OWNER_CODE || '';

  // Identity gate — fail closed: no configured code means nobody can run payroll.
  if (!expectedCode) {
    return res
      .status(503)
      .json(errorEnvelope(503, 'FORBIDDEN', 'OWNER_CODE is not configured on this server'));
  }
  if (ownerCode !== expectedCode) {
    return res
      .status(403)
      .json(errorEnvelope(403, 'FORBIDDEN', 'Owner code is not valid — payroll did not run'));
  }
  if (!isValidMonth(month)) {
    return res
      .status(422)
      .json(errorEnvelope(422, 'VALIDATION_FAILED', 'month must be YYYY-MM (e.g. 2026-11)'));
  }

  // Target: one staff member, or everyone (the normal payday run).
  let targets: Staff[] = db.staff;
  if (body.staff_id !== undefined) {
    const one = db.staff.find((s) => s.id === String(body.staff_id));
    if (!one) {
      const ids = db.staff.map((s) => s.id).join(', ');
      return res
        .status(422)
        .json(errorEnvelope(422, 'VALIDATION_FAILED', `staff_id must be one of: ${ids}`));
    }
    targets = [one];
  }
  if (targets.length === 0) {
    return res.status(422).json(errorEnvelope(422, 'VALIDATION_FAILED', 'No staff on the payroll'));
  }

  const results: SalaryPayment[] = [];
  let skipped = 0;
  for (const member of targets) {
    const already = db.salaries.find(
      (s) => s.staff_id === member.id && s.month === month && s.status === 'paid'
    );
    if (already) {
      skipped += 1; // never pay the same month twice
      continue;
    }

    // Unique reference per attempt (Paystack rejects duplicate references).
    const attempts =
      db.salaries.filter((s) => s.staff_id === member.id && s.month === month).length + 1;
    const reference =
      attempts > 1 ? `sal-${member.id}-${month}-${attempts}` : `sal-${member.id}-${month}`;

    const usePaystack = process.env.SALARY_SOURCE === 'paystack';
    let record: SalaryPayment;

    if (!usePaystack && db.wallet.balance < member.salary) {
      // Petty-cash path: the wallet can't cover it — record the attempt as
      // failed with the exact truth. No money moves; retryable after funding.
      const reason =
        `Vending wallet balance ${naira(db.wallet.balance)} is below the salary amount ` +
        `${naira(member.salary)} — fund the wallet first`;
      record = {
        id: `sal_${randomUUID().slice(0, 8)}`,
        staff_id: member.id,
        staff_name: member.name,
        amount: member.salary,
        currency: 'NGN',
        month,
        status: 'failed',
        source: 'wallet',
        transfer_reference: null,
        transfer_code: null,
        failure_reason: reason,
        created_at: new Date().toISOString()
      };
      console.error(`[salary] ${member.name} ${month} FAILED: ${reason}`);
    } else {
      try {
        let source: 'wallet' | 'paystack';
        let transferReference: string;
        let transferCode: string | null = null;

        if (usePaystack) {
          const transferResult = await transfer({
            amountKobo: member.salary,
            reference,
            reason: `${month} salary — ${member.name} (${member.role})`
          });
          source = 'paystack';
          transferReference = transferResult.reference;
          transferCode = transferResult.transfer_code;
        } else {
          // Petty-cash path: debit the wallet (the money really moves, in-ledger).
          db.wallet.balance -= member.salary;
          source = 'wallet';
          transferReference = `wal-${member.id}-${month}`;
        }

        record = {
          id: `sal_${randomUUID().slice(0, 8)}`,
          staff_id: member.id,
          staff_name: member.name,
          amount: member.salary,
          currency: 'NGN',
          month,
          status: 'paid',
          source,
          transfer_reference: transferReference,
          transfer_code: transferCode,
          failure_reason: null,
          created_at: new Date().toISOString()
        };
        console.log(
          `[salary] ${member.name} ${month} PAID ${member.salary / 100} NGN from ${source}` +
            ` (${transferCode || transferReference})`
        );
      } catch (err) {
        const reason = (err as Error).message || 'Transfer failed';
        record = {
          id: `sal_${randomUUID().slice(0, 8)}`,
          staff_id: member.id,
          staff_name: member.name,
          amount: member.salary,
          currency: 'NGN',
          month,
          status: 'failed',
          source: 'paystack',
          transfer_reference: reference,
          transfer_code: null,
          failure_reason: reason,
          created_at: new Date().toISOString()
        };
        console.error(`[salary] ${member.name} ${month} FAILED: ${reason}`);
      }
    }
    db.salaries.push(record);
    results.push(record);
  }
  saveDb(db);

  const paid = results.filter((r) => r.status === 'paid').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const message =
    results.length === 0
      ? `${month} payroll already completed — nobody left to pay`
      : failed === 0
        ? `Payday run complete — ${paid} paid for ${month}`
        : `Payday run recorded — ${paid} paid, ${failed} failed for ${month}`;
  res.status(201).json(
    envelope(true, message, {
      month,
      paid,
      failed,
      skipped,
      paid_from: process.env.SALARY_SOURCE === 'paystack' ? 'paystack' : 'wallet',
      wallet_balance_after: db.wallet.balance,
      total_paid_kobo: results
        .filter((r) => r.status === 'paid')
        .reduce((sum, r) => sum + r.amount, 0),
      salaries: results.map((r) => ({ ...r }))
    })
  );
});

// --- MCP (Chord's tool surface) — registered in Admin -> Custom tools (MCP).
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
