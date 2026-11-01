# Chord platform observations

## Field constraints found in the app

- **`role_name` max length = 80 characters** — Role field on "Review your teammate" rejects longer values (`role_name exceeds max length of 80`). Keep roles short; detail belongs in skill files. (Hit with Kemi's role.)

## Screenshot: Kemi created (teammate page)

- **Kemi exists** — created with `utility-bills` skill, **published as v1** (11/1/2026, 6:01:24 PM), `Instructions` badge on `utility-bills.md`, version history visible (Edit draft / Download skill / Remove).
- Sidebar: **"Kemi - direct line — Chat directly with Kemi"** = in-app conversation surface. Filters: All / Escalated / Needs review. Test starters present ("What can Kemi help me with?" etc., editable via **Edit test starters**).
- "No customer conversations yet — connect a messaging channel to start receiving them" — expected; no channel bound.
- **Collaboration settings** — teammates can ask each other for help (accept-requests toggle in Settings).

## Screenshot: Kemi's Settings panel

- **Collaboration** — "Accept requests from other teammates" toggle (off by default).
- **Allowed links** — "Any public website" toggle + allowlist textarea (`files.example.com`); controls links a *person* shares, not automatic browsing. Save/Discard.
- **Tools** — list shows **Paystack, GitHub, Bookings, Checklist, Linear, Notion — all "Needs connecting"** (must be connected in workspace settings first). "Add tool" button.
- **Channels** — **Test conversation → "Open test"**: *"Try Kemi here or use your connected simulator. No messaging channel required."* ← the no-WhatsApp test path.
- **Lifecycle** — Status Active (pausable/retirable): **Pause Kemi** (stops replying, history preserved), **Retire Kemi** (disconnects channels, erases history, cannot be undone).

## Screenshot: Admin (chordhq.xyz/admin)

- **Workspace:** Permissions (who can create/activate teammates), Workspace details ("Sky Stripe" — **Needs setup**), Members (1 active, 0 pending).
- **Connections:** Channels & Tools (0 connected), Connected apps (approved apps that can access Chord data), Knowledge sources (0), Customer identity linking (WhatsApp/Telegram/email), Bookings & resources (0).
- **Billing:** Budgets (optional credit limits per teammate/automation), **Billing: `0 credits remaining` · low-balance threshold 1 — "Low balance"** ← confirmed zero credits, not just low.
- **Security:** **API keys — 1 active key `chord_live_lJo...` (Active)**, Audit log (6 events).
- Admin = workspace-owner controls: who's on the team, what's connected, billing, logs.

## Screenshot: Admin → Channels & Tools → Channels tab

- **Your WhatsApp numbers: 0** — rent one from the pool or connect your own ("Add number").
- Connected: 0. **Available to connect (10):** **Paystack**, Slack, GitHub, Bookings, Checklist, Linear, **WhatsApp Business**, Resend (Email), Notion, Telegram — all Off/not connected.

## Screenshot: Channels & Tools → Tools tab

- **Catalogues (0)** — "teammates quote these items, prices, and availability to customers — they never invent menu entries" (Add catalog).
- **Custom tools (MCP) (0)** — "Each MCP server exposes verbs the AI can call, just like a first-party tool connector" — **Add server** ← where our vending server registers.
- **Custom tools (API) (0)** — "Custom REST tools. Declare an endpoint by hand and the AI can call it, just like an MCP server or a first-party connector" — **Import OpenAPI** / **Add connection** ← possible alternative to MCP: our vending API could be added via OpenAPI import or hand-declared endpoints.

## Screenshot: Channels & Tools → Developer tab

- **Webhooks (0)** — tenant-wide Chord events to our systems; human-takeover notifications use `conversation.escalated` ("Add webhook").
- **API credentials (0)** — secrets our API connections authenticate with; applied workspace-wide as a request header; stored encrypted, never shown again ("Add token").
- **Route tester** — try the router the AI uses to pick a connection; **API activity** — review recent calls (Filters/Refresh).
- **Workspace opt-ins (7, all Disabled):** Paystack, Telegram, WhatsApp, Slack, GitHub, Linear, Notion.
- Build provenance: branch `production`, build `000000027`, version 0.15.22, source commit 10/19/2026, required core 0.16.0.0.

## Screenshot: Admin → Channels & Tools → Telegram (detail page)

- **Type:** TELEGRAM · **Scope:** Workspace connector · **Status:** Not connected · Connected/Disconnected: Not recorded. **"Connect"** button top-right.
- **Sessions (0)** — *"Every bot connected to this workspace. Each runs independently and can be assigned to a different teammate."* → **"Add bot"** ← create via @BotFather, paste token here; one bot per session, assignable per teammate.
- **Connections (0)** — *"Tenant-level credentials, each attachable to one or more workspaces. A pending connection can exist before the connector reads as connected."* → **"New connection"**.
- **Two-level model:** tenant-level *Connections* (credentials) → workspace *Sessions* (bots assigned to teammates). A connection can be pending before it reads as connected — don't panic if status lags.
- **Telegram as self-serve test channel:** like OpenClaw-style Telegram bots — own bot, own token, no WhatsApp number, no TSG approval for the channel itself. Enable workspace opt-in + this connection, add a bot, assign to Kemi, chat from personal Telegram. Still burns credits per message.

## Key implications

1. **Testing without WhatsApp works** — in-app direct line, Settings → Test conversation → Open test, or the API with the active key. The WhatsApp simulator is a separate connected app that slots in later.
2. **Real blocker = 0 credits**, not WhatsApp. Test conversations bill usage → expect `PAYMENT_REQUIRED` until TSG tops up. Message them (the brief says tell them straight away; how we handle it is assessed).
3. **Two ways to give Kemi her tool:** MCP server ("Add server") **or** Custom tools (API) via OpenAPI import / hand-declared REST. Decide at build time — OpenAPI import may be simpler for a small REST API.
4. **Chord has a native Paystack connector** (disabled by default) — inspect what it exposes before building our own Paystack tool; may reduce work or may be too limited.
5. **Paystack appears both as a channel and a tool** — likely payment-related connectors; check the detail page.

Facts pulled from screenshots of the Chord app (chordhq.xyz) as we work. Durable notes only — things that affect how we build. Field-note-worthy problems go in `field-notes.md` instead.

## Screenshot: Create a teammate page (`chordhq.xyz/teammates/new`)

**How skills get in:**
- Upload accepts **Markdown, text, JSON, YAML, CSV, and ZIP** — a whole folder of skill files can be dropped at once (supports "Choose folder"), so multiple skills per teammate upload in one action.
- Portable format is **`SKILL.md` with YAML frontmatter** between `---` lines: `name` (e.g. `community-manager`) and `description` (what it does and when to use it). Plain Markdown and text instructions also work.
- **PDFs go to Knowledge**, not skills — confirms the split: instructions = skills, reference material (brand guidelines, lookbook, handbook) = knowledge bundles.
- Page copy: *"A skill gives your teammate instructions for a specific task: what to do, how to do it, and what a good result looks like."* — task-scoped skills, matching our one-skill-per-task decision.
- Helpers on the page: **View an example skill**, **Download a skill template** (this is where `SKILL-template.md` came from), **Duplicate an existing teammate** — duplication is a platform feature (could clone a configured teammate instead of rebuilding).

**App navigation (left sidebar):** Search, Home, **Team**, Activity, **Admin** — teammates live under "Team"; Admin likely holds workspace/API key settings.

**Credits:**
- Persistent red banner: *"You're running low on credits — top up to avoid interruptions"* with a **Top up** button — visible from the very start, before any teammate was built.
- Action if credits run out or something blocks us: brief says tell the TSG contact straight away; how we handle it is assessed. Log in `field-notes.md`.

## From the docs overview screenshot (earlier)

- Docs are public and deployment-specific: guides at `$CHORD_BASE_URL/docs`, endpoint reference at `$CHORD_BASE_URL/docs/api`.
- Machine-readable contract: `openapi.json`, 101 paths / 146 operations, anonymous at `GET /api-docs/public` (also `/docs/api-reference/openapi.json`) → saved as `docs/openapi.json`.
- Base URL: `https://api.chordhq.xyz` (prod), `https://staging-api.chordhq.xyz` (staging).
- Auth: `Authorization: Bearer chord_live_...` on every `/v1` request; inbound webhooks under `/api/*` verify HMAC signatures instead.
- **No sandbox** — every call bills real usage, writes real records, fires real webhooks. Build against a tenant we're willing to fill with test data.
- Scopes are exact strings (no wildcards): `orchestrator:chat`, `rag:retrieve`, `rag:ingest`, `rag:delete`, `teammate:read`, `thread:read`, `webhook:read/create/delete`, `usage:read`.

## Screenshot: "Build your first teammate" guide (docs)

**The official 5-step flow** — this is the roadmap for our upload:

1. **Create a teammate** — Teammates → Create a teammate, upload skill file(s). Minimal `SKILL.md` = frontmatter with **only `name` and `description`** — *"No additional YAML fields are needed... they do not require extra frontmatter fields."* Ordinary Markdown/text instruction files also accepted. Supporting text goes in a folder/ZIP: `builder-support/SKILL.md` + `references/faq.md` — **the path in instructions must match the uploaded file path**. PDFs → Knowledge, not skill files.
2. **Review and create** — review files, the file marked **Instructions** becomes the teammate's name/role. If a name already exists, pick a distinct one. **Creating from files publishes the reviewed skill versions.** Teammate stays **paused until setup finishes**; activation follows workspace permissions.
3. **Publish changes** — Teammate's **Skills panel** → edit. Needs teammate-update + edit permission. File rows have **Edit/Remove**; **Make instructions** marks a Markdown/text file as the instruction file; **Instructions badge** identifies the selected file. Uploading another instruction-style file asks: use as instructions or keep as reference. **Save draft** doesn't change live records; **Draft not live** until *Review and publish* → *Publish skill*. Concurrent edits → editor keeps local edits and offers a merge; stale versions can't overwrite others' work. **Only published, included skills affect the next reply.** A paused teammate needs activation before it can answer.
4. **Test before connecting a channel** — in-app conversation, no WhatsApp number needed. **Edit test starters** replaces suggested questions. **"Why this reply"** (admin) shows exact published versions used, files available, recorded reference delivery — *"a file merely listed in the package is not evidence the model read it"*; tool loop reads references on demand; router fallback includes them in context. **Debugging rule:** if a reply says it can't read something → check skill is published AND included, correct file marked Instructions, reference path exists in the published version, then inspect read evidence. A draft or editor-visible file does NOT prove the reply received it.
5. **Add knowledge, tools and channels** —
   - **Knowledge:** teammate Settings → Knowledge → Sources → New library for this teammate; documents or URL. Retrieval is separate from skill instructions.
   - **Live links:** gear → Allowed links → `link_access_allowlist` — controls reading links a *person* supplies, not automatic browsing of URLs mentioned in a skill.
   - **Tools:** Teammate settings → Tools shows **On / Off / Needs connecting**; Add tool opens workspace tool settings. **A tool must be BOTH allowed for the teammate AND connected in the workspace.**
   - **Channels:** Teammate settings → Channels → Add channel. In-app testing is listed separately from connected customer channels.
   - Re-run the FAQ test after changing a published skill or operational settings.

**Critical for our plan:**
- **The external WhatsApp simulator is a separate connected app** — needs its own **Chord Connect approval, organization access and consent**. Its presence does NOT mean a real WhatsApp number is connected. (See Partner OAuth chat.) → simulator access may require TSG Labs action, not just us.
- Whole flow works **in the app without an API key**; workspace must allow teammate creation, an administrator may need to activate.
- Skill file format confirmed: frontmatter = `name` + `description` only (our files comply).

## Screenshot: "Concepts" guide — the six ideas

- **Teammate** — the AI agent; the only object you need an id for day-to-day. Carries persona, instructions, knowledge bundles, tools, channels, and how independently it may act. Two properties explain behavior: **`autonomy`** (how much it does without asking) and **`confidence_threshold`** (when it escalates to a human rather than answers). *We don't set these, but they explain handoffs — useful vocabulary for the go-live note and interview.*
- **Workspace** — the container a teammate lives in; owns artifacts and config. A tenant can have several. **Use a dedicated workspace for development** so test conversations stay out of production. Knowledge bundles are scoped to a workspace or shared account-wide.
- **Thread and turn** — a thread is one continuous conversation; a turn is one exchange (inbound message + reply). **Continuity is carried by `session_id`, not by history you assemble.** Conversation key = `sender_id` + `session_id` inside the workspace. Same pair → same thread; new `session_id` → fresh conversation. Omitting `session_id` defaults to literal `"sync"` — piles every message from one sender into one never-ending thread (**always send a UUID**).
- **Knowledge bundle** — named collection of documents; Chord chunks/indexes them; assigned teammates answer from and cite it. **Bundles are the unit of assignment, not individual docs** — adding a doc to an assigned bundle takes effect immediately with no teammate change. Direct search: `POST /v1/knowledge/search` with `query` (+ optional `bundle_id`, `top_k`, `min_score`, `category` — any other field → 400). Needs `rag:retrieve`.
- **Channel** — where the conversation physically happens (Slack, WhatsApp, Telegram, email, own surface, or the API). **A reply is delivered back the way the message arrived** — build for asynchrony, don't wait on the response body.
- **Human handoff** — first-class, not an edge case. Five endpoints (all need `thread:write`): `take-over`, `hand-back`, `pause` (requires non-blank `reason` — audit log), `resume`, `messages` (send as human operator). Optional `operator_user_id` on all five. Invalid transition → **409 `INVALID_STATE`** — read state back, don't assume. Subscribe to **`conversation.escalated`** webhook to be told the moment it happens.
- **Conversation flow:** inbound → teammate decides (answer from knowledge / call a tool / escalate) → reply delivered on the same channel → thread records what happened. That's the whole loop.

## Screenshot: "Quickstart" — first message in five minutes

- **Needs two things from the account owner: an API key and the workspace id.** Teammate id comes from the first call.
- **Scopes for the whole guide:** `teammate:read` (find teammate), `orchestrator:chat` (send), `thread:read` (read back). Profile A carries the first two; `thread:read` comes with Profile C — **ask for it if we want step 3**.
- Setup: export `CHORD_BASE_URL`, `CHORD_API_KEY`, `CHORD_WORKSPACE_ID`; verify with `GET /v1/teammates?workspace_id=...` → 200 = key live + has `teammate:read`; response is a **bare array** — take the `id` of the target teammate.
- **401 = wrong/expired key. 403 = valid key missing the scope.** Teammate object **omits fields rather than sending null** — test for presence, not null.
- **Pick environment deliberately:** one environment per deployment; use a dedicated dev workspace; ask the account owner which workspace/teammate to build against.
- **Send first message:** `POST /v1/external-chat/messages` (needs `orchestrator:chat`), body: `workspace_id`, `sender_id`, `text` (required) + `teammate_id`, `session_id`, `message_id`, `display_name` (optional). Returns `thread_id`, `reply`, `agent_invoked`, `reason`, `steps`.
- **Three fields that matter:** `reply` (show to user), `thread_id` (persist it — how you read back and how a human takes over), `agent_invoked` (false → `reason` explains: gate stopped it, human holds it, paused, or teammate chose silence — **still a 200, an outcome not an error**; `no_reply` means gate stopped the turn).
- `steps` = the work behind the answer: retrieval/tool-call entries with `title`, `instruction`, `result`; tool-loop steps add `tool_name`, `success`, `latency_ms`. **Empty list = answered without calling anything.**
- **Conversation key = `sender_id` + `session_id`.** Chord loads the thread's last 30 turns automatically — you send one message per call, nothing else. **Mint a `session_id` per conversation (UUID).**
- `message_id` = per-message idempotency key (dedupes retries; repeat returns `agent_invoked: false`) — omit to auto-generate or pass your own to make retries safe.
- Errors: missing `workspace_id`/`sender_id`/`text` → 400 `INVALID_REQUEST`; no `orchestrator:chat` → 403; upstream failure → 502 `ORCHESTRATOR_ERROR`; 503 `DISABLED` = deployment has request/response surface turned off. Send `X-Request-ID` on every call, quote it in support requests.
- **Read back:** `GET /v1/threads/{id}/turns?limit=50` (needs `thread:read`). First page = newest; cursor is opaque — pass back exactly; stop when `has_more` false. Branch rendering on `sender.kind`: `remote` (person), `agent` (teammate), `human_operator`, `system`. **Same conversation operators see** — appears in `GET /v1/threads`.
- **Streaming:** `POST /v1/external-chat/messages/stream`, identical body, `text/event-stream`. Five consumer rules: concatenate every `token`'s `data` (raw string deltas, not JSON); `done` is the terminator (carries `thread_id`, `agent_invoked`, `steps`) — stream without it = aborted, discard and retry; gated turn arrives as `done` with `agent_invoked: false` and empty `thread_id`; **check HTTP status before parsing events** (auth/validation fail before stream opens as normal JSON); skip `:` comment lines (keepalives every 15s; server idle-timeouts ~60s — set client deadline ~120s).

## Screenshot: "Authentication"

- Bearer key on every `/v1/*` request: `Authorization: Bearer chord_live_...` — capital B, one space, HTTPS. **`Authorization` is the only header Chord reads for credentials.** Key identifies the tenant — never send a tenant id.
- **Key format:** `chord_live_<env tag><32 random bytes base64url>` — treat as opaque, never parse/normalize. **Keep it server-side** (secrets manager/env var), out of browser bundles and repos.
- Status codes: **200** = valid + has scope; **403** = valid but missing scope; **401** = credential rejected (fix credential, don't loop-retry — a 401 never becomes valid).
- `lifecycle_state` on teammate reads: `TEAMMATE_ACTIVE`, `TEAMMATE_PAUSED`, `TEAMMATE_RETIRED`. Legacy no-state records read as ACTIVE. **Paused and retired teammates decline inbound turns.**
- **Rate limit: default 60 requests/minute per key** (token bucket, continuous refill; all workers share the budget). Read `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After` (on 429). No headers → pace at 60/min. On 429: sleep `Retry-After` and retry — **`RATE_LIMIT_EXCEEDED` is a throttle, safe to retry** (never reached the handler); other 429 codes are spend/storage caps → hand to operator, don't loop.
- **401 error envelope:** `{ "error": { "code": "UNAUTHORIZED", "message": "...", "status": 401 }, "requestId": "..." }` — branch on `error.code`, read `message` for the fix.
- **Signed requests both ways:** inbound to us (`POST /api/external-chat/webhook/{source_id}`, `POST /api/events/webhook/{subscription_id}`) = **HMAC over raw body, no bearer token**; Chord's outbound webhooks to our endpoint signed the same way — **verify signature before parsing**.
- **`X-Request-ID`:** send your own on every call, log the response header — ties your call to Chord's server-side logs; set on every response including 401/403/429. Quote it in support requests.
- **Remote MCP server credentials (KEY for our tool):** use a Chord API key with explicit **`mcp:create`, `mcp:read`, `mcp:manage`** permissions for workspace MCP management. Server credential configured as **`auth_token`** or via the remote provider's OAuth flow. It authorizes **Chord → our server**; it does not authenticate our requests to Chord. Chord Connect delegated tokens cannot call these management routes. See **MCP connections** guide for full setup.
- **Partner OAuth / Chord Connect** (relevant to the WhatsApp simulator): `connect.chordhq.xyz` (prod) / `connect.staging.chordhq.xyz`. For a shared app, platform approval makes registration available; **the organization must also enable Chord Connect and select the app under Admin → Connected apps; each person then authorizes scopes.** An *Approved* registration alone grants nothing. Access tokens go to `/partner/v1/*` routes, not `/v1/*`.
- Session/tenant sign-in details (legacy `POST /v1/auth/login`, tenant selection) — app-side, not needed for our API integration.

## Open questions for the platform

- Does the WhatsApp simulator support the agent **sending an image**? (gates Mae's design)
- Can a teammate send **proactive/agent-initiated** messages, or only replies? (affects weekly-brief and cart-follow-up ideas)
- How are **MCP servers** registered in the UI vs API — is there an Admin screen for it?
- What does **Duplicate an existing teammate** copy — skills, knowledge, channels, tools?
