// One-off diagnostic: why does Node's fetch fail when curl works?
// Usage: node scripts/diag-gemini.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Load .env manually (no dotenv dependency)
try {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && m[2]) process.env[m[1]] = m[2];
  }
} catch {}

const key = process.env.GEMINI_API_KEY || '';
console.log('key prefix:', key.slice(0, 4), 'length:', key.length);
console.log('proxy env:', {
  HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || '(none)',
  HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || '(none)',
  NO_PROXY: process.env.NO_PROXY || process.env.no_proxy || '(none)'
});

const url = 'https://generativelanguage.googleapis.com/v1beta/models';
console.log('\n[1] plain GET with x-goog-api-key header...');
try {
  const res = await fetch(url, { headers: { 'x-goog-api-key': key } });
  console.log('  -> HTTP', res.status, res.statusText);
  const text = (await res.text()).slice(0, 300);
  console.log('  ->', text);
} catch (err) {
  console.log('  -> FAILED:', err.message);
  if (err.cause) console.log('  -> cause:', err.cause.code || err.cause.message || err.cause);
}

console.log('\n[2] plain GET, no headers (connectivity only)...');
try {
  const res = await fetch(url);
  console.log('  -> HTTP', res.status, res.statusText);
} catch (err) {
  console.log('  -> FAILED:', err.message);
  if (err.cause) console.log('  -> cause:', err.cause.code || err.cause.message || err.cause);
}
