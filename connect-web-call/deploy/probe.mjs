// Origin probe, piped by remote-deploy.sh into a throwaway container of the PoC image on the
// shared Docker network: it reaches app:8080 and connect-web-call:8080 by the same names and over
// the same bridge as cloudflared. DEMO_PASSWORD arrives in the environment only and is never
// printed. One PASS/FAIL line per check (status codes and a content hash only); exit 1 on any FAIL.
import { createHash } from 'node:crypto';

const MAIN = 'http://app:8080';
const POC = 'http://connect-web-call:8080';
const ORIGIN = 'https://call-sea-hackathon.voidbox.io';
const password = process.env.DEMO_PASSWORD ?? '';
if (!password) {
  console.log('FAIL DEMO_PASSWORD is not set');
  process.exit(1);
}
const basic = (pw) => ({ authorization: `Basic ${Buffer.from(`team:${pw}`).toString('base64')}` });
const wrong = basic(`${password}-wrong`);
const tokenUrl = `${POC}/api/widget-token`;

// status: exact status expected (default any 2xx); challenge: needs a Basic challenge;
// noToken: the body must not carry a token.
const checks = [
  { name: 'main-origin', url: `${MAIN}/`, hash: true },
  { name: 'poc-anonymous', url: `${POC}/`, status: 401, challenge: true },
  { name: 'poc-wrong-password', url: `${POC}/`, headers: wrong, status: 401 },
  { name: 'poc-authenticated', url: `${POC}/`, headers: basic(password), status: 200 },
  { name: 'token-anonymous', url: tokenUrl, method: 'POST', headers: { origin: ORIGIN }, status: 401, noToken: true },
  { name: 'token-wrong-password', url: tokenUrl, method: 'POST', headers: { origin: ORIGIN, ...wrong }, status: 401, noToken: true },
];

let failed = false;
for (const c of checks) {
  try {
    const res = await fetch(c.url, { method: c.method ?? 'GET', headers: c.headers, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const body = Buffer.from(await res.arrayBuffer());
    const ok =
      (c.status ? res.status === c.status : res.status >= 200 && res.status < 300) &&
      (!c.challenge || /^basic /i.test(res.headers.get('www-authenticate') ?? '')) &&
      (!c.noToken || !body.includes('"data"'));
    failed ||= !ok;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name} status=${res.status}${c.hash ? ` sha256=${createHash('sha256').update(body).digest('hex')}` : ''}`);
  } catch (err) {
    failed = true;
    console.log(`FAIL ${c.name} ${err.cause?.code ?? err.message}`);
  }
}
process.exitCode = failed ? 1 : 0;
