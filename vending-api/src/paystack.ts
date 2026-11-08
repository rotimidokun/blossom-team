/**
 * Paystack test-mode client — the business's "bank".
 *
 * Real API calls to api.paystack.co using a TEST secret key (sk_test_...).
 * Test mode moves fake money through the real API, which is exactly what the
 * exercise allows: "Use test keys and made-up data only."
 *
 * Used for the pull funding path:
 *   checkBalance() -> is there money in the business's Paystack account?
 *   transfer()     -> move it to the biller (funds the vending wallet)
 *
 * STATUS (2026-11-05): the payouts gate is LIFTED. The old "starter" account
 * rejected payouts with `transfer_unavailable`; after re-onboarding as a
 * Registered Business (new key in .env), the same POST /transfer passes the
 * verification gate and now fails only with `insufficient_balance` (test
 * balance is ₦0) — i.e. the API is available, the account just needs test
 * funds. Verified by probe: GET /balance 200, POST /transferrecipient 201
 * (RCP_yab85z5ct7r24wg), POST /transfer -> insufficient_balance.
 * The demo still uses the push path (POST /v1/wallet/incoming) because the
 * test balance is empty; pull becomes the primary path once test funds exist.
 *
 * Env:
 *   PAYSTACK_SECRET_KEY  sk_test_...   (if unset, calls fail with a clear message)
 *   PAYSTACK_RECIPIENT   RCP_xxx...    (the biller's recipient code, created once)
 *
 * NOTE: tests never hit the real API — they stub this module or skip it.
 */

const PAYSTACK_BASE = 'https://api.paystack.co';

/** Paystack's envelope: { status, message, data } — same shape we use. */
interface PaystackEnvelope {
  status: boolean;
  message?: string;
  data?: unknown;
}

/** Error thrown by this client — carries a machine-readable code. */
export interface PaystackError extends Error {
  code: string;
  details?: unknown;
}

function fail(message: string, code: string, details?: unknown): PaystackError {
  const err = new Error(message) as PaystackError;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function secretKey(): string {
  return process.env.PAYSTACK_SECRET_KEY || '';
}

// Paystack's `data` payload varies per endpoint (balance vs transfer), so the
// shared caller returns it untyped and each export shapes its own response.
async function paystackCall(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: Record<string, unknown>
): Promise<any> {
  const key = secretKey();
  if (!key) {
    throw fail(
      'PAYSTACK_SECRET_KEY not set — add your sk_test_... key to the environment',
      'PAYSTACK_NOT_CONFIGURED'
    );
  }

  const response = await fetch(`${PAYSTACK_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const json = (await response.json()) as PaystackEnvelope;
  if (!json.status) {
    throw fail(json.message || 'Paystack request failed', 'PAYSTACK_ERROR', json);
  }
  return json.data;
}

/** GET /balance — available balance per currency (kobo for NGN). */
export async function checkBalance(): Promise<{ balance: number; currency: string }> {
  const data = await paystackCall('GET', '/balance');
  // Response: { balance, currency, ... } possibly wrapped in an array
  const entry = Array.isArray(data) ? data[0] : data;
  return {
    balance: Math.round(Number(entry.balance) * 100), // naira -> kobo
    currency: entry.currency || 'NGN'
  };
}

export interface TransferArgs {
  amountKobo: number;
  reference: string;
  reason?: string;
}

export interface TransferResult {
  transfer_code: string;
  reference: string;
  status: string; // 'pending' | 'success' | 'processing'
  amount: number;
}

/**
 * POST /transfer — move money from the Paystack balance to the biller.
 * Returns { reference, status, amount } so the caller can record it
 * against the vending wallet (POST /v1/wallet/paystack-funded).
 */
export async function transfer({
  amountKobo,
  reference,
  reason
}: TransferArgs): Promise<TransferResult> {
  const recipient = process.env.PAYSTACK_RECIPIENT;
  if (!recipient) {
    throw fail(
      'PAYSTACK_RECIPIENT not set — create a transfer recipient once (POST /transferrecipient) and put its code here',
      'PAYSTACK_NOT_CONFIGURED'
    );
  }

  const data = await paystackCall('POST', '/transfer', {
    source: 'balance',
    amount: amountKobo, // kobo — Paystack's unit
    recipient,
    reference,
    reason: reason || 'Vending wallet top-up'
  });

  return {
    transfer_code: data.transfer_code,
    reference: data.reference,
    status: data.status, // 'pending' | 'success' | 'processing'
    amount: data.amount
  };
}

// --- Catalogue: Products + Storefront (Ada's sales flow) ----------------------
//
// Products are the catalogue truth: name, price (kobo = Paystack subunit for
// NGN), stock, photo (files[] — dashboard upload only, the API has no image
// field). The hosted shop is the published storefront (PAYSTACK_STOREFRONT_URL).
// Without a key (tests) everything runs against an in-memory fixture that
// behaves like the API — including mutations — so no test ever dials out.

export interface PaystackProduct {
  id: number;
  name: string;
  description: string;
  price: number; // kobo
  currency: string;
  quantity: number | null;
  quantity_sold: number;
  active: boolean;
  in_stock: boolean;
  unlimited: boolean;
  slug: string;
  product_code: string;
  photo_url: string | null;
  /** Paystack's per-product hosted buy page. */
  buy_url: string | null;
}

function mockMode(): boolean {
  return !secretKey();
}

// Process-lifetime fixture store (mirrors the real products created on
// 2026-11-07: ids 2880906 / 2880907). Mutations persist for the process so
// tests can PUT a price and GET it back.
let mockCatalog: any[] | null = null;
function catalog(): any[] {
  if (!mockCatalog) {
    mockCatalog = [
      {
        id: 2880906,
        name: 'Sky Blue Dress',
        description: 'Girls dress in sky blue - Blossom by TC test catalogue',
        price: 1250000,
        currency: 'NGN',
        quantity: 10,
        quantity_sold: 0,
        active: true,
        in_stock: true,
        unlimited: false,
        slug: 'sky-blue-dress-ffurut',
        product_code: 'PROD_mock_sky_blue',
        files: [{ path: 'https://res.cloudinary.com/paystack/mock/sky-blue-dress.jpg' }]
      },
      {
        id: 2880907,
        name: 'Mint Green Dress',
        description: 'Girls dress in mint green - Blossom by TC test catalogue',
        price: 1150000,
        currency: 'NGN',
        quantity: 10,
        quantity_sold: 0,
        active: true,
        in_stock: true,
        unlimited: false,
        slug: 'mint-green-dress-mock',
        product_code: 'PROD_mock_mint_green',
        files: [{ path: 'https://res.cloudinary.com/paystack/mock/mint-green-dress.jpg' }]
      }
    ];
  }
  return mockCatalog;
}

function shapeProduct(p: any): PaystackProduct {
  const files = Array.isArray(p.files) ? p.files : [];
  return {
    id: p.id,
    name: p.name,
    description: p.description || '',
    price: p.price,
    currency: p.currency || 'NGN',
    quantity: p.quantity ?? null,
    quantity_sold: p.quantity_sold ?? 0,
    active: p.active ?? true,
    in_stock: p.in_stock ?? true,
    unlimited: p.unlimited ?? false,
    slug: p.slug || '',
    product_code: p.product_code || '',
    photo_url: files[0]?.path || null,
    buy_url: p.slug ? `https://paystack.com/buy/${p.slug}` : null
  };
}

/** GET /product — the catalogue. */
export async function listProducts(): Promise<PaystackProduct[]> {
  if (mockMode()) return catalog().map(shapeProduct);
  const data = await paystackCall('GET', '/product');
  return (Array.isArray(data) ? data : []).map(shapeProduct);
}

/** GET /product/:id — one product. Throws 'not found' style errors. */
export async function getProduct(id: number): Promise<PaystackProduct> {
  if (mockMode()) {
    const p = catalog().find((x) => x.id === id);
    if (!p) throw fail('Product not found', 'PAYSTACK_NOT_FOUND');
    return shapeProduct(p);
  }
  const data = await paystackCall('GET', `/product/${id}`);
  return shapeProduct(data);
}

/** PUT /product/:id — the agent's catalogue edit (price, name, stock...). */
export async function updateProduct(
  id: number,
  patch: Record<string, unknown>
): Promise<PaystackProduct> {
  if (mockMode()) {
    const p = catalog().find((x) => x.id === id);
    if (!p) throw fail('Product not found', 'PAYSTACK_NOT_FOUND');
    Object.assign(p, patch);
    return shapeProduct(p);
  }
  const data = await paystackCall('PUT', `/product/${id}`, patch);
  return shapeProduct(data);
}

/** The published hosted shop URL (empty when not configured). */
export function storefrontUrl(): string {
  return process.env.PAYSTACK_STOREFRONT_URL || '';
}

// --- Transactions: the payment window ---------------------------------------

export interface InitializeResult {
  authorization_url: string;
  reference: string;
  amount: number; // kobo
}

/**
 * POST /transaction/initialize — opens a real Paystack checkout window.
 * One per payment attempt; the caller stores reference + url on the order.
 */
export async function initializeTransaction({
  amountKobo,
  email,
  reference,
  metadata
}: {
  amountKobo: number;
  email: string;
  reference: string;
  metadata?: Record<string, unknown>;
}): Promise<InitializeResult> {
  if (mockMode()) {
    return {
      authorization_url: `https://checkout.paystack.com/mock-${reference}`,
      reference,
      amount: amountKobo
    };
  }
  const data = await paystackCall('POST', '/transaction/initialize', {
    amount: amountKobo, // kobo
    email,
    reference,
    currency: 'NGN',
    ...(metadata ? { metadata } : {})
  });
  return {
    authorization_url: data.authorization_url,
    reference: data.reference || reference,
    amount: amountKobo
  };
}

export interface VerifyResult {
  paid: boolean;
  status: string; // success | abandon | pending | unverifiable ...
  amount?: number;
  paid_at?: string | null;
  channel?: string;
}

/**
 * GET /transaction/verify/:reference — did the customer actually pay?
 * Unknown/abandoned references come back as NOT paid, never as a crash —
 * the skill asks again rather than inventing a result.
 * Test hook: a mock reference starting with 'unpaid-' verifies as abandon.
 */
export async function verifyTransaction(reference: string): Promise<VerifyResult> {
  if (mockMode()) {
    if (reference.startsWith('unpaid-')) {
      return { paid: false, status: 'abandon' };
    }
    return { paid: true, status: 'success', paid_at: new Date().toISOString(), channel: 'card' };
  }
  try {
    const data = await paystackCall('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    return {
      paid: data?.status === 'success',
      status: data?.status || 'unknown',
      amount: data?.amount,
      paid_at: data?.paid_at ?? null,
      channel: data?.channel
    };
  } catch {
    // Never-registered or malformed reference — not paid, no crash.
    return { paid: false, status: 'unverifiable' };
  }
}
