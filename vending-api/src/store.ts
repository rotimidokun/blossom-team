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

/** Load the database, seeding it on first run. State outlives any single conversation. */
export function loadDb(): Db {
  if (existsSync(DB_PATH)) {
    try {
      return JSON.parse(readFileSync(DB_PATH, 'utf8')) as Db;
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
