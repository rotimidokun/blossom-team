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
  method: 'GET' | 'POST',
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
