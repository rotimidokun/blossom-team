/**
 * MCP servers for Chord — the API exposed as tools, split into THREE endpoints
 * so each teammate gets only their bucket (Chord registers servers, not
 * individual tools): /mcp = ops (Kemi), /mcp/design = designs (Mae),
 * /mcp/sales = catalogue/orders/payments (Ada).
 *
 * Stateless Streamable HTTP (fresh server per request) — no session affinity,
 * trivially correct behind tunnels. Auth: Bearer VENDING_API_KEY. Tools
 * self-call the local REST API over loopback so validation, idempotency and
 * error shapes have ONE source of truth (app.ts). approve/reject are
 * deliberately not exposed — the approval queue is the human's action.
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
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: Record<string, unknown>,
  idempotencyKey?: string
): Promise<ApiResult> {
  const startedAt = Date.now();
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
    console.log(`[mcp->api] ${method} ${path} -> HTTP ${res.status} in ${Date.now() - startedAt}ms`);
    return {
      ok: res.ok && json.status !== false,
      status: res.status,
      message: json.message || `HTTP ${res.status}`,
      data: json.data ?? null
    };
  } catch (err) {
    // undici hides the real reason (e.g. HeadersTimeoutError at 300s) inside
    // `cause` — log it, or a hang is indistinguishable from a dead server.
    const cause = (err as { cause?: { code?: string; name?: string; message?: string } }).cause;
    console.error(
      `[mcp->api] ${method} ${path} FAILED after ${Date.now() - startedAt}ms: ` +
        `${(err as Error).message}${cause ? ` (cause: ${cause.name || cause.code || cause.message})` : ''}`
    );
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

  // --- Kemi: staff & monthly payday ------------------------------------------
  server.registerTool(
    'list_staff',
    {
      description:
        'The payroll: who works at Blossom by TC (the AI teammates), with role and monthly salary (KOBO — divide by 100 for naira). ' +
        'Read this FIRST to show the owner the payday summary before running it.',
      inputSchema: {}
    },
    async () => toToolResult(await api('GET', '/v1/staff'))
  );

  server.registerTool(
    'pay_salaries',
    {
      description:
        "Run payroll for a month: one Paystack transfer per staff member, same run. ALWAYS show the owner the summary (who, amounts, total) " +
        "and get the owner code FIRST — the server verifies owner_code and refuses without it (403). " +
        "Returns each attempt: status 'paid' (transfer_code) or 'failed' (failure_reason — e.g. balance not enough; report it plainly, never fake a payslip). " +
        "Staff already paid for the month are skipped (skipped count) — reruns are safe. Errors: 403 FORBIDDEN (bad owner code), 422 VALIDATION_FAILED (bad month/staff_id).",
      inputSchema: {
        owner_code: z.string().min(1).describe("The owner's secret phrase — ask for it, don't assume it"),
        month: z.string().optional().describe('YYYY-MM, defaults to the current month'),
        staff_id: z.string().optional().describe('Pay ONE staff member only; omit for the full monthly run')
      }
    },
    async (args: ToolArgs) => {
      const a = args as { owner_code: string; month?: string; staff_id?: string };
      return toToolResult(
        await api('POST', '/v1/salaries', {
          owner_code: a.owner_code,
          ...(a.month ? { month: a.month } : {}),
          ...(a.staff_id ? { staff_id: a.staff_id } : {})
        })
      );
    }
  );

  server.registerTool(
    'list_salaries',
    {
      description:
        'Salary history: each attempt with month, amount (kobo), status paid/failed, source (wallet/paystack), transfer reference/code or failure reason. ' +
        'Filter by staff_id and/or month; no filter = everything (the payslip audit trail).',
      inputSchema: {
        staff_id: z.string().optional(),
        month: z.string().optional().describe('YYYY-MM')
      }
    },
    async (args: ToolArgs) => {
      const a = args as { staff_id?: string; month?: string };
      const query = [
        a.staff_id ? `staff_id=${encodeURIComponent(a.staff_id)}` : '',
        a.month ? `month=${encodeURIComponent(a.month)}` : ''
      ]
        .filter(Boolean)
        .join('&');
      return toToolResult(await api('GET', `/v1/salaries${query ? `?${query}` : ''}`));
    }
  );

  server.registerTool(
    'check_paystack_balance',
    {
      description:
        'The business Paystack bank balance (test mode), in KOBO — divide by 100 for naira. ' +
        'This is the BANK, a different pot from the vending wallet (check_wallet): payroll and transfers draw on the bank, ' +
        'airtime/electricity draw on the wallet. Use it to answer "what is the Paystack balance?" and to explain a failed transfer. ' +
        'Errors: 503 PAYSTACK_UNAVAILABLE (key missing or Paystack unreachable).',
      inputSchema: {}
    },
    async () => toToolResult(await api('GET', '/v1/paystack/balance'))
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

/** Sales bucket — served at POST /mcp/sales (assigned to Ada). */
function registerSales(server: McpServer): void {
  // --- Ada: catalogue (Paystack-backed) --------------------------------------
  server.registerTool(
    'list_products',
    {
      description:
        'The real catalogue from Paystack: products with price (KOBO — divide by 100 for naira), stock, photo link, buy link, plus storefront_url (the hosted shop). ' +
        'Call before quoting anything — never invent products or prices.',
      inputSchema: {}
    },
    async () => toToolResult(await api('GET', '/v1/products'))
  );

  server.registerTool(
    'update_product',
    {
      description:
        'Change a product in the Paystack catalogue — price, name, description, or stock. ' +
        'REQUIRES the owner code: show the owner what will change, ask for the code, and pass it — ' +
        'the server verifies it and refuses without it (403 FORBIDDEN, catalogue unchanged). ' +
        'price_naira is in NAIRA (converted to kobo). The change is visible immediately on list_products and the hosted shop. ' +
        'Errors: 403 (bad/missing owner code), 404 NOT_FOUND, 422 VALIDATION_FAILED, 503 PAYSTACK_UNAVAILABLE.',
      inputSchema: {
        product_id: z.number().int().positive(),
        owner_code: z.string().min(1).describe("The owner's secret phrase — ask for it, don't assume it"),
        price_naira: z.number().positive().optional().describe('New price in naira'),
        name: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
        quantity: z.number().int().min(0).optional().describe('Stock count')
      }
    },
    async (args: ToolArgs) => {
      const a = args as {
        product_id: number;
        owner_code: string;
        price_naira?: number;
        name?: string;
        description?: string;
        quantity?: number;
      };
      const patch: Record<string, unknown> = { owner_code: a.owner_code };
      if (a.price_naira !== undefined) patch.price = kobo(a.price_naira);
      if (a.name !== undefined) patch.name = a.name;
      if (a.description !== undefined) patch.description = a.description;
      if (a.quantity !== undefined) patch.quantity = a.quantity;
      return toToolResult(await api('PUT', `/v1/products/${a.product_id}`, patch));
    }
  );

  // --- Ada: orders + payment windows -----------------------------------------
  server.registerTool(
    'create_order',
    {
      description:
        'Record that a customer wants a product AND open their Paystack payment window in one step. ' +
        'Include the agreed size from your size chart when you have it. ' +
        'Returns the order (status pending, amount in kobo, size) and payment_url to share with them. Retry-safe: an already-open order for the same customer+product ' +
        'comes back with replay: true instead of a duplicate. Amount always comes from the catalogue — never type your own price. ' +
        'Errors: 422 VALIDATION_FAILED (bad product id or email), 503 PAYSTACK_UNAVAILABLE.',
      inputSchema: {
        product_id: z.number().int().positive().describe('Product id from list_products'),
        customer_name: z.string().min(1),
        customer_email: z.string().regex(/^\S+@\S+\.\S+$/, 'must be an email address'),
        size: z.string().max(24).optional().describe('Agreed size from your UK chart, e.g. "7–8 Years" or "UK 8"')
      }
    },
    async (args: ToolArgs) => {
      const a = args as {
        product_id: number;
        customer_name: string;
        customer_email: string;
        size?: string;
      };
      return toToolResult(
        await api('POST', '/v1/orders', {
          product_id: a.product_id,
          customer_name: a.customer_name,
          customer_email: a.customer_email,
          ...(a.size ? { size: a.size } : {})
        })
      );
    }
  );

  server.registerTool(
    'create_payment_link',
    {
      description:
        '(Re)open a payment window for an order — used for follow-up/recovery offers. ' +
        'amount_naira (optional) overrides the amount — pass the discounted price and note the offer, e.g. note "10% off recovery offer". ' +
        'Returns the fresh payment_url. Never opens a window on a paid order (409 INVALID_STATE).',
      inputSchema: {
        order_id: z.string().min(3),
        amount_naira: z.number().positive().optional().describe('Discounted amount in naira'),
        note: z.string().max(140).optional().describe('What this offer is, e.g. "10% off"')
      }
    },
    async (args: ToolArgs) => {
      const a = args as { order_id: string; amount_naira?: number; note?: string };
      const body: Record<string, unknown> = {};
      if (a.amount_naira !== undefined) body.amount = kobo(a.amount_naira);
      if (a.note !== undefined) body.note = a.note;
      return toToolResult(await api('POST', `/v1/orders/${a.order_id}/payment-link`, body));
    }
  );

  server.registerTool(
    'verify_payment',
    {
      description:
        'Ask Paystack whether the customer ACTUALLY paid for an order. Only a paid: true response means success — ' +
        'then the order flips to paid and the customer is recorded (or their total grows). ' +
        'paid: false comes with verification_status (abandon/pending/unverifiable) — report it plainly and never claim a payment that is not verified. Errors: 404 NOT_FOUND.',
      inputSchema: { order_id: z.string().min(3) }
    },
    async (args: ToolArgs) =>
      toToolResult(await api('POST', `/v1/orders/${(args as { order_id: string }).order_id}/verify`))
  );

  server.registerTool(
    'get_order',
    {
      description: 'One order with its full state: pending / offer_sent / paid / lead, amount (kobo), payment_url, references.',
      inputSchema: { order_id: z.string().min(3) }
    },
    async (args: ToolArgs) =>
      toToolResult(await api('GET', `/v1/orders/${(args as { order_id: string }).order_id}`))
  );

  server.registerTool(
    'list_orders',
    {
      description:
        'The sales pipeline. No status = everything; status = one slice: pending (awaiting payment), ' +
        'offer_sent (follow-up sent), paid (done), lead (dropped off — recovery targets). Amounts in kobo.',
      inputSchema: {
        status: z.enum(['pending', 'offer_sent', 'paid', 'lead']).optional()
      }
    },
    async (args: ToolArgs) => {
      const { status } = args as { status?: string };
      return toToolResult(await api('GET', `/v1/orders${status ? `?status=${status}` : ''}`));
    }
  );

  server.registerTool(
    'record_follow_up_offer',
    {
      description:
        'Mark an order as offer_sent — ONLY after you actually sent the recovery/follow-up offer to the customer. ' +
        'Moves pending or lead -> offer_sent (repeat-safe). Paid orders cannot change (409 INVALID_STATE).',
      inputSchema: {
        order_id: z.string().min(3),
        note: z.string().max(140).optional().describe('The offer, e.g. "10% off if you pay today"')
      }
    },
    async (args: ToolArgs) => {
      const a = args as { order_id: string; note?: string };
      const body: Record<string, unknown> = { status: 'offer_sent' };
      if (a.note !== undefined) body.note = a.note;
      return toToolResult(await api('POST', `/v1/orders/${a.order_id}/status`, body));
    }
  );

  server.registerTool(
    'mark_drop_off',
    {
      description:
        'Tag an order whose payment window lapsed with no payment: it becomes a lead (recovery target). ' +
        'Moves pending or offer_sent -> lead. Never on a paid order (409 INVALID_STATE).',
      inputSchema: { order_id: z.string().min(3) }
    },
    async (args: ToolArgs) =>
      toToolResult(
        await api('POST', `/v1/orders/${(args as { order_id: string }).order_id}/status`, { status: 'lead' })
      )
  );

  // --- Ada: customers ---------------------------------------------------------
  server.registerTool(
    'list_customers',
    {
      description:
        'Everyone who has completed a payment: name, email, order count, total spent (kobo). ' +
        'Customers appear here automatically when verify_payment succeeds — never invent people.',
      inputSchema: {}
    },
    async () => toToolResult(await api('GET', '/v1/customers'))
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
        // Close quietly on client abort (2026-11-05: an abort killed the process).
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

  // Three buckets, three Chord server registrations — least privilege per teammate.
  mountEndpoint('/mcp', 'blossom-vending-api', registerOps);
  mountEndpoint('/mcp/design', 'blossom-design-api', registerDesign);
  mountEndpoint('/mcp/sales', 'blossom-sales-api', registerSales);

  console.log(
    '[mcp] mounted: POST /mcp (ops) + POST /mcp/design (designs) + POST /mcp/sales (catalogue/orders/payments) — stateless streamable HTTP'
  );
}
