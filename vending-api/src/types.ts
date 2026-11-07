/**
 * Shared domain types for the Blossom by TC vending API.
 *
 * Derived from src/seed.js (the canonical data shape) and the response
 * envelope used by every route. Amounts are in kobo (NGN x100),
 * matching Paystack's convention: NGN 100 = 10000.
 */

// --- wallet -----------------------------------------------------------------

export interface Wallet {
  currency: 'NGN';
  balance: number; // kobo
  low_balance_threshold: number; // kobo
  account_number: string; // made-up biller account for bank-transfer funding
  bank: string;
}

export type FundingSource = 'bank_transfer' | 'paystack';

/** A recorded wallet credit — the audit trail behind /v1/wallet/incoming. */
export interface FundingCredit {
  id: string; // cr_xxxxxxxx
  amount: number; // kobo
  currency: 'NGN';
  source: FundingSource;
  reference: string;
  balance_after: number; // kobo
  created_at: string; // ISO timestamp
}

// --- catalogue (seeded) -----------------------------------------------------

export type MeterType = 'prepaid' | 'postpaid';

export interface Meter {
  meter_number: string;
  disco: string;
  type: MeterType;
  owner_name: string;
  available: boolean; // false = deliberate failure-path demo (DISCO_UNAVAILABLE)
}

export interface Phone {
  phone_number: string;
  network: string | null; // null when the line is invalid
  valid: boolean;
}

// --- purchases --------------------------------------------------------------

export interface ElectricityPurchase {
  id: string; // pur_xxxxxxxx
  kind: 'electricity';
  status: 'success';
  amount: number; // kobo
  currency: 'NGN';
  meter_number: string;
  disco: string;
  type: MeterType;
  owner_name: string;
  units: string; // formatted, e.g. "421.05"
  token: string; // e.g. "9639-3392-3231-1714-1560"
  reference: string; // blsm_<ts>_<rand>
  wallet_balance_after: number; // kobo
  created_at: string;
}

export interface AirtimePurchase {
  id: string;
  kind: 'airtime';
  status: 'success';
  amount: number; // kobo
  currency: 'NGN';
  phone_number: string;
  network: string;
  reference: string;
  wallet_balance_after: number; // kobo
  created_at: string;
}

export type Purchase = ElectricityPurchase | AirtimePurchase;

// --- designs (Mae's approval queue) ----------------------------------------

export type DesignKind = 'model-shot' | 'flyer' | 'slide' | 'social';
/**
 * Design lifecycle: `creating` (queued, image generating in the background —
 * the POST returns in milliseconds so a slow image provider can never hold an
 * HTTP/MCP connection open), `pending` (image ready, awaiting the owner's
 * approval), `approved` / `rejected`, `failed` (generation error — see
 * rejection_reason).
 */
export type DesignStatus = 'creating' | 'pending' | 'approved' | 'rejected' | 'failed';

export interface Design {
  id: string; // des_xxxxxxxx
  kind: DesignKind;
  brief: string;
  garment: string | null;
  prompt_used: string;
  provider: string; // 'mock' | 'gemini' | 'openrouter'
  model: string;
  mock: boolean;
  image_file: string; // e.g. "des_ab12cd34.png" — "" while status is creating
  image_url: string; // e.g. "/images/des_ab12cd34.png" — "" until the image is ready
  status: DesignStatus;
  rejection_reason: string | null;
  created_at: string;
  approved_at?: string;
  rejected_at?: string;
}

// --- database ---------------------------------------------------------------

export interface Db {
  wallet: Wallet;
  meters: Meter[];
  phones: Phone[];
  purchases: Purchase[];
  incoming: FundingCredit[];
  /** Idempotency-Key header -> purchase id (safe retries, no double-buy). */
  idempotency: Record<string, string>;
  designs: Design[];
  generation_count: number; // cost cap: images generated this session
}

// --- response envelope ------------------------------------------------------

/** Success envelope: { status, message, data } — Paystack-style. */
export interface Envelope<T> {
  status: boolean;
  message: string;
  data: T;
}

/** Error envelope: { status: false, message, data: { error: { code, status } } }. */
export interface ErrorEnvelope {
  status: false;
  message: string;
  data: { error: { code: ErrorCode; status: number } };
}

/** Machine-readable error codes — what the skills branch on. */
export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'VALIDATION_FAILED'
  | 'INVALID_METER'
  | 'INVALID_PHONE'
  | 'INSUFFICIENT_WALLET'
  | 'DISCO_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'IDEMPOTENT_REPLAY'
  | 'INVALID_STATE'
  | 'GENERATION_LIMIT'
  | 'GENERATION_IN_PROGRESS'
  | 'IMAGE_API_UNAVAILABLE'
  | 'NO_IMAGE_PROVIDER'
  | 'INTERNAL_ERROR';

// --- image generation (src/imagegen.ts) ------------------------------------

export type ImageProvider = 'mock' | 'gemini' | 'openrouter';

export interface GeneratedImage {
  prompt: string;
  imageBase64: string;
  mimeType: string;
  provider: ImageProvider;
  model: string;
  mock: boolean;
}

/** Error thrown by generateImage — carries a machine-readable code. */
export interface ImageGenError extends Error {
  code: ErrorCode;
}
