# Chord stream 500 — exhaustion checklist + TSG report draft

## STATUS: options exhausted → send the report now

**Decisive evidence (2026-11-05 15:31 UTC):** fresh **incognito** session, Network tab open, **no message sent** — `GET /api/proxy/v1/conversations/stream` returns **500** repeatedly on plain page load (`X-Amz-Cf-Id: W_OZQjZZXkuz14TfmNu4F9YR5lEmzrXMUix0h8y1wbi9Z3jJig==`, `X-Amz-Cf-Pop: JFK50-P5`, `X-Cache: Error from cloudfront`), while `skills`, `conversations`, `scheduled-tasks` all pass.

This rules out: stale session/cookies (incognito), tool-call specificity (no message sent), our MCP server (not involved at load), teammate state (same page load). No tool path (MCP or OpenAPI) can work while the conversation stream itself is down — the fallback switch is pointless until TSG fixes it.

## A. Exhaustion checklist — final state

### Free (0 credits) — DONE
- [x] **Fresh session test** — incognito: 500 reproduced on load, before any message. DECISIVE.
- [x] **Capture 500 details** — both sessions screenshotted with full headers (two different x-amz-cf-ids = repeated origin failures, JFK edge)
- [x] **Our side proven healthy** — Health `ok · 412 ms`; ngrok shows Chord's `tools/list` → 200 OK 296 ms from 3.218.198.98
- [ ] *Optional leftover:* ngrok `tools/call` presence check — evidence for TSG but no longer decision-relevant
- [ ] *Optional:* Chord status page / Discord incident notice check

### Cheap (0 spent — tests cancelled as unnecessary)
- [x] **Plain message A/B** — CANCELLED: stream 500s on load with no message; a chat test would burn ~3 credits to re-prove it
- [x] **Other teammate / Open test** — CANCELLED: same load-time stream endpoint
- [x] **OpenAPI fallback** — DEFECTIVE until fix: transport swap can't resurrect a dead conversation stream; re-evaluate after TSG responds

### NEW option surfaced from docs (Conversations → Streaming page)
The failing URL is the **web app's internal proxy** (`GET /api/proxy/v1/conversations/stream`), not a documented public endpoint. The docs describe two public streaming APIs:
- `POST /v1/external-chat/messages/stream` — send a message, stream the teammate's reply as SSE (needs `orchestrator:chat`). Body: `{workspace_id, sender_id, text, teammate_id?, session_id?}`
- `GET /v1/threads/{id}/events` — watch a persisted thread live (needs `thread:read`)

- [ ] **Find an API key** — Admin → Developer tab; confirm it carries `orchestrator:chat` (we requested `teammate:read`, `orchestrator:chat`, `thread:read`, `mcp:create/read/manage` earlier)
- [ ] **Bypass test (~3 credits, single turn):** curl `POST /v1/external-chat/messages/stream` with a wallet-check text to Kemi
  - **works** → only the UI's proxy layer is broken; we can run the entire Kemi live loop headlessly (curl → SSE → MCP tool call → reply) as hard proof and recording evidence while the UI bug waits with TSG
  - **fails too** → deeper platform outage, adds weight to the report

### Findings from docs screenshots (MCP connections / Permissions and budgets / Threads and handoff)

**MCP connections page answers the open per-teammate question:**
- `PUT /v1/teammates/{id}` with `{"set_mcp_server_ids": ["mcp-…"]}` sets an explicit allowlist (needs `teammate:update`)
- **But: "An empty or omitted `mcp_server_ids` means all enabled MCP servers in the workspace"** → our workspace-level **Enabled** IS sufficient; Kemi already has all 10 tools by default. The missing per-teammate toggle is UI-dead-end, not a real access gap — our setup is correct as-is. Say so in the TSG question #2 (reworded from "are we missing one?" to "the Settings → Tools → Add tool button redirects to Admin with no picker — is that intended, since the API says omitted assignment = all enabled servers?").

**API base URL discovered:** `https://api.chordhq.xyz` (staging `https://staging.api.chordhq.xyz`) — all `$CHORD_BASE_URL` examples use it. Distinct from `www.chordhq.xyz` (the app whose proxy 500s).

**Free health probes (0 credits, API):**
- [ ] `POST /v1/workspaces/{ws}/mcp-servers/{id}/tools` (`mcp:read`) — tool discovery via API
- [ ] `POST /v1/workspaces/{ws}/mcp-servers/{id}/health` (`mcp:read`) → `{"status":"ok","latency_ms":…}` — the docs' own health check for our registration
- [ ] `GET /v1/threads` + `GET /v1/threads/{id}/turns` (`thread:read`) — read Kemi's persisted turns; confirms whether "Checking the wallet now" was stored and what the server recorded, without spending credits

**Permissions needed for API calls:** `mcp:create/read/manage`, `teammate:read/update`, `orchestrator:chat`, `thread:read` — same set we asked TSG for. Key source: Admin → Developer.

**WhatsApp simulator relevance (Permissions → Enforcement matrix):** signed inbound channels (WhatsApp, Slack, email, external chat) are a **different ingestion path** — "admits before the orchestrator" — vs the web UI's proxy. TSG's simulator test therefore may dodge (or reproduce) the broken `conversations/stream` route; either outcome narrows the bug (workspace-scoped vs platform-wide).

- [ ] Re-word TSG question 2 using the MCP-connections doc quote above
- [ ] Ask TSG for: status page? our API key scopes confirmation?

### Stop and report when:
- any checklist item produces a new distinct error, OR
- credits reach 30 (reserve for the final recording loop), OR
- all cheap tests done

## B. Do NOT bother
- WhatsApp simulator as a bypass — same conversation-stream backend, won't dodge a 500 there (use it later for the *channel* test in the plan, not as a fix)

## C. Draft message to TSG

**Subject:** `conversations/stream` 500 on tool-call turns — MCP server healthy, test credits burning

> Hi team,
>
> While testing our custom MCP server (Blossom Operations API) on Kemi's direct line, every turn where the model attempts a tool call fails after completion:
>
> - **UI toast:** `Billing settlement failed after the model completed; do not retry automatically`
> - **DevTools:** `GET https://www.chordhq.xyz/api/proxy/v1/conversations/stream` → **500 Internal Server Error** (`Content-Length: 0`, `X-Cache: Error from cloudfront`), `2026-11-05 15:10:53 GMT`. All other endpoints on the same page return 200 (teammates, skills, turns, stats, conversations, scheduled-tasks). `x-amz-cf-id: d3SkqpYLqheqrNhUucJztfK7V1NGiBCjR287SLGTeQzFkWi99Z6dU8Jw=`
> - **Our server is healthy:** Admin → Health `ok · 412 ms`; our tunnel inspector shows Chord's own `POST /mcp` (`tools/list`) returning **200 OK in 296 ms** from `3.218.198.98` with all 10 tools
> - **Behaviour:** before enabling the server Kemi honestly refused ("I can't run the wallet check…"); after enabling she progresses to "Checking the wallet now." and the turn dies at the stream/billing step
> - **Credits:** 50 → 38 burned on failed attempts, so we've paused testing to preserve the budget
>
> **Questions:**
> 1. Known issue / any status notice for today?
> 2. Is workspace-level **Enabled** sufficient for a custom MCP server, or is there a per-teammate grant we're missing? (Teammate → Settings → Tools → **Add tool** just redirects to Admin → Channels & Tools — reproduced on a second teammate too — so we can't find one. The API supports `set_mcp_server_ids` on `PUT /v1/teammates/{id}`.)
> 3. API key request: scopes **`teammate:update`** (rename via `display_name`, per-teammate MCP assignment), **`teammate:delete`** (remove the unused starter teammate), **`mcp:read`** (health/discovery probes). The Developer tab's "API credentials" turned out to be outbound-only — calling `GET /v1/teammates` with it returns 401.
> 4. Teammate rename/delete don't appear in the UI either (Settings → Lifecycle offers only Pause/Retire) — is there an edit affordance we're missing, or are both API-only today?
> 5. Any workaround or ETA for the stream bug — we'd like to finish the live wallet loop within our test window.
> 6. Proactive messaging: when a long background task finishes (our design generator takes ~30s), can the teammate push the result into the conversation unprompted? We only see outbound **Webhooks** (Chord → us) and `POST /v1/threads/{id}/messages` (operator-authored, needs a key). Is there a teammate-initiated message endpoint, or is "poll when done" the intended pattern?
> 7. **MCP tool-call timeout and diagnostics (2026-11-08):** a `tools/call` to our server was held open **304 seconds** before the client returned `fetch failed` (a second attempt: 305s; three other calls on the same endpoint completed in ~0.7s). The slowness was on our side that time and we fixed it — but the turn then died with only **"The agent didn't answer"**, and the tool result/timing isn't visible anywhere in the UI. Is there a configurable MCP tool timeout (30–60s would have surfaced our hang immediately), and can the turn log show per-tool elapsed time + the underlying error? When a turn produces no reply, can the UI show *why* (tool error vs model error vs gate)?
> 8. Also observed today (may be unrelated): `www.chordhq.xyz` was briefly unreachable from our network — DNS intermittently failed and TCP connects to the app's edge hung for 15s+, while `docs` and `chat.tsglabs.dev` stayed up. Resolved on your side or on ours? Flagging in case it correlates with the stream 500s (same CloudFront family).
>
> Happy to provide more network traces or try a specific config. Screenshots attached: DevTools 500, tunnel inspector 200, chat toast.

## D. Evidence to attach
1. DevTools Network — stream 500 + headers (the screenshot you took)
2. ngrok inspector — POST /mcp tools/list 200 OK (screenshot taken)
3. Chat with toast (screenshot taken)
