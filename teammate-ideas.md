# Teammate Ideas — Blossom by TC × TSG Labs exercise

Working dump of every teammate idea we're considering, so nothing is lost in context.
Update this file as decisions are made. Status legend: ✅ decided · 🟡 candidate · ❌ cut (with reason)

## Business

**Blossom by TC** — female children's fashion company. Dresses for girls aged 3 months–18 years.
Sales via online channels and word of mouth. Storefront currently **down** (domain/hosting not renewed) — a real constraint worth using in the problem statement and go-live note.

Organogram (from owner's sketch):
- **CEO**
  - **HR** — salaries, onboarding, onboarding kit, Paystack salary account, employee handbook, email creation, ID card, business card, monthly salary approval
  - **Business Dev / Sales** — create leads, convert leads, calls, emails, drop-offs at checkout, campaign launch
  - **Brands / Media** — graphics, outfit pictures, social media postings, content writing, campaign launch, presentation slides
  - **Customer Service** — customers can call in or text in

## Constraints shaping every idea

- Brief: ONE useful job per agent, end-to-end, on WhatsApp; ≥1 self-written skill; ≥1 custom tool calling an external system; conversation where the tool takes a REAL action
- ~6 hours focused work, 50 Chord credits, 5 days, no sandbox (every Chord call bills)
- Test keys and made-up data only
- Role = **Technical Product Management** → rubric weights **payment/merchant integration + go-live note**
- Chord tools arrive via **MCP servers** (register own server, discover tools, assign to teammate)
- Verified: Paystack = collection + transfers only (no airtime/electricity) → see `docs/paystack-api.md`
- Unverified: can the agent SEND an image in the WhatsApp simulator? (gates Mae's load-bearing status)
- Data credibility rule we set: state must change through external events/calls, not numbers typed into a sheet

## The lineup (current front-runners)

### 🟡 Ada — BD/Sales rep (abandoned-cart recovery)
- **Job:** chases drop-offs at checkout with recovery offers
- **Tool:** mock Blossom API (seeded carts, state changes) + **Paystack test mode** (`/transaction/initialize` → payment link, `/transaction/verify`)
- **Why:** Integration with payment systems = TPM's #1 weight; state change = real action; creativity (WhatsApp recovery for a fashion brand)
- **Flow:** customer abandons → Ada offers discount → generates test payment link → cart flips `abandoned → recovery-offered → recovered`
- **Open:** should the simulator customer trigger the drop-off live (strongest credibility)? Optional static page for the recording (prop only, build last)

### 🟡 Mae — Brands/Media officer
- **Job:** graphics, key-date flyers, AI model shots from the collection, presentation slides — all queued for **owner approval; human posts** (owner's own workaround for no social auth)
- **Tool:** image-generation API (GPT image model, user-funded) + approval queue in mock API (`pending → approved/rejected`)
- **Skills planned (4 files, drafted but NOT yet written to disk):**
  1. `graphics-and-flyers` — key dates, outfit posts, campaign visuals + captions
  2. `ai-model-shots` — AI fashion models wearing real collection pieces (replaces expensive shoots); rules: no real children, match real garment, label as illustrative
  3. `presentation-slides` — CEO/BD decks per slide guidelines, placeholders not fabricated numbers
  4. `design-requests` — cross-teammate briefs (sales campaign banner, HR onboarding kit), routes to her other skills
- **Shared context:** brand guidelines go in a **knowledge bundle**, not duplicated in skills
- **Gates:** image-sending verification; credit cost of generations (cap per request in skill rules)

### 🟡 Zainab — Customer service rep
- **Job:** FAQs when the shop is closed, order/delivery status lookups, escalate the rest to a human
- **Tool:** mock Blossom API order lookup (empty/not-found handling) + Chord escalation rules
- **Why:** go-live note (TPM's #2 weight) writes itself — hours, escalation, who gets alerted; skill template's "name what to hand off instead" maps directly
- **Note:** RAG/knowledge bundle for FAQ answers (brief allows; "leverage rag" was in raw ideas)

### 🟡 Kemi — HR/Admin/Operations
- **Job candidates:** onboarding (welcome email, ID card, business card, tracker update), monthly salary approval, payslips
- **Tool:** **Paystack test Transfers** (`/transferrecipient` + `/transfer`) for salary flow — matches organogram's "Paystack salary account" and TPM weighting
- **Airtime/electricity idea:** Paystack CAN'T do it (verified) → only viable as **mock vending API** with production-shaped flow (validate meter → confirm human → purchase → token). Go-live note: swap for a real biller aggregator (Baxi/Remita/Clubkonnect)
- **Weakness:** episodic jobs (onboarding happens monthly) demo less lively than sales/service; overlaps Tolu on the tracker sheet
- **Status:** depends on lineup size — see "open questions"

## Bench / not in current lineup

- 🟡 **Tolu — Weekly brief analyst** — owner's Sunday brief from tracker (dresses vs target, leads, sales, deliveries, abandoned carts, complaints). Lowest risk, but Google-sheet-only data credibility is weak unless the sheet is fed by real events. Candidate for 4th or "deliberately left out."
- ❌ **Engineer teammate (builds webpages)** — cut: doesn't fit the WhatsApp conversation demo shape, codegen risk, unweighted by rubric. Compromise kept: Ada's tool *may* generate a template-based campaign page (fill variables, return link) if time allows.
- ❌ **Social media manager (autonomous posting + metrics)** — cut: OAuth/approval walls, test-data rules. Replaced by Mae's human-approval queue.
- ❌ **Recruiter (JD posting + candidate screening)** — cut: external job-board auth, medium-high effort, unweighted.
- ❌ **Event/stall QR assistant** — cut for scope; was a creativity candidate. Revisit only if image-sending is verified and time remains.
- ❌ **Accounts clerk (invoices, airtime)** — partially absorbed into Kemi (payslips/salary); invoice generation possible later via Paystack Payment Request pattern (see `docs/paystack-api.md` demo repos).

## Open questions

1. Final lineup: 3 teammates (Ada + Mae + Zainab) or swap/include Kemi? Brief says small beats half-built; 3 sharing ONE mock API is the plan.
2. Can the agent send an image in the simulator? (test early — decides Mae's design)
3. Should Ada's drop-off be triggered live by the simulator customer? (credibility vs simplicity)
4. Airtime/electricity: mock vending for Kemi, or cut entirely?
5. Tolu: 4th teammate or the "deliberately left out" line?
6. Ask TSG contact: Paystack only, or other sandbox APIs allowed? (good-question credit per brief)

## Decisions already made

- Role: **Technical Product Management**
- One shared **mock Blossom API** (self-hosted MCP server) for all teammates — build the tool once
- Mae never publishes — human approves and posts (owner's stated preference)
- No real customer data, no live keys, no real personal numbers
- Paystack research done → `docs/paystack-api.md`
- Chord API contract on disk → `docs/openapi.json`
- Skills = task-specific files (Chord's own definition: "instructions for a specific task"), shared brand context in a knowledge bundle
