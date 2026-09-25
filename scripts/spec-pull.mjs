import { writeFileSync } from 'node:fs';

const url = process.env.ASSETPAY_SPEC_URL ?? 'https://api.assetpay.gg/docs/public/openapi.json';
const res = await fetch(url, { headers: { accept: 'application/json' } });
if (!res.ok) {
  console.error(`GET ${url} -> ${res.status}`);
  process.exit(1);
}
const spec = await res.json();
writeFileSync(new URL('../openapi.json', import.meta.url), `${JSON.stringify(spec, null, 2)}\n`);
const count = Object.values(spec.paths ?? {}).reduce((n, ops) => n + Object.keys(ops).length, 0);
console.log(`openapi.json: ${count} operations from ${url}`);
