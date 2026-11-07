/**
 * MCP servers for Chord — the vending API exposed as tools, SPLIT INTO TWO
 * ENDPOINTS so tool access can be scoped per teammate before Chord sees it:
 *
 *   POST /mcp          -> ops bucket (Kemi): wallet, validation, purchases
 *   POST /mcp/design   -> design bucket (Mae): generate_design, list_designs,
 *                         list_garments
 *
 * Why two: Chord registers servers, not individual tools, and a teammate with
 * no explicit server assignment inherits every enabled server. Two endpoints =
 * two Chord server entries = each teammate is assigned only their bucket
 * (PUT /v1/teammates/{id} set_mcp_server_ids). With one endpoint, Kemi could
 * generate designs and Mae could buy airtime — no least privilege.
 *
 * Transport: Streamable HTTP, STATELESS (a fresh McpServer per request;
 * sessionIdGenerator undefined). Stateless keeps it trivially correct behind a
 * tunnel — no session affinity, no in-memory session map to lose.
 *
 * Auth: Authorization: Bearer <VENDING_API_KEY> — the token configured as the
 * server credential when Chord registers each server
 * (Admin -> Channels & Tools -> Custom tools (MCP) -> Add server).
 *
 * Architecture: tools SELF-CALL the local REST API (127.0.0.1) instead of
 * duplicating handler logic, so validation, envelopes, error codes, idempotency
 * and the generation cap have exactly ONE source of truth — app.ts.
 *
 * Governance: approve/reject design are deliberately NOT exposed — the approval
 * queue is the human's action ("Mae never publishes"; app.ts designs comment).
 */
import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const API_KEY = process.env.VENDING_API_KEY || 'test_vending_key';

/** The local REST API, called over loopback (never through the tunnel). */
function selfBase(): string {
  return `http://127.0.0.1:${process.env.PORT || 3000}`;
}

interface ApiResult {
  ok: boolean;
  status: number;
  message: string;
  data: unknown;
}

async function api(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  idempotencyKey?: string
): Promise<ApiResult> {
  try {
    const res = await fetch(`${selfBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = (await res.json().catch(() => ({}))) as {
      status?: boolean;
      message?: string;
      data?: unknown;
    };
    return {
      ok: res.ok && json.status !== false,
      status: res.status,
      message: json.message || `HTTP ${res.status}`,
      data: json.data ?? null
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: `Local vending API unreachable: ${(err as Error).message}`,
      data: null
    };
  }
}

/** Every tool answers with the same envelope so the model can branch on it. */
function toToolResult(r: ApiResult) {
  const payload = { ok: r.ok, http_status: r.status, message: r.message, data: r.data };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    ...(r.ok ? {} : { isError: true })
  };
}

/** Amounts in chat are naira; the API works in kobo (Paystack convention). */
const kobo = (naira: number) => Math.round(naira * 100);

type ToolArgs = Record<string, unknown>;

/** Ops bucket — served at POST /mcp (assigned to Kemi). */
function registerOps(server: McpServer): void {
  // --- Kemi: wallet --------------------------------------------------------
  server.registerTool(
    'check_wallet',
    {
      description:
        'Read the Blossom vending wallet: current balance in kobo and the biller account details for funding it. ' +
        'Call this BEFORE every purchase — never assume a balance. A balance of 0 means the owner must top up first.',
      inputSchema: {}
    },
    async () => toToolResult(await api('GET', '/v1/wallet'))
  );

  server.registerTool(
    'record_wallet_funding',
    {
      description:
        'Record a bank-transfer top-up the owner has made to the biller account (push path). ' +
        'Only call this AFTER the owner confirms the transfer and gives you the reference. ' +
        'The same reference can never be applied twice (409 IDEMPOTENT_REPLAY).',
      inputSchema: {
        amount_naira: z.number().positive().describe('Amount the owner sent, in naira'),
        reference: z.string().min(3).describe('Transfer reference from the owner\'s bank app')
      }
    },
    async (args: ToolArgs) => {
      const { amount_naira, reference } = args as { amount_naira: number; reference: string };
      return toToolResult(
        await api('POST', '/v1/wallet/incoming', { amount: kobo(amount_naira), reference })
      );
    }
  );

  // --- Kemi: validation ----------------------------------------------------
  server.registerTool(
    'validate_meter',
    {
      description:
        'Validate an electricity meter against its disco BEFORE any electricity purchase. ' +
        'Returns the registered owner name — read it back to the owner to confirm it is their meter.',
      inputSchema: {
        meter_number: z.string().min(5),
        disco: z.string().min(2).describe('e.g. IKEDC, EKEDC, AEDC, PHED')
      }
    },
    async (args: ToolArgs) => {
      const { meter_number, disco } = args as { meter_number: string; disco: string };
      return toToolResult(await api('POST', '/v1/validate/meter', { meter_number, disco }));
    }
  );

  server.registerTool(
    'validate_phone',
    {
      description:
        'Validate a Nigerian phone number BEFORE any airtime purchase. ' +
        'Returns the network so you can catch a wrong-network request.',
      inputSchema: { phone_number: z.string().min(7) }
    },
    async (args: ToolArgs) =>
      toToolResult(await api('POST', '/v1/validate/phone', args as { phone_number: string }))
  );

  // --- Kemi: purchases -----------------------------------------------------
  server.registerTool(
    'buy_electricity',
    {
      description:
        'Buy electricity for a VALIDATED meter, debiting the wallet. ' +
        'Only after validate_meter succeeded and the owner explicitly confirmed the amount. ' +
        'Returns the token. Errors: 402 INSUFFICIENT_WALLET (top up first), 400 INVALID_METER, ' +
        '503 DISCO_UNAVAILABLE, 422 VALIDATION_FAILED. Pass idempotency_key to make retries safe.',
      inputSchema: {
        meter_number: z.string().min(5),
        disco: z.string().min(2),
        amount_naira: z.number().positive().describe('Amount to buy, in naira'),
        idempotency_key: z.string().optional().describe('Stable key so a retry never double-buys')
      }
    },
    async (args: ToolArgs) => {
      const { meter_number, disco, amount_naira, idempotency_key } = args as {
        meter_number: string;
        disco: string;
        amount_naira: number;
        idempotency_key?: string;
      };
      const key = idempotency_key || `mcp-${randomUUID()}`;
      return toToolResult(
        await api(
          'POST',
          '/v1/purchases/electricity',
          { meter_number, disco, amount: kobo(amount_naira) },
          key
        )
      );
    }
  );

  server.registerTool(
    'buy_airtime',
    {
      description:
        'Buy airtime for a VALIDATED phone number, debiting the wallet. ' +
        'Only after validate_phone succeeded and the owner explicitly confirmed network and amount. ' +
        'Errors: 402 INSUFFICIENT_WALLET (top up first), 400 INVALID_PHONE, 422 VALIDATION_FAILED. ' +
        'Pass idempotency_key to make retries safe.',
      inputSchema: {
        phone_number: z.string().min(7),
        amount_naira: z.number().positive().describe('Amount to buy, in naira'),
        network: z.string().optional().describe('Expected network — mismatches are rejected'),
        idempotency_key: z.string().optional().describe('Stable key so a retry never double-buys')
      }
    },
    async (args: ToolArgs) => {
      const { phone_number, amount_naira, network, idempotency_key } = args as {
        phone_number: string;
        amount_naira: number;
        network?: string;
        idempotency_key?: string;
      };
      const key = idempotency_key || `mcp-${randomUUID()}`;
      return toToolResult(
        await api(
          'POST',
          '/v1/purchases/airtime',
          { phone_number, amount: kobo(amount_naira), ...(network ? { network } : {}) },
          key
        )
      );
    }
  );

  server.registerTool(
    'list_purchases',
    {
      description: 'List purchase receipts (airtime and electricity) — useful to show history or check a token.',
      inputSchema: {}
    },
    async () => toToolResult(await api('GET', '/v1/purchases'))
  );

}

/** Design bucket — served at POST /mcp/design (assigned to Mae). */
function registerDesign(server: McpServer): void {
  // --- Mae: designs --------------------------------------------------------
  server.registerTool(
    'generate_design',
    {
      description:
        'Queue a Blossom by TC design image for the owner approval — NEVER publish or post it yourself. ' +
        'Returns IMMEDIATELY with status "creating" (no image_url yet) — generation takes 15-45 seconds in the background. ' +
        'After ~30 seconds call list_designs (or GET /v1/designs/:id) until status is "pending" and image_url is set, then share the link. ' +
        'status "failed" means generation errored — report rejection_reason plainly. ' +
        'kinds: model-shot (garment on a model), flyer (sale/promo), slide (deck visual), social (post image). ' +
        'garment must be a slug from list_garments — use only the brand\'s own dresses. ' +
        'Costs money — only call after the brief is clear; an identical brief already generating returns 409 GENERATION_IN_PROGRESS.',
      inputSchema: {
        kind: z.enum(['model-shot', 'flyer', 'slide', 'social']),
        brief: z.string().min(10).describe('What the design should show — headline, mood, occasion'),
        garment: z.string().optional().describe('Slug from list_garments, e.g. sky-blue-dress')
      }
    },
    async (args: ToolArgs) => {
      const { kind, brief, garment } = args as {
        kind: string;
        brief: string;
        garment?: string;
      };
      return toToolResult(
        await api('POST', '/v1/designs/generate', {
          kind,
          brief,
          ...(garment ? { garment } : {})
        })
      );
    }
  );

  server.registerTool(
    'list_designs',
    {
      description:
        'List designs in the approval queue. Pass status=pending to show the owner what needs their approval. ' +
        'Approving and rejecting happen in the vending app by the human, not through a tool.',
      inputSchema: {
        status: z.enum(['pending', 'approved', 'rejected']).optional()
      }
    },
    async (args: ToolArgs) => {
      const { status } = args as { status?: string };
      return toToolResult(await api('GET', `/v1/designs${status ? `?status=${status}` : ''}`));
    }
  );

  server.registerTool(
    'list_garments',
    {
      description:
        'List the real Blossom by TC dresses available as design references (the garment store). ' +
        'Use these slugs with generate_design — never invent or describe a dress that is not here.',
      inputSchema: {}
    },
    async () => toToolResult(await api('GET', '/v1/garments'))
  );
}

/**
 * Mount the MCP endpoints on the existing Express app.
 * Mounted OUTSIDE the /v1 auth middleware — each path checks the Bearer itself.
 */
export function mountMcp(app: Express): void {
  const auth = (req: Request, res: Response): boolean => {
    const header = req.headers.authorization || '';
    if (header !== `Bearer ${API_KEY}`) {
      res
        .status(401)
        .json({ status: false, message: 'Unauthorized', data: { error: { code: 'UNAUTHORIZED' } } });
      return true;
    }
    return false;
  };

  const mountEndpoint = (
    path: string,
    serverName: string,
    register: (server: McpServer) => void
  ): void => {
    // Stateless Streamable HTTP: one server + transport per POST, closed after
    // the response — nothing to persist, correct behind tunnels and retries.
    app.post(path, async (req, res) => {
      if (auth(req, res)) return;
      const server = new McpServer({ name: serverName, version: '1.0.0' });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        // The client may abort mid-call (2026-11-05: an aborted long request
        // surfaced as an unhandled rejection that killed the process). Close
        // quietly — and server.ts keeps the process alive if anything slips.
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });
      try {
        register(server);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.error(`[mcp] ${path} request failed:`, err);
        if (!res.headersSent) {
          res
            .status(500)
            .json({ status: false, message: 'MCP request failed', data: { error: { code: 'INTERNAL_ERROR' } } });
        }
      }
    });

    // Stateless servers have no SSE stream to open or sessions to DELETE.
    app.get(path, (req, res) => {
      if (auth(req, res)) return;
      res.status(405).json({
        status: false,
        message: `Stateless MCP server — POST JSON-RPC to ${path}, GET (SSE) is not supported`,
        data: {}
      });
    });
    app.delete(path, (req, res) => {
      if (auth(req, res)) return;
      res.status(405).json({ status: false, message: 'Stateless MCP server — no sessions to delete', data: {} });
    });
  };

  // Two buckets, two Chord server registrations — least privilege per teammate.
  mountEndpoint('/mcp', 'blossom-vending-api', registerOps);
  mountEndpoint('/mcp/design', 'blossom-design-api', registerDesign);

  console.log(
    '[mcp] mounted: POST /mcp (ops: wallet/validate/purchases) + POST /mcp/design (designs/garments) — stateless streamable HTTP'
  );
}
