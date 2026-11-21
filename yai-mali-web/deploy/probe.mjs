// Probe from the same Docker bridge as the tunnel. The dev app is public, so none of these
// requests may reach OpenAI: the two POST routes are called only with a foreign Origin (rejected
// before any body is read) or with a same-origin body that fails validation.
import { createHash } from 'node:crypto';

const MAIN = 'http://app:8080';
const DEV = 'http://yai-mali-dev:8080';
const ORIGIN = 'https://sea-hackathon-dev.voidbox.io';
const FOREIGN = 'https://untrusted.invalid';
const json = { 'content-type': 'application/json' };
const chatUrl = `${DEV}/api/chat`;
const callsUrl = `${DEV}/api/voice/calls`;

// Compare a page marker as well as status; an obsolete page must not pass.
const checks = [
  { name: 'main-origin', url: `${MAIN}/`, hash: true },
  { name: 'dev-page', url: `${DEV}/`, status: 200, marker: 'Yai Mali' },
  { name: 'dev-health', url: `${DEV}/healthz`, status: 200 },
  { name: 'chat-foreign-origin', url: chatUrl, method: 'POST', headers: { ...json, origin: FOREIGN }, body: '{}', status: 403 },
  { name: 'chat-invalid-body', url: chatUrl, method: 'POST', headers: { ...json, origin: ORIGIN }, body: '{}', status: 400 },
  { name: 'call-foreign-origin', url: callsUrl, method: 'POST', headers: { origin: FOREIGN }, status: 403 },
];

let failed = false;
for (const c of checks) {
  try {
    const res = await fetch(c.url, { method: c.method ?? 'GET', headers: c.headers, body: c.body, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const body = Buffer.from(await res.arrayBuffer());
    const ok =
      (c.status ? res.status === c.status : res.status >= 200 && res.status < 300) &&
      (!c.marker || body.includes(c.marker));
    failed ||= !ok;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name} status=${res.status}${c.hash ? ` sha256=${createHash('sha256').update(body).digest('hex')}` : ''}`);
  } catch (err) {
    failed = true;
    console.log(`FAIL ${c.name} ${err.cause?.code ?? err.message}`);
  }
}
process.exitCode = failed ? 1 : 0;
