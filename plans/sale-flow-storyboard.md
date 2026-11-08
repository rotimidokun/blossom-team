# Sale flow — message-by-message storyboard (Ada)

Status: DRAFT for owner review — nothing built until approved.
Agreed design: **chat-first, no storefront build, Ada is the shop, one Paystack hop.**
Live test-mode foundation (already created, 2026-11-07):

- Hosted shop: `https://paystack.shop/blossom-by-tc-TnRoe` (Paystack-hosted, photos + prices live)
- Products: Sky Blue Dress `2880906` ₦12,500 · Mint Green Dress `2880907` ₦11,500 (stock 10 each, photos uploaded)
- Product buy links: `https://paystack.com/buy/sky-blue-dress-ffurut` (etc.)

## Windows on camera

1. **Chat link — Ada** (customer ↔ Ada, text only)
2. **Shop tab** — `paystack.shop/blossom-by-tc-TnRoe` (Paystack-hosted)
3. **Checkout tab** — Paystack payment window (test card)
4. Proof tabs: `GET /v1/orders` on our API · Paystack dashboard → Transactions

---

## Part 1 — Happy path (customer buys)

**Beat 1 — Customer arrives**
> **Customer:** "Hi, is the Sky Blue Dress available?"

*Ada tool: `GET product` (our API proxies Paystack `/product/:id`)*
> **Ada:** "Yes — Sky Blue Dress, ₦12,500, 10 in stock. Want to see it first? Our shop: https://paystack.shop/blossom-by-tc-TnRoe"

✅ *Customer opens the shop tab: real photo + price, hosted by Paystack.*

**Beat 2 — Order**
> **Customer:** "I'll take it."
> **Ada:** "Great — name and email for the order?"
> **Customer:** "Adaeze, adaeze@example.test"

*Ada tool: `POST /v1/orders` → order `OR_…` (pending)*
> **Ada:** "Order OR_8f31 created. Payment window: https://checkout.paystack.com/… — use adaeze@example.test there."

✅ *Order exists (pending) on our side; Paystack checkout opens with the right amount.*

**Beat 3 — Payment (the only off-chat moment)**
Customer pays with the **test card** → Paystack success page.

**Beat 4 — Verify + customer recorded**
> **Customer:** "Paid."
> **Ada:** "Checking with Paystack…"

*Ada tool: `POST /v1/orders/:id/verify` → Paystack `/transaction/verify` → `pending → paid`; customer row created*
> **Ada:** "Confirmed — payment received, order OR_8f31 is PAID. You're on our customers list now."

✅ *Two proofs: our API (`order.status=paid`, customers row) + Paystack dashboard → Transactions shows the test charge.*

**Beat 5 — (Optional chain) Mae thanks the customer**
Ada hands off to Mae → welcome graphic generated → link shared → you react ("love it" / "make it bigger"). No approval ceremony.

---

## Part 2 — Drop-off branch (lead + follow-up)

Customer never pays (closes before Beat 3):
- Order stays `pending` past the window → tagged **lead**
- Ada follows up later: *"Hi Adaeze — still holding the Sky Blue Dress. Here's 10% off if you finish today:"* → new payment window
- Pays → verify → `paid`. Never → stays a lead → optional campaign email (**recorded only**)
- Paystack **Discount Codes** tab can mint the real code (optional extra)

✅ *State visible via `GET /v1/orders` — pending → offer_sent → paid / lead.*

---

## Owner beats (same Ada line, owner speaking)

- *"What's selling?"* → `GET /v1/orders` + Paystack `quantity_sold` — honest numbers
- **Price update:** *"Drop the Sky Blue Dress to ₦10,000"* → `PUT /product/:id` → **Paystack catalog changes** → shop tab now shows ₦10,000 (refresh) — chat instruction, outside-system result
- *"Any drop-offs?"* → orders list → leads

---

## Build list (the whole thing)

1. **Product proxy tools** — read/update Paystack products through our API (`GET/PUT /product/:id` wrapped with our envelope)
2. **Orders + customers endpoints** (create, get, verify flow, lead tagging) — our standard conventions
3. **Paystack client**: `/transaction/initialize` + `/transaction/verify` (test key live)
4. **Ada skill** (`skills/ada/sales.md`) + **MCP bucket** `/mcp/sales` (same pattern as `/mcp/design`), third Chord server entry
5. Seed: start empty — the demo creates every record

**Not built:** storefront page, Google Sheet, email sending, approval button (killed).

## Camera / honesty notes

- Chat is text-only → shop link, photo, payment link are links (open on camera)
- Test card from Paystack's test-payments docs
- Every claim matches a record: "paid" ⇒ `order.status=paid`; "₦10,000 now" ⇒ `GET /product/:id` shows it
- Credits: each chat turn ≈ 3; full run ≈ 6–9 (check counter first)
- Feedback note for the exercise: Products API has **no image upload field** (photos are dashboard-only, readable in `files[]`); storefront create requires `currency` (undocumented in sample); slug gets a random suffix — `verify/slug` is not an availability check

---

## Not yet storyboarded

- Onboarding flow (Kemi) — same format, after this one is approved
