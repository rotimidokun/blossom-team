# Blossom Vending API

The tool layer for **Blossom by TC** (girls' fashion, 3 months–18 years) — one server, three Chord teammates:

```
Kemi: fund the wallet (starts at ₦0) → validate meter/line → show the owner → explicit confirmation → purchase → receipt/token
      monthly payday: summary → owner code → paid (wallet or Paystack), every attempt recorded
Ada:  quote the real Paystack catalogue → open a payment window → verify the payment → customer recorded
      (drop-offs become leads with a recovery offer; catalogue edits need the owner code)
Mae:  brief → generate image → owner approves/rejectS.
```

Built for the **TSG Labs build exercise**. All data is made up and no real money moves (ground rules: test keys and made-up data only).

## Run it

Requires **Node.js 18+**. Written in **TypeScript** (strict mode) but runs directly — no build step:

```bash
npm install        # express + dev tooling (typescript, tsx, @types)
npm start          # http://localhost:3000  (tsx runs the TS sources)
npm test           # 54 tests: happy paths + every error path
npm run typecheck  # tsc --noEmit — strict-mode type check
```

Environment variables and test defaults:

| Variable | Default / Example | Purpose |
|---|---|---|
| `PORT` | `3000` | Server port |
| `VENDING_API_KEY` | `test_vending_key` | Bearer token for `/v1` routes |
| `DB_PATH` | `data/db.json` | Where purchases persist |
| `NODE_ENV` | — | `production` disables `POST /v1/reset` |
| `PAYSTACK_SECRET_KEY` | — | Optional `sk_test_...` — enables the real Paystack pull top-up |
| `PAYSTACK_RECIPIENT` | — | Optional `RC_...` transfer-recipient code for the pull top-up |
| `OPENROUTER_API_KEY` | (Provided in submission note) | Primary image provider via dedicated endpoint (pre-funded with $5 for evaluation) |
| `OPENROUTER_MODEL` | `openai/gpt-image-2.5-flare` | Override the OpenRouter image model |
| `MAE_MOCK` | 0 (or 1) | `1` forces mock images (free — tests set this) |
| `MAE_MAX_GENERATIONS` | `10` | Cost cap: max images per session |
| `OWNER_CODE` | `flowerpower` | Owner's secret phrase (test default) — server-verified before payroll or catalogue edits |
| `SALARY_SOURCE` | `wallet` | `wallet` = payday debits the vending wallet; `paystack` = real `POST /transfer` |
| `PUBLIC_BASE_URL` | — | Base for image links shared in chat (absolute URLs), e.g. the Render URL |

**Note to Evaluator on Live Image Generation:** To test live image generation, add the pre-funded $5 OpenRouter key provided in the submission notes to your `.env` file under `OPENROUTER_API_KEY`. If left unset, the system safely falls back to `MAE_MOCK=1` for free mock images.

## Try it

```bash
# Health (no auth)
curl http://localhost:3000/health

# Wallet balance (kobo) — starts at 0; funding is the first act
curl http://localhost:3000/v1/wallet \
  -H "Authorization: Bearer test_vending_key"

# 0a. Fund by bank transfer (owner sends to the biller account, you record the reference)
curl http://localhost:3000/v1/wallet/incoming \
  -H "Authorization: Bearer test_vending_key" \
  -H "Content-Type: application/json" \
  -d '{"amount":5000000,"reference":"TRF-bank-001"}'

# 0b. Fund by Paystack pull (after src/paystack.ts transfer() succeeded in test mode)
curl http://localhost:3000/v1/wallet/paystack-funded \
  -H "Authorization: Bearer test_vending_key" \
  -H "Content-Type: application/json" \
  -d '{"amount":2000000,"paystack_reference":"PSK-test-777"}'

# 1. Validate first — returns the registered owner name
curl http://localhost:3000/v1/validate/meter \
  -H "Authorization: Bearer test_vending_key" \
  -H "Content-Type: application/json" \
  -d '{"meter_number":"45123456789","disco":"IKEDC"}'

# 2. Purchase (Idempotency-Key makes retries safe)
curl http://localhost:3000/v1/purchases/electricity \
  -H "Authorization: Bearer test_vending_key" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-1" \
  -d '{"meter_number":"45123456789","disco":"IKEDC","amount":1000000}'
```

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Liveness (no auth) |
| GET | `/v1/wallet` | Balance + low-balance threshold + funding account (kobo) |
| POST | `/v1/wallet/incoming` | Record a bank-transfer top-up (traced by reference) |
| POST | `/v1/wallet/paystack-funded` | Record a Paystack-funded top-up (traced by reference) |
| POST | `/v1/validate/meter` | Validate meter → registered owner name |
| POST | `/v1/validate/phone` | Validate line → network |
| POST | `/v1/purchases/electricity` | Buy token (debits wallet) |
| POST | `/v1/purchases/airtime` | Buy airtime (debits wallet) |
| GET | `/v1/purchases` | List purchases |
| GET | `/v1/purchases/:id` | Receipt by id or reference |
| POST | `/v1/reset` | Reset to seed state (test only) |
| POST | `/v1/designs/generate` | Generate an image (mock/Gemini/OpenRouter) → queued pending |
| GET | `/v1/designs` | Approval queue (filter `?status=pending`) |
| GET | `/v1/designs/:id` | One design |
| POST | `/v1/designs/:id/approve` | Owner approves (pending → approved) |
| POST | `/v1/designs/:id/reject` | Owner rejects with a reason |
| GET | `/images/:file` | Serve a generated image (no auth — shareable link) |

Full contract: `openapi.json`.

## Design choices

- **TypeScript, strict mode** — domain types live in `src/types.ts` (Db, Purchase, Design, the response envelope); the compiler catches shape drift between routes, seed and tests.
- **MCP-native tool surface** — Chord connects through three stateless MCP endpoints (`/mcp` ops, `/mcp/design`, `/mcp/sales`) instead of one shared API, so each teammate is granted only their own bucket: Kemi can't generate designs, Mae can't move money, Ada can't touch the wallet. The tools self-call the REST API over loopback, so validation, idempotency and error shapes have exactly one source of truth.
- **No build step** — tsx runs the TS directly so the README's `npm start` is the same command in dev and demo; `npm run typecheck` gates the types separately.

## Conventions (deliberate, not accidental)

Studied from the real APIs before building:

- `{ status, message, data }` envelope — Paystack's response shape; errors add `data.error.code`
- Bearer auth on every `/v1` route — same as Chord and Paystack
- Amounts in kobo (NGN ×100) — Paystack's unit convention; ₦10,000 = 1000000
- `Idempotency-Key` header — a retried purchase returns the original result, never a second buy
- Machine-readable error codes — what the skill branches on:

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing/wrong key |
| `INVALID_METER` | 400 | Meter not valid for that disco |
| `INVALID_PHONE` | 400 | Not a valid line |
| `VALIDATION_FAILED` | 400/422 | Missing/mismatched fields |
| `INSUFFICIENT_WALLET` | 402 | Balance below amount |
| `DISCO_UNAVAILABLE` | 503 | Upstream outage (simulated — failure-path demo) |
| `NOT_FOUND` | 404 | Unknown route/purchase |
| `IDEMPOTENT_REPLAY` | 409 | Funding reference already applied / purchase replayed |
| `INVALID_STATE` | 409 | Design is not pending (already approved/rejected) |
| `GENERATION_LIMIT` | 429 | Image cost cap reached this session |
| `IMAGE_API_UNAVAILABLE` | 503 | Image provider failed/unreachable (skill falls back or reports) |

## Seed data (all made up)

- **Wallet:** starts at NGN 0 (funding is the first act of the demo), low-balance threshold NGN 5,000, funding account `0000000000` (Zenith Bank, test — Paystack's documented test coordinates)
- **Meters:** `45123456789` (IKEDC prepaid, BLOSSOM BY TC LIMITED), `87654321098` (IKEDC postpaid), `11223344556` (EKEDC — deliberately unavailable for the failure demo)
- **Phones:** `0803…` MTN, `0805…` GLO, `0809…` AIRTEL, `07000000000` (invalid, for the error demo)

## Project layout

```
src/
  app.ts       # routes + business logic (Express)
  server.ts    # starts the app
  mcp.ts       # three MCP endpoints (ops / design / sales buckets) for Chord
  store.ts     # JSON-file persistence (state outlives a conversation)
  seed.ts      # made-up seed data
  types.ts     # shared domain types (Db, Purchase, Design, envelope)
  paystack.ts  # real Paystack test-mode client (balance, transfers, catalogue, checkout)
  imagegen.ts  # image generation: mock → OpenRouter → Gemini fallback chain
  garments.ts  # the brand's real dresses as design references
  logo.ts      # stamps the real logo onto generated images
test/
  api.test.ts  # node:test — 54 tests, no test framework dependency
openapi.json   # machine-readable contract
tsconfig.json  # strict type checking (npm run typecheck)
```

## The two money pots (funding flow)

The wallet is petty cash; Paystack is the bank. Money moves in two directions:



- **Push path:** owner transfers to the biller account (`0000000000`, Zenith Bank test) → Kemi records it with a reference.
- **Pull path:** `src/paystack.ts` calls the real Paystack test `POST /transfer` → the credit is recorded with the Paystack reference. Currently blocked because of pending KYC.

Purchases always debit the wallet, so the balance goes down after every buy — exactly like a real biller wallet.
