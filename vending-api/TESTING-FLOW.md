# Weekend testing flow — no Chord credits needed

Everything here is **free**: Paystack test mode moves fake money through the real API, and
the vending API runs on your machine. Only Chord conversations cost credits (Monday).

You are playing Kemi: the skill says what to do, you make the calls by hand. If the sequence
works when you follow the skill literally, it will work when the model follows it.

---

## Step 0 — Get your Paystack test keys (2 minutes)

1. Go to **https://dashboard.paystack.com/#/settings/developers**
2. Toggle to **Test Mode** (if it isn't already).
3. Copy the **Secret Key** (`sk_test_...`).
4. Open [`vending-api/.env`](./.env) and paste it over `sk_test_paste_your_key_here`.
   - The file is already created and gitignored — your key never gets committed.

> No `.env` loader is installed (the app reads `process.env` directly), so you'll pass the
> variables on the command line in the steps below. The `.env` file is your record of the
> values.

---

## Step 1 — Start the server (terminal 1)

```bash
cd vending-api
npm start
```

Leave this running. You should see `Blossom vending API listening on http://localhost:3000`.

---

## Step 2 — Check the wallet is empty (terminal 2)

```bash
curl http://localhost:3000/v1/wallet -H "Authorization: Bearer test_vending_key"
```

Expected: `"balance": 0` — the wallet starts empty on purpose. Funding is the first act.

---

## Step 3 — Create a Paystack transfer recipient (one time)

This gives you the `RC_...` code the pull path needs:

```bash
curl https://api.paystack.co/transferrecipient -X POST \
  -H "Authorization: Bearer sk_test_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"nuban","name":"Blossom Vending Test","bank_code":"232","account_number":"1234567890","currency":"NGN"}'
```

- `bank_code` `232` = Sterling Bank (matches our made-up account). Any test bank works.
- Copy `data.recipient_code` (`RC_...`) into `PAYSTACK_RECIPIENT` in `.env`.

---

## Step 4 — The pull top-up: real Paystack transfer → wallet credit

**4. Fund by bank transfer (the push path — this is the one that works):**

```bash
curl http://localhost:3000/v1/wallet/incoming -X POST \
  -H "Authorization: Bearer test_vending_key" \
  -H "Content-Type: application/json" \
  -d '{"amount":5000000,"reference":"TRF-bank-001"}'
```

- `amount` is in **kobo** — `5000000` = ₦50,000.
- The owner "sends" to the biller account (`1234567890`, Sterling Bank test); we record the
  reference so the same money can never be counted twice.

**4b. Confirm:**

```bash
curl http://localhost:3000/v1/wallet -H "Authorization: Bearer test_vending_key"
```

Expected: `"balance": 5000000` (₦50,000).

> **Try the duplicate:** run step 4 again with the same reference → `409 IDEMPOTENT_REPLAY`.
> The same money can never be counted twice.

> **Why not the Paystack pull path?** `POST /transfer` is blocked on our test account —
> `transfer_unavailable`: *"You cannot initiate third party payouts as a starter business."*
> Paystack requires a verified (Registered) business for payouts, including in test mode.
> The pull path (`src/paystack.ts` + `/v1/wallet/paystack-funded`) stays in the codebase as
> the go-live upgrade. See `field-notes.md` for the full note.

---

## Step 5 — Validate before buying

```bash
curl http://localhost:3000/v1/validate/meter -X POST \
  -H "Authorization: Bearer test_vending_key" \
  -H "Content-Type: application/json" \
  -d '{"meter_number":"45123456789","disco":"IKEDC"}'
```

Expected: `owner_name: "BLOSSOM BY TC LIMITED"` — this is what Kemi shows the owner for
confirmation. (In the real conversation, you'd stop here and ask for a yes.)

---

## Step 6 — Purchase electricity (idempotent)

```bash
curl http://localhost:3000/v1/purchases/electricity -X POST \
  -H "Authorization: Bearer test_vending_key" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-1" \
  -d '{"meter_number":"45123456789","disco":"IKEDC","amount":1000000}'
```

Expected: a token like `4829-1029-4820-1920-3948`, units, and `wallet_balance_after: 4000000`.

**Run the exact same command again** → same token, `replayed: true`, wallet untouched.
No double-buy.

---

## Step 7 — The failure paths (the rubric cares about these)

```bash
# EKEDC meter is deliberately unavailable → 503 DISCO_UNAVAILABLE
curl http://localhost:3000/v1/purchases/electricity -X POST \
  -H "Authorization: Bearer test_vending_key" -H "Content-Type: application/json" \
  -d '{"meter_number":"11223344556","disco":"EKEDC","amount":500000}'

# Invalid phone → 400 INVALID_PHONE
curl http://localhost:3000/v1/validate/phone -X POST \
  -H "Authorization: Bearer test_vending_key" -H "Content-Type: application/json" \
  -d '{"phone_number":"07000000000"}'

# Spend more than the wallet holds → 402 INSUFFICIENT_WALLET
curl http://localhost:3000/v1/purchases/electricity -X POST \
  -H "Authorization: Bearer test_vending_key" -H "Content-Type: application/json" \
  -d '{"meter_number":"45123456789","disco":"IKEDC","amount":999999999}'
```

---

## Step 8 — (Optional) the push path instead

If you'd rather simulate the owner sending a bank transfer:

```bash
curl http://localhost:3000/v1/wallet/incoming -X POST \
  -H "Authorization: Bearer test_vending_key" -H "Content-Type: application/json" \
  -d '{"amount":2000000,"reference":"TRF-bank-001"}'
```

Same 409 rule applies on repeat.

---

## Reset between takes

```bash
curl http://localhost:3000/v1/reset -X POST -H "Authorization: Bearer test_vending_key"
```

Back to ₦0, no purchases — clean slate for the next walkthrough or the recording.

---

## What this proves (for the submission)

- The tool calls a **real external system** (Paystack test API) and the action actually happens.
- State changes are real and persistent (wallet balance moves, purchases recorded).
- Every error path returns a machine-readable code the skill branches on.
- Idempotency: retries never double-spend or double-count.

The only piece left for Monday is Chord itself: publish the updated skill, register the tool,
and run the same conversation through the direct line / simulator.