// List the Gemini models this key can use, flagging image-capable ones.
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

const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
  headers: { 'x-goog-api-key': key }
});
console.log('HTTP', res.status);
const json = await res.json().catch(() => ({}));
if (!res.ok) {
  console.log(JSON.stringify(json, null, 2).slice(0, 800));
  process.exit(0);
}

const models = json.models || [];
console.log(`\n${models.length} models available:\n`);
for (const m of models) {
  const methods = m.supportedGenerationMethods || [];
  const imageish = /image|imagen/i.test(m.name) || methods.includes('generateContent');
  if (imageish) {
    console.log(`  ${m.name}  [${methods.join(', ')}]${m.displayName ? '  — ' + m.displayName : ''}`);
  }
}
