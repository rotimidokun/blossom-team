// Repro: exact same POST fetch the server makes, with full cause logging.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && m[2]) process.env[m[1]] = m[2];
  }
} catch {}

const key = process.env.GEMINI_API_KEY || '';
console.log('key prefix:', key.slice(0, 4), 'len:', key.length);

const model = process.argv[2] || 'gemini-2.5-flash-image';
const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
console.log('POST', url);

const started = Date.now();
try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: 'a simple red circle on white background' }] }] })
  });
  console.log('HTTP', res.status, res.statusText, `(${Date.now() - started}ms)`);
  const text = await res.text();
  console.log(text.slice(0, 600));
} catch (err) {
  console.log(`FAILED after ${Date.now() - started}ms:`, err.message);
  let cause = err.cause;
  let depth = 0;
  while (cause && depth < 5) {
    console.log(`  cause[${depth}]:`, cause.code || cause.message || String(cause));
    if (cause.code === 'ECONNRESET' || cause.code === 'ENOTFOUND' || cause.code === 'ETIMEDOUT') {
      console.log('  cause detail:', JSON.stringify({ address: cause.address, port: cause.port, syscall: cause.syscall }));
    }
    cause = cause.cause;
    depth++;
  }
}
