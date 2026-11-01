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
**Status:** resolved (workaround in place; pull path deferred to go-live)

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
