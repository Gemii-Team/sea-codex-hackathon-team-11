// Probe from the same Docker bridge as the tunnel. None of these requests can start a paid call.
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
const callsUrl = `${POC}/api/voice/calls`;

// Compare an authenticated page marker as well as status; an obsolete widget page must not pass.
const checks = [
  { name: 'main-origin', url: `${MAIN}/`, hash: true },
  { name: 'poc-anonymous', url: `${POC}/`, status: 401, challenge: true },
  { name: 'poc-wrong-password', url: `${POC}/`, headers: wrong, status: 401 },
  { name: 'poc-authenticated', url: `${POC}/`, headers: basic(password), status: 200, marker: 'OpenAI' },
  { name: 'call-anonymous', url: callsUrl, method: 'POST', headers: { origin: ORIGIN }, status: 401 },
  { name: 'call-wrong-password', url: callsUrl, method: 'POST', headers: { origin: ORIGIN, ...wrong }, status: 401 },
  { name: 'call-wrong-origin', url: callsUrl, method: 'POST', headers: { origin: 'https://untrusted.invalid', ...basic(password) }, status: 403 },
];

let failed = false;
for (const c of checks) {
  try {
    const res = await fetch(c.url, { method: c.method ?? 'GET', headers: c.headers, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const body = Buffer.from(await res.arrayBuffer());
    const ok =
      (c.status ? res.status === c.status : res.status >= 200 && res.status < 300) &&
      (!c.challenge || /^basic /i.test(res.headers.get('www-authenticate') ?? '')) &&
      (!c.marker || body.includes(c.marker));
    failed ||= !ok;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name} status=${res.status}${c.hash ? ` sha256=${createHash('sha256').update(body).digest('hex')}` : ''}`);
  } catch (err) {
    failed = true;
    console.log(`FAIL ${c.name} ${err.cause?.code ?? err.message}`);
  }
}
process.exitCode = failed ? 1 : 0;
