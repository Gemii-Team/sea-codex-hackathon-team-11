// Voice-call origin: serves the static page and brokers one OpenAI Realtime WebRTC call.
//
//   GET  /healthz                      readiness, unauthenticated, no secrets
//   GET  /, /index.html, /styles.css, /call.js   static page (team Basic auth)
//   POST /api/voice/calls              body application/sdp (browser offer)
//                                      201 application/sdp (answer) + X-Voice-Call-ID
//   POST /api/voice/calls/{id}/hangup  no body; 204 (idempotent)
//
// Both POSTs need team Basic auth and the exact same origin. No dependencies. The API key
// lives only inside the provider (./realtime.mjs); the browser can neither see it nor choose
// session settings. SDP and credentials are never logged. No redirects, no CORS headers.
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ConfigError, loadConfig } from './config.mjs';
import { createVoiceProvider, isValidCallId } from './realtime.mjs';

const USERNAME = 'team';
const REALM = 'Team 11 Connect call';
const START_PATH = '/api/voice/calls';
const HANGUP_PATH = /^\/api\/voice\/calls\/([^/]+)\/hangup$/;
export const MAX_BODY_BYTES = 32 * 1024;
// Error codes the browser may see; anything else collapses to upstream_error.
const SAFE_ERRORS = new Set([
  'invalid_offer', 'invalid_call_id', 'voice_closed', 'busy', 'quota_exhausted', 'shutting_down',
  'not_configured', 'state_unavailable', 'unknown_call', 'upstream_unavailable', 'upstream_error',
  'upstream_rejected', 'upstream_no_call_id', 'upstream_bad_answer', 'hangup_failed',
]);
const SAFE_STATUS = new Set([400, 403, 404, 429, 502, 503]);

const FRONTEND_DIR = new URL('../frontend/', import.meta.url);
const ASSET_FILES = [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/index.html', 'index.html', 'text/html; charset=utf-8'],
  ['/call.js', 'call.js', 'text/javascript; charset=utf-8'],
  ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
];

// The page needs microphone access and an outbound WebRTC connection only; fetches stay same-origin.
const COMMON_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; style-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'microphone=(self)',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

const UNAUTHORIZED_HTML =
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign in required</title>' +
  '<p>Sign in as <strong>team</strong> with the demo password, then reload this page.</p></html>';

const sha256 = (text) => createHash('sha256').update(text).digest();
const safeEqual = (a, b) => timingSafeEqual(sha256(a), sha256(b));

/**
 * True for a browser offer we are willing to forward: printable ASCII lines of `x=value`,
 * starting with v=0, exactly one audio section and at most one SCTP data-channel section
 * (the Realtime events channel). Video and every other media type are refused.
 */
export function isAudioOnlyOffer(sdp) {
  if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > MAX_BODY_BYTES) return false;
  if (!/^[\x20-\x7e\r\n]+$/.test(sdp)) return false;
  const lines = sdp.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines[0] !== 'v=0') return false;
  if (!lines.every((line) => /^[a-z]=/.test(line))) return false;
  const media = lines.filter((line) => line.startsWith('m='));
  const audio = media.filter((line) => /^m=audio [0-9]+ [A-Z/]+ /.test(line));
  const events = media.filter((line) => /^m=application [0-9]+ (?:UDP\/DTLS\/SCTP|UDP\/TLS\/SCTP|DTLS\/SCTP) webrtc-datachannel$/.test(line));
  return audio.length === 1 && events.length <= 1 && audio.length + events.length === media.length;
}

const defaultLog = (entry) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);

function routeLabel(pathname) {
  if (pathname === '/healthz') return 'health';
  if (pathname === START_PATH) return 'start';
  if (HANGUP_PATH.test(pathname)) return 'hangup';
  return ASSET_FILES.some(([path]) => path === pathname) ? 'static' : 'other';
}

class BodyTooLarge extends Error {}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > limit) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLarge());
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('aborted')));
  });
}

/**
 * Builds (does not start) the HTTP server. `provider` is {start(sdp), hangup(id), shutdown()}
 * from createVoiceProvider; tests inject a fake. The returned server has `drain()`, which
 * refuses new calls, waits for calls being created, then asks the provider to close everything.
 */
export function createServer(config, { provider, log = defaultLog } = {}) {
  if (!provider) throw new TypeError('createServer requires a provider');
  const assets = new Map(
    ASSET_FILES.map(([path, file, type]) => [path, { type, body: readFileSync(new URL(file, FRONTEND_DIR)) }]),
  );
  const creating = new Set();
  let draining = false;

  function send(req, res, status, type, body, extra = {}) {
    const payload = Buffer.from(body);
    res.writeHead(status, { ...COMMON_HEADERS, 'Content-Type': type, 'Content-Length': payload.length, ...extra });
    res.end(req.method === 'HEAD' ? undefined : payload);
  }

  const sendJson = (req, res, status, body, extra) =>
    send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(body), extra);

  function isAuthorized(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || header.length > 512) return false;
    const match = /^Basic +([A-Za-z0-9+/]+={0,2})$/i.exec(header);
    if (!match) return false;
    const credentials = Buffer.from(match[1], 'base64').toString('utf8');
    const split = credentials.indexOf(':');
    if (split < 0) return false;
    // Both comparisons always run, so timing does not reveal which part was wrong.
    const userOk = safeEqual(credentials.slice(0, split), USERNAME);
    const passwordOk = safeEqual(credentials.slice(split + 1), config.demoPassword);
    return userOk && passwordOk;
  }

  function unauthorized(req, res) {
    const challenge = { 'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"` };
    if (String(req.headers.accept ?? '').includes('text/html')) {
      return send(req, res, 401, 'text/html; charset=utf-8', UNAUTHORIZED_HTML, challenge);
    }
    return sendJson(req, res, 401, { error: 'unauthorized' }, challenge);
  }

  const methodNotAllowed = (req, res, allow) =>
    sendJson(req, res, 405, { error: 'method_not_allowed' }, { Allow: allow });

  // A browser always sends Origin on a same-origin POST. Missing, `null`, or any other value
  // (different scheme, host, port, or a look-alike prefix) is refused. Sec-Fetch-Site, when
  // present, must say same-origin.
  function originAllowed(req) {
    if (req.headers.origin !== config.publicOrigin) return false;
    const site = req.headers['sec-fetch-site'];
    return site === undefined || site === 'same-origin';
  }

  function providerFailure(req, res, error, what) {
    // Only an allowlisted code and status are mirrored, never the provider's message or body.
    const code = typeof error?.code === 'string' && SAFE_ERRORS.has(error.code) ? error.code : 'upstream_error';
    const status = Number.isInteger(error?.status) && SAFE_STATUS.has(error.status) ? error.status : 502;
    log({ level: 'error', msg: `${what} failed`, status, code, error: error?.name ?? 'Error' });
    return sendJson(req, res, status, { error: code });
  }

  async function hangupQuietly(id) {
    try {
      await provider.hangup(id);
    } catch (error) {
      log({ level: 'error', msg: 'cleanup hangup failed', error: error?.name ?? 'Error' });
    }
  }

  async function startRoute(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(req, res, 'POST');
    if (!originAllowed(req)) return sendJson(req, res, 403, { error: 'origin_not_allowed' });
    const type = String(req.headers['content-type'] ?? '').trim().toLowerCase();
    if (type !== 'application/sdp') return sendJson(req, res, 415, { error: 'unsupported_media_type' });
    let sdp;
    try {
      sdp = (await readBody(req, MAX_BODY_BYTES)).toString('latin1');
    } catch (error) {
      if (error instanceof BodyTooLarge) return sendJson(req, res, 413, { error: 'body_too_large' }, { Connection: 'close' });
      return res.destroy();
    }
    if (!isAudioOnlyOffer(sdp)) return sendJson(req, res, 400, { error: 'invalid_offer' });
    if (draining) return sendJson(req, res, 503, { error: 'unavailable' });

    // `delivered` flips only when the whole response was flushed. If the browser leaves first
    // (close without finish), the call that was just created is hung up at once.
    let result;
    let delivered = false;
    res.on('finish', () => {
      delivered = true;
    });
    res.on('close', () => {
      if (!delivered && result) void hangupQuietly(result.id);
    });
    const attempt = (async () => {
      try {
        const answer = await provider.start(sdp);
        const id = answer?.id;
        const answerSdp = answer?.sdp;
        if (!isValidCallId(id) || typeof answerSdp !== 'string' || answerSdp === '') {
          if (isValidCallId(id)) await hangupQuietly(id);
          throw new Error('provider returned an unusable answer');
        }
        result = { id, sdp: answerSdp };
      } catch (error) {
        return { error };
      }
      return {};
    })();
    creating.add(attempt);
    let outcome;
    try {
      outcome = await attempt;
    } finally {
      creating.delete(attempt);
    }
    if (outcome.error) return providerFailure(req, res, outcome.error, 'call start');
    if (res.destroyed) {
      // Browser already gone: the close handler could not see `result` yet if it fired earlier.
      await hangupQuietly(result.id);
      return undefined;
    }
    if (draining) return sendJson(req, res, 503, { error: 'shutting_down' });
    log({ level: 'info', msg: 'call started' });
    return send(req, res, 201, 'application/sdp', result.sdp, { 'X-Voice-Call-ID': result.id });
  }

  async function hangupRoute(req, res, id) {
    if (req.method !== 'POST') return methodNotAllowed(req, res, 'POST');
    if (!originAllowed(req)) return sendJson(req, res, 403, { error: 'origin_not_allowed' });
    const length = req.headers['content-length'];
    if (req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0')) {
      return sendJson(req, res, 413, { error: 'body_not_allowed' }, { Connection: 'close' });
    }
    if (!isValidCallId(id)) return sendJson(req, res, 400, { error: 'invalid_call_id' });
    try {
      await provider.hangup(id);
    } catch (error) {
      // A bounded call may already have ended through the server timer.
      if (error?.code !== 'unknown_call') return providerFailure(req, res, error, 'hangup');
    }
    log({ level: 'info', msg: 'call hung up' });
    res.writeHead(204, COMMON_HEADERS);
    return res.end();
  }

  function dispatch(req, res, pathname) {
    if (pathname === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(req, res, 'GET, HEAD');
      return sendJson(req, res, 200, { status: 'ok' });
    }
    if (!isAuthorized(req)) return unauthorized(req, res);
    if (pathname === START_PATH) return startRoute(req, res);
    const hangup = HANGUP_PATH.exec(pathname);
    if (hangup) return hangupRoute(req, res, hangup[1]);
    const asset = assets.get(pathname);
    if (asset) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(req, res, 'GET, HEAD');
      return send(req, res, 200, asset.type, asset.body);
    }
    return sendJson(req, res, 404, { error: 'not_found' });
  }

  async function handle(req, res) {
    const started = process.hrtime.bigint();
    const target = req.url ?? '';
    // Only origin-form targets ("/path"); no pathname decoding, so nothing can traverse.
    const bad = target[0] !== '/' || target[1] === '/';
    const query = target.indexOf('?');
    const pathname = bad ? '' : query === -1 ? target : target.slice(0, query);
    const route = bad ? 'invalid' : routeLabel(pathname);
    res.on('close', () =>
      log({
        level: 'info',
        msg: 'request',
        method: req.method,
        route,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
      }),
    );
    try {
      if (bad) return sendJson(req, res, 400, { error: 'bad_request' }, { Connection: 'close' });
      return await dispatch(req, res, pathname);
    } catch (error) {
      log({ level: 'error', msg: 'request failed', error: error?.name ?? 'Error' });
      if (!res.headersSent) return sendJson(req, res, 500, { error: 'internal_error' }, { Connection: 'close' });
      res.destroy();
    }
  }

  const server = http.createServer({ maxHeaderSize: 8192 }, handle);
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000; // the upstream answer can take a few seconds
  server.keepAliveTimeout = 5_000;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  server.drain = async () => {
    draining = true;
    await Promise.allSettled([...creating]);
    const outcome = await provider.shutdown();
    const hungUp = outcome?.hungUp === true;
    const uncertain = outcome?.uncertain === true;
    return { hungUp, uncertain, clean: hungUp && !uncertain };
  };
  return server;
}

export async function main(env = process.env) {
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error('connect-web-call: refusing to start. Fix these environment variables:');
    for (const { name, message } of error.problems) console.error(`  ${name}: ${message}`);
    process.exitCode = 1;
    return undefined;
  }
  const provider = createVoiceProvider({
    apiKey: config.apiKey, cutoffAt: config.cutoffAt, stateDir: config.stateDir,
    log: (msg) => defaultLog({ level: 'warn', msg }),
  });
  const server = createServer(config, { provider });
  server.listen(config.port, config.host, () => {
    defaultLog({ level: 'info', msg: 'listening', port: config.port, origin: config.publicOrigin, cutoffAt: config.cutoffAt });
  });
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    defaultLog({ level: 'info', msg: 'shutting down', signal });
    const hardStop = setTimeout(() => process.exit(1), 15_000);
    hardStop.unref();
    server.close();
    server.closeIdleConnections();
    let code = 0;
    try {
      const outcome = await server.drain();
      // An unconfirmed hangup of a known call, or an id-less reservation, is not a clean exit.
      if (!outcome.clean) {
        defaultLog({ level: 'error', msg: 'shutdown unconfirmed', hungUp: outcome.hungUp, uncertain: outcome.uncertain });
        code = 1;
      }
    } catch (error) {
      defaultLog({ level: 'error', msg: 'shutdown failed', error: error?.name ?? 'Error' });
      code = 1;
    }
    server.closeAllConnections();
    process.exit(code);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
