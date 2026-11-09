/**
 * Live MCP probe — verifies both buckets on a running server, locally or
 * through a tunnel (pass BASE, e.g. node probe-mcp.mjs https://ngrok-url).
 *
 * Checks: wallet account reflects the seed, /mcp lists ONLY the 7 ops tools,
 * /mcp/design lists ONLY the 3 design tools, auth rejects without a token.
 * Exit code 0 = all green; 1 = something broke. Used by the builder and as a
 * post-deploy health check (Render): node probe-mcp.mjs <base-url>.
 */
const base = process.argv[2] || 'http://localhost:3000';
const KEY = process.env.VENDING_API_KEY || 'test_vending_key';

const auth = { Authorization: `Bearer ${KEY}` };
const mcpHeaders = {
  ...auth,
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream'
};

async function rpc(path, payload) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  const dataLine = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .pop();
  return { http: res.status, json: dataLine ? JSON.parse(dataLine.slice(5)) : null };
}

async function toolNames(path) {
  const init = await rpc(path, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'probe', version: '1.0.0' }
    }
  });
  if (init.http !== 200) return { error: `initialize HTTP ${init.http}` };
  const list = await rpc(path, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  if (list.http !== 200) return { error: `tools/list HTTP ${list.http}` };
  return { names: (list.json?.result?.tools || []).map((t) => t.name) };
}

const OPS = [
  'check_wallet',
  'record_wallet_funding',
  'validate_meter',
  'validate_phone',
  'buy_electricity',
  'buy_airtime',
  'list_purchases',
  'list_staff',
  'pay_salaries',
  'list_salaries'
];
const DESIGN = ['generate_design', 'list_designs', 'list_garments'];
const SALES = [
  'list_products',
  'update_product',
  'create_order',
  'create_payment_link',
  'verify_payment',
  'get_order',
  'list_orders',
  'record_follow_up_offer',
  'mark_drop_off',
  'list_customers'
];
const eq = (a, b) => [...a].sort().join() === [...b].sort().join();

let failed = false;
const report = (ok, label, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
};

// 1. wallet: biller account from the seed
const w = await fetch(`${base}/v1/wallet`, { headers: auth }).then((r) => r.json());
report(
  w?.data?.account_number === '0000000000',
  'wallet biller account',
  `${w?.data?.account_number} (${w?.data?.bank}) balance=${w?.data?.balance}`
);

// 2. ops bucket
const ops = await toolNames('/mcp');
report(!ops.error && eq(ops.names || [], OPS), 'POST /mcp = ops bucket only', ops.error || `${ops.names?.length} tools`);

// 3. design bucket
const des = await toolNames('/mcp/design');
report(
  !des.error && eq(des.names || [], DESIGN),
  'POST /mcp/design = design bucket only',
  des.error || `${des.names?.length} tools`
);

// 4. sales bucket
const sales = await toolNames('/mcp/sales');
report(
  !sales.error && eq(sales.names || [], SALES),
  'POST /mcp/sales = sales bucket only',
  sales.error || `${sales.names?.length} tools`
);

// 5. no cross-contamination
report(
  !(ops.names || []).includes('generate_design') &&
    !(des.names || []).includes('buy_airtime') &&
    !(sales.names || []).includes('check_wallet') &&
    !(ops.names || []).includes('list_products'),
  'no cross-contamination'
);

// 6. auth rejects without a token
const un = await fetch(`${base}/mcp/design`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
});
report(un.status === 401, 'missing bearer is 401', `HTTP ${un.status}`);

console.log(`\n${base} — ${failed ? 'FAILURES above' : 'ALL GREEN'}`);
process.exit(failed ? 1 : 0);
