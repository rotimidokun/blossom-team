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

// --- sales (Ada: products live in Paystack; orders/customers live here) -------

export type OrderStatus = 'pending' | 'offer_sent' | 'paid' | 'lead';

/**
 * A sale in progress. Product truth (name/price/stock/photo) lives in
 * Paystack; the order tracks the conversation-side state machine:
 * pending -> offer_sent -> paid, with 'lead' for a drop-off that never paid.
 */
export interface Order {
  id: string; // OR_xxxxxxxx
  product_id: number; // Paystack product id
  product_name: string;
  amount: number; // kobo — what the customer must pay now
  currency: 'NGN';
  customer_name: string;
  customer_email: string;
  /** Chosen size from the skill's chart (e.g. "7-8y") — captured in chat. */
  size: string | null;
  status: OrderStatus;
  /** Latest Paystack /transaction/initialize reference + checkout link. */
  paystack_reference: string | null;
  payment_url: string | null;
  link_attempts: number; // how many payment windows we've opened
  discount_note: string | null; // e.g. "10% recovery offer"
  created_at: string;
  flagged_at?: string; // when it became offer_sent or lead
  paid_at?: string;
}

/** A customer record — created the moment a payment verifies. */
export interface Customer {
  id: string; // cus_xxxxxxxx
  name: string;
  email: string;
  orders_count: number;
  total_spent: number; // kobo
  created_at: string;
  updated_at?: string;
}

// --- staff & salaries (Kemi: monthly payday for the AI team) ------------------

/**
 * A payroll member. The three AI teammates ARE the staff — the owner is not
 * on payroll (owners draw, they don't take a salary). Made-up monthly salary
 * in kobo (Paystack convention). `recipient_code` is the Paystack transfer
 * recipient; the single test recipient is reused across the team until
 * per-staff recipients are created (go-live task).
 */
export interface Staff {
  id: string; // stf_kemi
  name: string;
  role: string;
  salary: number; // kobo per month
  agent: boolean; // one of the Chord teammates
  recipient_code: string | null;
}

/**
 * One salary attempt. `paid` only when money actually moved — either the
 * vending wallet debit (`source: 'wallet'`, the demo path while Paystack's
 * test transfer channel is blocked, see SALARY_SOURCE) or a real Paystack
 * transfer (`source: 'paystack'`). A failure is recorded as `failed` with the
 * reason, never as a payslip (skill rule: never claim money that isn't confirmed).
 */
export interface SalaryPayment {
  id: string; // sal_xxxxxxxx
  staff_id: string;
  staff_name: string;
  amount: number; // kobo
  currency: 'NGN';
  month: string; // YYYY-MM
  status: 'paid' | 'failed';
  source: 'wallet' | 'paystack';
  transfer_reference: string | null;
  transfer_code: string | null; // null on wallet payments (no Paystack transfer)
  failure_reason: string | null;
  created_at: string;
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
  orders: Order[];
  customers: Customer[];
  staff: Staff[];
  salaries: SalaryPayment[];
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
  | 'PAYSTACK_UNAVAILABLE'
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
