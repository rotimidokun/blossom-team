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
 * STATUS (2026-11-01): transfer() is BLOCKED on our test account — Paystack
 * rejects payouts from a "starter" (unverified) business with
 * `transfer_unavailable` ("You cannot initiate third party payouts as a
 * starter business"). The demo uses the push path instead
 * (POST /v1/wallet/incoming). This module stays as the documented go-live
 * upgrade: verify the business to Registered, then pull works unchanged.
 * checkBalance() still works today (read-only).
 *
 * Env:
 *   PAYSTACK_SECRET_KEY  sk_test_...   (if unset, calls fail with a clear message)
 *   PAYSTACK_RECIPIENT   RCP_xxx...    (the biller's recipient code, created once)
 *
 * NOTE: tests never hit the real API — they stub this module or skip it.
 */

const PAYSTACK_BASE = 'https://api.paystack.co';

function secretKey() {
  return process.env.PAYSTACK_SECRET_KEY || '';
}

async function paystackCall(method, path, body) {
  const key = secretKey();
  if (!key) {
    const err = new Error(
      'PAYSTACK_SECRET_KEY not set — add your sk_test_... key to the environment'
    );
    err.code = 'PAYSTACK_NOT_CONFIGURED';
    throw err;
  }

  const response = await fetch(`${PAYSTACK_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const json = await response.json();
  // Paystack's envelope: { status, message, data } — same shape we use.
  if (!json.status) {
    const err = new Error(json.message || 'Paystack request failed');
    err.code = 'PAYSTACK_ERROR';
    err.details = json;
    throw err;
  }
  return json.data;
}

/** GET /balance — available balance per currency (kobo for NGN). */
export async function checkBalance() {
  const data = await paystackCall('GET', '/balance');
  // Response: { balance, currency, ... } possibly wrapped in an array
  const entry = Array.isArray(data) ? data[0] : data;
  return {
    balance: Math.round(Number(entry.balance) * 100), // naira -> kobo
    currency: entry.currency || 'NGN'
  };
}

/**
 * POST /transfer — move money from the Paystack balance to the biller.
 * Returns { reference, status, amount } so the caller can record it
 * against the vending wallet (POST /v1/wallet/paystack-funded).
 */
export async function transfer({ amountKobo, reference, reason }) {
  const recipient = process.env.PAYSTACK_RECIPIENT;
  if (!recipient) {
    const err = new Error(
      'PAYSTACK_RECIPIENT not set — create a transfer recipient once (POST /transferrecipient) and put its code here'
    );
    err.code = 'PAYSTACK_NOT_CONFIGURED';
    throw err;
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
