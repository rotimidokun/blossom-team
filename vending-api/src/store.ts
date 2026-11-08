import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSeed } from './seed.js';
import type { Db } from './types.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DB_PATH = process.env.DB_PATH || join(DATA_DIR, 'db.json');

function persist(db: Db): void {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

/**
 * Merge a loaded (possibly older) file over a fresh seed so every collection the
 * current code expects exists. 2026-11-08: the live db.json predated the sales
 * feature and had no `orders`/`customers` keys — `db.orders.find(...)` threw in
 * an async handler, no response was ever written, and the MCP tool's loopback
 * fetch died on undici's 300s headers timeout ("Local vending API unreachable:
 * fetch failed"). An old file must never crash a new route.
 */
function normalize(loaded: Partial<Db>): Db {
  const seed = buildSeed();
  const db: Db = { ...seed, ...loaded };
  // Collections: keep the file's data when present, otherwise the seed's shape.
  db.wallet = { ...seed.wallet, ...(loaded.wallet ?? {}) };
  db.meters = loaded.meters ?? seed.meters;
  db.phones = loaded.phones ?? seed.phones;
  db.purchases = loaded.purchases ?? seed.purchases;
  db.incoming = loaded.incoming ?? seed.incoming;
  db.idempotency = loaded.idempotency ?? seed.idempotency;
  db.designs = loaded.designs ?? seed.designs;
  db.orders = loaded.orders ?? seed.orders;
  db.customers = loaded.customers ?? seed.customers;
  db.generation_count = loaded.generation_count ?? seed.generation_count;
  return db;
}

/** Load the database, seeding it on first run. State outlives any single conversation. */
export function loadDb(): Db {
  if (existsSync(DB_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(DB_PATH, 'utf8')) as Partial<Db>;
      const db = normalize(parsed);
      // Backfill a stale file once so the fix is visible on disk too.
      if (!('orders' in parsed) || !('customers' in parsed)) persist(db);
      return db;
    } catch {
      // Corrupt file: fall through to a fresh seed rather than crash.
    }
  }
  const db = buildSeed();
  persist(db);
  return db;
}

export function saveDb(db: Db): void {
  persist(db);
}

export function resetDb(): Db {
  const db = buildSeed();
  persist(db);
  return db;
}
