# Paystack API — working reference

Short reference for building the custom tool. Sources (read 2026-10-31):
- API reference: https://paystack.com/docs/api/
- Guides/docs home: https://paystack.com/docs/ — sections: Payments, Transfers, Identity Verification, Developer Tools, Guides

Verify endpoint details against the Transactions and Transfers doc pages before finalizing the tool.

## Basics

- **Base URL:** `https://api.paystack.co` — same URL for test and live; the **API key determines the environment**.
- **Auth:** `Authorization: Bearer YOUR_SECRET_KEY` on every request.
- **Keys:** free Paystack account gives test keys; test keys = test environment (allowed by exercise ground rules: "test keys and made-up data only"). Never commit live keys.
- **HTTPS only.** JSON request and response bodies.

## Response envelope

Every response:

```json
{ "status": true, "message": "...", "data": { } }
```

- `status` (boolean) — success/failure; use together with the HTTP status code.
- `message` (string) — human summary; on errors it describes the error.
- `data` (object|array) — the result.
- `meta` (object) — pagination on list endpoints; **diagnostic info on failed requests** (useful for field notes).

Our MCP tool should mirror this shape so the skill's error handling is predictable:
`status: false` → surface `message` to the user, do not pretend success.

## Money

- Amounts are in **subunits**: NGN subunit = kobo, multiply by 100. ₦100 → `10000`.
- NGN transaction minimum: ₦50.00.
- Currency codes are ISO 4217 (`NGN`).

## Endpoints we plan to use

| Endpoint | Purpose | Teammate |
|---|---|---|
| `POST /transaction/initialize` | Create a payment link (recovery offer for an abandoned cart) — confirmed on docs home with cURL example: `Authorization: Bearer YOUR_SECRET_KEY`, `Content-Type: application/json` | Ada (sales) |
| `POST /transaction/verify` | Confirm whether the test payment actually happened | Ada (sales) |
| `POST /transferrecipient` | Create a recipient bank account — confirmed on docs home ("Make a transfer" flow: recipient first, then transfer) | HR/Admin (salaries) |
| `POST /transfer` (+ list/verify) | Send money out — salary/payslip flow in test mode | HR/Admin |

Exact request/response fields: confirm on the **Transactions** and **Transfers** doc pages when building the tool.

## API reference sections (paystack.com/docs/api)

**Guides:** Introduction, Authentication, Rate Limits, Pagination, Errors.

**Endpoint groups (full list):** Transactions, Transaction Splits, Terminal, Virtual Terminal, Customers, Direct Debit, Dedicated Virtual Accounts, Preauthorization, Apple Pay, Capitec Pay.

Notable for us:
- **Transactions** — the core: initialize/verify charges (Ada's payment links).
- **Customers** — create/identify a customer record; used by the invoice sample flow.
- **Dedicated Virtual Accounts** — per-customer virtual account numbers for collection; a possible alternative recovery path (customer transfers directly).
- **Direct Debit / Preauthorization** — recurring/authorized charges; relevant only if we ever design subscriptions (out of scope for this exercise).
- **No Bills/Airtime/Electricity group** — confirms the limitation below.
- Also on this site: a **Postman Collection** link (bulk download of the whole API, same idea as Chord's `openapi.json`).

## Storefronts, Virtual Terminal, Subscriptions (from API reference screenshots)

**Storefronts — `POST/GET/PUT/DELETE /storefront`, `/storefront/{id}/order`, `/storefront/{id}/product`, `/storefront/{id}/publish`, `/storefront/verify/slug`, `/storefront/{id}/duplicate`**
Create and manage **digital shops to display and sell products** — name, slug (unique, verifiable), description, currency (NGN), status active/inactive, products with prices, orders with status (`success` etc.), publish to make publicly available. **This is Paystack hosting the shop page.**

**Virtual Terminal — `POST/GET/PUT /virtual_terminal`, `/deactivate`, `/destination/assign|unassign`, `/split_code`**
Accept **in-person payments without a POS device**. Key detail: `destinations` = notification recipients — each object has a `target` **(WhatsApp phone number)** and `name`, so **payment notifications can be pushed to a WhatsApp number**. Also supports split codes (payment splitting) and custom form fields.

**Subscriptions — `POST/GET /subscription`, `/enable`, `/disable`, `/manage/link`, `/manage/email`**
Recurring payments: customer + plan + start date; enable/disable with email token; generate/email a link for customers to update their card.

### Why this matters for the exercise

1. **Storefronts answers "should I create a mock e-commerce page?" — no, Paystack has one.** Blossom's domain is lapsed; a **Paystack Storefront in test mode** is a real external system that hosts products, prices, and orders. Ada's abandoned-cart flow can read **real orders** from `GET /storefront/{id}/order` instead of hand-typed seed data — the data-credibility problem solved by an outside system.
2. **Virtual Terminal destinations → WhatsApp payment notifications** — a payment event arriving on WhatsApp is a natural trigger for a teammate (event-driven, not typed).
3. **Subscriptions** — possible for a "dress of the month" club or layaway deposit plan; likely out of scope, note only.

## Core endpoints confirmed (from API reference screenshots)

### Transactions — Ada's core
| Endpoint | Purpose |
|---|---|
| `POST /transaction/initialize` | Create checkout: `amount` (subunit), `email`, optional `channels`, `currency`, `reference` (unique, only `-`, `_`, alnum), `callback_url`, `metadata`, `split_code`, `subaccount` → returns `authorization_url`, `access_code`, `reference` |
| `GET /transaction/verify/{reference}` | Confirm status — sample returns `status: "success"` |
| `GET /transaction` | **List with filters: `status` = `failed` \| `success` \| `abandoned`**, plus `customer`, `amount`, `from`/`to` dates, pagination |
| `GET /transaction/{id}` | Fetch one (id is signed 64-bit int — store carefully) |
| `GET /transaction/timeline/{id_or_reference}` | Attempt history: `attempts`, `errors`, `input` |
| `GET /transaction/totals` | Total received: `total_transactions`, `total_volume`, per-currency |
| `GET /transaction/export` | Export list (CSV etc.) with same filters incl. `abandoned` |
| `POST /transaction/charge_authorization` | Charge a reusable authorization (no checkout needed) |
| `POST /transaction/partial_debit` | Take part of a payment |

**KEY FINDING — `status=abandoned` is a real filter.** Option A for Ada is confirmed: `GET /transaction?status=abandoned` returns payments customers started and never finished — externally created, no typed data. Pair with `charge.success` webhook for the live trigger.

### Customers
`POST/GET/PUT /customer` (create/list/update; `email` required, `first/last/phone` optional, `metadata` for structured extras), `GET /customer/{email_or_code}`, `POST /customer/{code}/identification` (bank-account identity check), whitelist/blacklist (`risk_action: allow|deny`), authorization init/verify, direct-debit mandates. Customer object carries `transactions`, `subscriptions`, `authorizations` arrays.

### Transfers — Kemi's salary flow
| Endpoint | Purpose |
|---|---|
| `POST /transfer` | Send money: `source: balance`, `amount` (kobo), `recipient` (code from `/transferrecipient`), `reference` (16-50 chars, lowercase/digits/`-`/`_`), optional `reason` (shows in customer's credit notification) → `pending` if OTP disabled, `otp` if required |
| `POST /transfer/finalize_transfer` | Complete with `transfer_code` + `otp` (OTP sent to business phone) |
| `POST /transfer/bulk` | Batch transfers (requires OTP disabled) |
| `GET /transfer`, `GET /transfer/{id_or_code}`, `GET /transfer/verify/{reference}` | List/fetch/verify |

**Recipient dedupe — read from docs 2026-11-09:** *"A duplicate account number will lead to the retrieval of the existing record."* In test mode only Paystack's test account resolves (`0000000000` @ `057`; anything else → `Cannot resolve account`), so **per-staff recipients collapse into one record** — three POSTs with the test account all return the same `RCP_…`. Distinct destinations per teammate are impossible in test mode; at go-live, one `POST /transferrecipient` per real staff account.

**Subaccounts (`POST /subaccount`), read 2026-11-09:** splits *incoming* collections by percentage between main and sub account — wrong direction for payroll (which pays *out* from the main balance via transfers). Not needed.

**Test balance top-up, confirmed 2026-11-09:** dashboard-only (Balance → Topup, min NGN 100) — no top-up endpoint exists in the API reference (`GET /balance`, `GET /balance/ledger` are read-only); the balance is also credited by every completed test transaction.

### Transfers Control — balance
- `GET /balance` → `{ currency, balance }` in kobo — **Kemi's wallet check can be a real Paystack balance call**
- `GET /balance/ledger` — all pay-ins/pay-outs with `difference` and `reason`
- OTP management: `POST /transfer/resend_otp`, `/disable_otp` (+ finalize with OTP), `/enable_otp` — **disabling OTP is what allows programmatic transfers; that's a go-live risk to document** (who can disable it, what it means for autonomous spending)

### Webhook Events — inspection and replay
- `GET /integration/webhooks/events` — list/filter by `category` (e.g. `transactions`), `event_type` (e.g. `charge.success`), `status` (`Delivered`/`Pending`/`Failed`), `category_row_id`, dates
- `GET /integration/webhooks/events/lookup?reference=` — by transaction id or event id
- `GET /integration/webhooks/events/{id}` — full payload + **the response your endpoint returned** (debug delivery failures)
- `POST .../resend` (max 100 ids; **not idempotent — double-submit delivers twice**) and `.../resend-matching` with `preview=true` first to count matches
- **Field-note gold:** failed webhook deliveries are inspectable here — `status_detail`, `response_code` — exactly the "what happened / how I found the cause" material the brief wants.

## Useful extras from the docs home

- **Guides quick-start cards:** Accept Payments, Send Money (instant transfers to bank/mobile money), Identify your Customers (phone/bank/card verification — possible identity check for HR onboarding), Other ways to use Paystack (libraries, no-API options).
- **Sample demo repos** (PaystackOSS on GitHub): sample-gift-store (Accept + Verify Payments), sample-movie-ticket, sample-logistics (Create Customer + Payment Request — invoice-shaped), sample-restaurant (Payment Request + Terminal Event). The **logistics/invoice sample** is the closest model for an invoice-generation flow if we build one.
- **Paystack CLI** exists — useful for local webhook testing if we use webhooks.
- **Slack community + support page** — if we get stuck, asking is allowed and encouraged by the exercise brief.

## Confirmed limitation — no airtime / electricity

The API reference endpoint list is: Transactions, Transaction Splits, Terminal, Virtual Terminal, Customers, Direct Debit, Dedicated Virtual Accounts, Preauthorization, Apple Pay, Capitec Pay.

**There is no airtime or electricity/bills endpoint.** Paystack is a collection gateway (and transfers out); it does not vend utilities.

- Airtime/electricity for the HR/Admin teammate → **mock vending API** we build ourselves (explicitly allowed by the brief), designed with a production-shaped flow: validate meter/number → confirm with human → purchase → return token.
- Go-live note: to do this for real, register with a Nigerian biller aggregator (e.g. Baxi, Remita Vending, Clubkonnect) and fund a vending wallet — swap the mock endpoints.

## Gotchas

- Forgetting the ×100 kobo conversion (classic — log it in field notes if hit).
- Branch on `status`/`message`, not only HTTP code.
- Test-mode payment links only resolve while the Paystack account is active; note account state in the go-live note.