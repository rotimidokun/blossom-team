# Deployment Field Notes

Running log of problems hit while building the TSG Labs / Chord exercise.
Append entries as they happen — do not wait until the end.

**Submission rule (from the brief):** for each problem, capture four things:

1. **What happened** — including any error messages
2. **How I worked out the cause**
3. **How I fixed it or worked around it**
4. **What I'd change in Chord, its docs or its API** so the next builder doesn't hit it

Short, specific notes about two or three real problems beat a long list.
The strongest notes are the ones with real error text and a real diagnosis.

---

## Entry template

```
### [date] — Short title
**What happened:**
**Cause (how I worked it out):**
**Fix / workaround:**
**Chord improvement suggestion:**
**Severity:** blocker / major / minor
**Status:** open / resolved
```

---

## Entries

### 2026-10-31 — Minified openapi.json is unreadable by line-based tools
**What happened:** Downloaded the Chord API contract from `GET /api-docs/public` (also served at `/docs/api-reference/openapi.json`). The file `docs/openapi.json` is saved as a single minified line, so tools that read line-by-line truncate it after ~2,000 characters and the 101 endpoint paths are not visible.
**Cause (how I worked it out):** Read the first line of the file and saw the entire document on line 1; searches for endpoint paths returned the whole line truncated.
**Fix / workaround:** Pretty-print the JSON into a multi-line copy: `python -m json.tool docs/openapi.json > docs/openapi-pretty.json` (original kept intact).
**Chord improvement suggestion:** Publish a pretty-printed (or line-broken) copy of `openapi.json` alongside the minified one, or note in the docs that the contract is minified and how to format it — the docs market the file for reading and diffing, but minified JSON is neither readable nor diff-friendly.
**Severity:** minor
**Status:** open

### 2026-10-31 — One machine-readable file beat reading docs page by page
**What happened:** Faced with a docs site of many pages and subpages, copying them one by one (or screenshotting them) would have been slow and lossy. Instead I grabbed the single `openapi.json` contract Chord publishes and gave the whole API to my coding agent in one file.
**Cause (how I worked it out):** The docs overview page itself advertises `openapi.json` as "the machine-readable contract: 101 paths, 146 operations", served anonymously at `GET /api-docs/public`. Docs sites that publish a contract are effectively offering the entire API as one download.
**Fix / workaround:** Download the contract once, pretty-print it so line-based tools can read it, and work from that. The agent went from "describe the API to me" to "read the API yourself" — much faster and no missed endpoints.
**Chord improvement suggestion:** None needed here — Chord already does this well. General lesson for other docs sites: look for `openapi.json`, `llms.txt`, or a "Download PDF" before defaulting to page-by-page copying.
**Severity:** minor (positive learning, not a blocker)
**Status:** resolved

### 2026-11-01 — Paystack test transfer recipient: error hint was wrong, fix was in a different docs section
**What happened:** Creating a transfer recipient in test mode (`POST /transferrecipient`) failed repeatedly with:
```json
{
  "status": false,
  "message": "Cannot resolve account",
  "meta": {
    "nextStep": "Ensure that you're passing the correct bank code. Use the List Banks Endpoint to get the list of all available banks and their corresponding bank codes"
  },
  "code": "invalid_bank_code"
}
```
I tried three account/bank pairs: made-up `1234567890` @ Sterling (`232`), `0000000000` @ Sterling (`232`), and `0123456789` @ GTBank (`058`) — all returned the same error.
**Cause (how I worked it out):** The `nextStep` told me to check the **bank code**, but the bank code was correct every time (I'd pulled Sterling `232` and GTBank `058` straight from Paystack's own `GET /bank` list). The real problem was the **account number** — Paystack validates that the account actually exists, and none of the guessed/commonly-cited test numbers resolved. The hint sent me down the wrong path (I was about to re-check bank codes) before I realized the account itself was the issue.
**Fix / workaround:** Found the actual test credentials in a *different* docs section — **Payments → Test Payments → Bank accounts**: Zenith Bank (transfer), account `0000000000`, bank code `057`. That pair resolved on the first try and returned `recipient_code: RCP_81czh6hw8r1ikrr`.
**Chord improvement suggestion:** (Paystack feedback, not Chord — bonus example.) When the account number is the problem (not the bank code), the `nextStep` should say so directly — e.g. *"The account number could not be resolved at this bank. In test mode, use the test credentials from Payments → Test Payments → Bank accounts: [link]"* — instead of pointing at the List Banks endpoint, which confirms the code I already had. The test-credentials page and the transfers docs are in different sections; the error should bridge them. Reserve the main field-note slots for Chord-specific snags.
**Severity:** minor
**Status:** resolved

### 2026-11-01 — Paystack blocks transfers on a "starter" business, even in test mode
**What happened:** The pull top-up (`POST /transfer`, source `balance`, ₦50,000 to the recipient we just created) was rejected:
```json
{
  "status": false,
  "message": "You cannot initiate third party payouts as a starter business",
  "meta": { "nextStep": "You'll need to upgrade your business to a Registered Business." },
  "type": "api_error",
  "code": "transfer_unavailable"
}
```
**Cause (how I worked it out):** The recipient creation succeeded (so the key, bank code and account were all fine) — the failure was account-level, not request-level. Paystack gates **outbound transfers** (payouts to a third-party bank account) behind business verification: a "starter" (unverified) account can collect payments but cannot send money out. This applies in **test mode too**, not just live.
**Fix / workaround:** Fell back to the **push path** — the owner "sends" the top-up to the biller account and we record it via `POST /v1/wallet/incoming` with a reference. The pull path (`src/paystack.js` → `POST /transfer`) stays in the codebase and is documented as requiring a verified business; it's a go-live prerequisite, not a demo blocker.
**Chord improvement suggestion:** (Paystack feedback, not Chord — bonus example.) The error is clear about *what* is wrong but not about *test mode*: a builder testing transfers on an unverified account has no way to know from the docs that payouts are gated until they hit the error. The Transfers docs should state up front: *"Transfers require a verified (Registered) business — starter accounts cannot send payouts, including in test mode."* That one line would have saved the attempt.
**Severity:** major (blocked the pull path entirely; worked around via push)
**Status:** resolved (workaround in place; pull path deferred to go-live) — superseded by the 2026-11-05 entry below

### 2026-11-05 — Registered Business re-onboarding lifts the payouts gate
**What happened:** Following Paystack's own advice (the "Paystack Index" suggestion didn't make sense — it's their platform for connecting an app to an AI agent, not an account fix), I created a fresh account, chose **Registered Business**, and submitted KYC. The new test key was already active, so I re-ran the exact probe that failed on 2026-11-01:
1. `GET /balance` → `200`, NGN balance `0` — key valid.
2. `POST /transferrecipient` (Zenith `0000000000` @ `057`) → `201`, new `RCP_yab85z5ct7r24wg` (the old account's `RCP_81czh...` doesn't exist on this key — recipient codes are per-integration).
3. `POST /transfer` (source `balance`, ₦100) → **no longer `transfer_unavailable`**. Now: `{"code":"insufficient_balance","message":"Your balance is not enough to fulfil this request","meta":{"nextStep":"Topup your Paystack Balance and try again."}}`.
**Cause (how I worked it out):** The error *changed*. The business-verification gate fires before the balance check (that's why the old attempt with a ₦0 balance got `transfer_unavailable`, not `insufficient_balance`). Getting the balance error means the request passed verification — the Registered Business status is live on the new key even though KYC was only just submitted.
**Fix / workaround:** Payouts are now API-available; only test funds are missing. Updated `.env` (new recipient), `src/paystack.ts` + `src/app.ts` status comments, `skills/kemi/utility-bills.md` (caveat now says `insufficient_balance`, not "starter business"), and `TESTING-FLOW.md`. Push path stays the demo path until the test balance is funded (a successful test transaction credits it).
**Chord improvement suggestion:** (Paystack feedback, bonus example.) Paystack's docs could state that the verification gate is checked *before* balance — knowing the error order would have let me predict this probe's outcome from the docs alone.
**Severity:** major → resolved
**Status:** resolved (payouts unblocked; awaiting test balance to exercise the pull path live)

### 2026-11-05 — Billing settlement fails after replies that touch our MCP tools
**What happened:** After registering our custom MCP server (Blossom Operations API, Health `ok · 412 ms`, all 10 tools listed), every chat turn where Kemi attempts a tool call ends with a red popup: `Billing settlement failed after the model completed; do not retry automatically`. Her text progress went from *"I can't run the wallet check…"* (before registration) to *"Checking the wallet now."* (after) — but the turn still dies at settlement. Credits burned anyway: 50 → 47 → 44 → 41 across the failed attempts.
**Cause (how I worked it out):** Ruled out our server first: the ngrok inspector (`127.0.0.1:4040`) shows Chord's own `POST /mcp` (`tools/list`, id 436) arriving from IP `3.218.198.98` and getting **200 OK in 296 ms** — Chord → tunnel → our API is healthy, and Chord's in-UI Health check agrees (`ok · 412 ms`). Then DevTools pinned the actual failure: `GET /api/proxy/v1/conversations/stream` → **500** (`Content-Length: 0`, `X-Cache: Error from cloudfront`) while every other endpoint on the same page returns 200. Decisive test: a **fresh incognito session reproduced the 500 on plain page load — no message sent, no tool involved** — so the outage is the conversation-stream endpoint itself, not tool-specific and not caused by our MCP server. The toast's "after the model completed" is just where their pipeline notices the dead stream.
**Fix / workaround:** Stopped retrying (the popup says not to, and each attempt costs ~3 credits: 50 → 38). Skipped the planned tool-vs-plain A/B messages — the load-time 500 already answered it, saving credits. Evidence gathered free: DevTools 500 (two sessions), ngrok inspector 200s, Health check. Report drafted in `plans/chord-stream-bug.md`.
**Chord improvement suggestion:** (1) Don't debit credits when settlement fails — a failed settlement currently still decrements the counter, so a platform bug eats the builder's limited test budget. (2) Surface the error *where it happens* (on the message, with a request id) rather than a transient toast, so it can be reported with correlation. (3) Give builders a settlement/system log per conversation so "model completed but billing failed" is diagnosable without an external tunnel inspector.
**Severity:** major (blocks the core live-loop test and burns credits)
**Status:** open (reported to TSG) — scope narrowed by the chat-link test below

### 2026-11-05 — Chat-link path works: live MCP loop proven while the app's direct line stays broken
**What happened:** After the direct-line (`chordhq.xyz` teammate view) turns kept dying, we created a customer **chat link** on `chat.tsglabs.dev` (`https://chat.tsglabs.dev/c/Zd8xnlhyymU6st-xhwtOUp1`, business "Blossom by TC") and ran the same flow there. Result — full tool loop, zero stream errors: Kemi asked for the number, called `validate_phone` ("08031234567 is an MTN line"), called `check_wallet` ("Wallet balance: ₦0"), and asked for a ₦1,000 top-up to the biller account **1234567890 (Sterling Bank, test)** with a transfer reference before any spending.
**Cause (how I worked it out):** The biller account and ₦0 balance exist only in our API's `GET /v1/wallet` response, and MTN network detection exists only in our `/v1/validate/phone` handler — Kemi quotes both, so the tools genuinely executed (Chord → ngrok → our MCP → our REST API). Since the identical conversation works on `chat.tsglabs.dev` while the `chordhq.xyz` operator/direct-line view 500s on `GET /api/proxy/v1/conversations/stream`, the outage is scoped to **that app route**, not the platform's chat pipeline — which also explains why the `Billing settlement failed` toast only ever appeared on the direct line.
**Fix / workaround:** Test and demo through the chat link (it's also the graded WhatsApp shape); treat the direct-line stream 500 as a separate app bug for TSG.
**Chord improvement suggestion:** Scope the error to the failing surface — the toast blamed "billing settlement" when the actual failure was the operator console's SSE proxy. A route-level message ("conversation stream unavailable") would have saved an hour of diagnosis.
**Severity:** major → workaround found
**Status:** resolved (chat-link path); direct-line stream 500 still open with TSG

### 2026-11-05 — No per-teammate picker for custom MCP tools; Add tool just redirects to Admin
**What happened:** In Kemi's detail page → Settings → Tools, the list shows only first-party connectors (Bookings, Checklist, GitHub, Paystack, Linear, Notion, all "Needs connecting"). Our connected MCP server never appears, and clicking **Add tool** navigates away to `admin/channels?tab=tools` — the same page the `··· → Add tool` flow sent me to before the server existed. There is no visible way to grant a custom MCP server to a specific teammate.
**Cause (how I worked it out):** Tried the flow twice (before and after the server was registered and Enabled) — same redirect both times. The workspace-level server shows Enabled with a healthy handshake, so the missing piece is the per-teammate grant, and its only apparent entry point loops back to workspace settings.
**Fix / workaround:** Proceeded on the assumption that the workspace-level **Enabled** flag grants access to all teammates, and used Kemi's behaviour as the test — her post-registration reply (`Checking the wallet now`) suggests the tools did reach her, independent of the settings list.
**Chord improvement suggestion:** Either show custom MCP servers in the teammate's Tools list with a toggle (matching the first-party ones), or make **Add tool** open an in-place picker listing available workspace tools instead of navigating to Admin. Right now the per-teammate governance model documented in the UI ("Choose which connected tools Kemi can use") isn't reachable for custom tools.
**Severity:** minor if Enabled-by-default is intended behaviour (then the UI is just misleading); major if a per-teammate grant is actually required and unfindable
**Status:** open

### 2026-11-05 — Office network filters DNS records cloudflared needs; ngrok was the workaround
**What happened:** `cloudflared tunnel --url http://localhost:3000` failed repeatedly: DNS **SERVFAIL** on the SRV records `_v2-origintunneld._tcp.argotunnel.com`, and a direct query to `1.1.1.1` timed out too. The standalone exe (winget needed an admin password that doesn't exist on this machine) failed the same way.
**Cause (how I worked it out):** The failure was consistent across retries and name servers, and specifically on **SRV** records — a plain-HTTPS site on the same network works fine, so it's record-type filtering on the office/home-office network, not general DNS breakage. (Independent confirmation: OpenRouter's own `413 Downloaded image content cannot exceed 30MB` on an unrelated design call shows the network path also mangles/fails large fetches.)
**Fix / workaround:** Switched to **ngrok** (`bin/ngrok.exe http 3000`, authtoken configured) — same quick-tunnel shape, no SRV lookup, worked first try. Its free-plan browser interstitial (`ERR_NGROK_6024`) only affects browser requests; server-to-server POSTs (Chord → our `/mcp`) pass straight through. Restarting ngrok while the old tunnel is alive gives `ERR_NGROK_334 endpoint already online` — not an error, just proof the original tunnel never dropped.
**Chord improvement suggestion:** None — this is my network, not Chord. Kept for the brief's "problems hit while building" log and the deployment decision (tunnel now, Render/Railway later).
**Severity:** minor (blocked 10 minutes, workaround solid)
**Status:** resolved

### 2026-11-08 — A stale DB file crashed an async route; a 300s timeout disguised it as "server unreachable"
**What happened:** A live chat test failed at `create_order`: the MCP tool returned `{"ok": false, "http_status": 0, "message": "Local vending API unreachable: fetch failed"}` after **304 seconds**, and the teammate then went silent ("The agent didn't answer"). Two such calls took 304.6s and 305.0s (ngrok inspector); three other tools on the same endpoint answered in ~0.7s.
**Cause (how I worked it out):** The message looked like a dead server, but the server was serving the other tools. I added elapsed-time logging to all three hops (Paystack client, MCP→REST loopback, order route) and re-ran the call. The log showed the truth immediately: `[fatal] unhandledRejection: TypeError: Cannot read properties of undefined (reading 'find') at app.ts:809` — `db.orders.find(...)`. The live `data/db.json` predated the sales feature (no `orders`/`customers` keys) and `loadDb()` returned old files verbatim. The async Express handler threw, Express 4 doesn't catch async throws, so **no response was ever written**, and the loopback fetch died on undici's default **300-second headers timeout** — which surfaces only as `fetch failed`. The 304s duration *was* the diagnosis; my first hypothesis (a Paystack network hang) was disproven by the same logs.
**Fix / workaround:** (1) `loadDb()` now normalizes any loaded file over a fresh seed — missing collections are merged in (and backfilled on disk), so an old file can never crash a new route. (2) Every hop logs elapsed ms and error `cause`, so the next hang is attributable in one read. (3) The skill now forbids quoting an order id the tool didn't return — the crash had produced a "phantom order" the agent quoted to a customer. Gate: `tsc` clean, 44/44 tests, probe ALL GREEN through the tunnel.
**Chord improvement suggestion:** (1) Surface the tool call's **elapsed time and underlying error** in the turn log — "304s, fetch failed" would have pointed at a hang in seconds instead of an error that reads like a dead server. (2) A **configurable MCP tool timeout** (30–60s default) with a clear `tool timeout` error would stop a 5-minute call from killing the whole reply. (3) When a turn produces no reply, show *why* (tool error / model error / gate) instead of the generic "The agent didn't answer".
**Severity:** major (blocked the core purchase demo; root cause read from logs, not guesswork)
**Status:** resolved (fix shipped in `2cf5932`; Chord-side asks folded into the TSG report)

---

## Ideas / decisions log

Capture choices and trade-offs here (useful for the problem statement and interview):

- **Wallet starts at ₦0, funding is the first act** — seeded empty so the demo shows the natural insufficient-balance path and the top-up flow (bank transfer or Paystack pull) instead of contriving a pre-funded balance.
- **Two funding paths, both reference-traced** — push (owner's bank transfer recorded via `/v1/wallet/incoming`) and pull (real Paystack test `POST /transfer` recorded via `/v1/wallet/paystack-funded`); a repeated reference returns 409 `IDEMPOTENT_REPLAY` so money is never counted twice.
- **Paystack's role is the "bank", not the biller** — Paystack has no airtime/electricity endpoints (verified), so it funds the wallet we built; the vending API does the actual vending. Three-tier shape: owner/Paystack → wallet → purchase.
- **Express over raw `node:http`** — readability for a frontend engineer reviewing the submission; one dependency, tests unchanged (21/21).

## Questions for TSG Labs contact

The brief encourages asking questions early — good for Communication score:

- 0 credits remaining on the account — can you top up so test conversations can run?
- Requested scopes for testing via the API: `teammate:read`, `orchestrator:chat`, `thread:read`, and `mcp:create/read/manage` for registering our custom tool.
- Is the WhatsApp simulator access provisioned on our side, or does it need an action from you?
- For the custom tool: is registering an MCP server ("Add server") the expected path, or is Custom tools (API) → "Import OpenAPI" equally supported? (We built an OpenAPI-described REST API.)
