# Wrap-up improvements — decided 2026-11-08

From reviewing the Ada (Tolu) and Kemi dress chats. Decisions confirmed with Tosin.

## Decided

1. **Fix the phantom order (credibility hole)** — DONE in code (stale-DB crash fixed);
   remaining: audit `data/db.json` for any other half-created orders from the crash
   window, and confirm Ada only ever quotes IDs returned by `create_order`
   (replay-safe duplicate now guarantees this).
6. **Payroll pivot (2026-11-09)** — payroll = **the founder's draw only** (₦100,000,
   owner-code gated). The AI agents are NOT on payroll: a friend's challenge exposed
   the weak spot ("what will they use the money for?" — nothing; agents can't spend).
   The fun "salary for the agents" idea is **recorded here and in the skill** as a
   deliberate scoping decision, not an oversight. Bonus: one destination fits the
   test-mode recipient dedupe limit, and ₦100,000 fits today's ₦116,000 test balance —
   green payday with a real Paystack transfer, no top-up needed.
2. **Owner vs customer separation** — owner-only actions (price changes) happen in
   Kemi's direct line; Ada's chat link is customers only. Zero code; note in the
   go-live note. Passphrase option noted as the go-live answer.
3. **Kemi → Ada handoff line** — one line in `skills/kemi/utility-bills.md`:
   sales/orders/customers questions → hand to Ada. (Routing preference, not a lock —
   Kemi keeps read access.)
4. **Ada: one photo / one question at a time** — tighten `skills/ada/sales.md`
   catalogue step: list names+prices in one short line, share ONE photo per message,
   ask the size question alone. Example in chat review below.
5. **Two-payment-links friction** — no build now. Storefront cart
   (`paystack.shop/blossom-by-tc-TnRoe`) is the real one-payment path; note as v2 in
   the go-live note.

## From the chat review (still open)

- Republish `skills/kemi/utility-bills.md` (the "your yes came before the check"
  line still appeared twice in chat — published version may predate the fix) +
  2-message retest.
- Ada's catalogue reply is a wall of text — fixed by #4 above.
- Test order `OR_ea6c4dca` (Probe) pollutes summaries — dies with the pre-recording
  `POST /v1/reset`.
- Paystack prices were changed during testing (₦40,000) — intentional per Tosin;
  no reset needed.

## Not doing

- Cart/one-transaction order type (build) — storefront cart covers it, noted as v2.
- Owner passphrase — noted for go-live, direct-line separation is enough for demo.