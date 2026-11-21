// connect-web-call origin: serves the static page and issues Amazon Connect widget JWTs.
//
//   GET  /healthz           readiness, unauthenticated, no secrets
//   GET  /, /call.js, ...   static page (team Basic auth)
//   GET  /api/widget-config public widget fields only (team Basic auth)
//   POST /api/widget-token  200 {"data":"<jwt>"} (team Basic auth + exact same-origin + rate limit)
//
// No dependencies. Secrets stay in memory: they are never written to a response, a log line or
// an error message. This process never redirects, and sets no CORS headers, so a token cannot be
// obtained cross-origin.
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ConfigError, loadConfig, publicWidgetConfig } from './config.mjs';
import { signWidgetToken } from './jwt.mjs';

const USERNAME = 'team';
export const TOKEN_LIMIT = 6; // tokens per window, across the whole process
export const TOKEN_WINDOW_MS = 60_000;
const REALM = 'Team 11 Connect call';
const TOKEN_PATH = '/api/widget-token';
const CONFIG_PATH = '/api/widget-config';

const FRONTEND_DIR = new URL('../frontend/', import.meta.url);
const ASSET_FILES = [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/index.html', 'index.html', 'text/html; charset=utf-8'],
  ['/call.js', 'call.js', 'text/javascript; charset=utf-8'],
  ['/widget.mjs', 'widget.mjs', 'text/javascript; charset=utf-8'],
  ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
];

// frame-ancestors/base-uri/form-action/object-src only. script-src and connect-src are
// deliberately not pinned: the AWS widget iframe inherits this page's policy (see the `nonce`
// snippet field) and the live widget's needs cannot be verified offline. The executable URL is
// pinned in code instead (parseWidgetScriptUrl). Referrer stays origin-only so the widget can
// still see which site embeds it for its domain allowlist.
const COMMON_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

const UNAUTHORIZED_HTML =
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign in required</title>' +
  '<p>Sign in as <strong>team</strong> with the demo password, then reload this page.</p></html>';

const sha256 = (text) => createHash('sha256').update(text).digest();
const safeEqual = (a, b) => timingSafeEqual(sha256(a), sha256(b));

/** At most `limit` hits per sliding `windowMs`. */
class SlidingWindowLimiter {
  #hits = [];

  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  take(nowMs) {
    while (this.#hits.length > 0 && this.#hits[0] <= nowMs - this.windowMs) this.#hits.shift();
    if (this.#hits.length >= this.limit) {
      const retryAfterMs = this.#hits[0] + this.windowMs - nowMs;
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    this.#hits.push(nowMs);
    return { ok: true };
  }
}

function loadAssets() {
  return new Map(
    ASSET_FILES.map(([path, file, type]) => [path, { type, body: readFileSync(new URL(file, FRONTEND_DIR)) }]),
  );
}

const defaultLog = (entry) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);

function routeLabel(pathname) {
  if (pathname === '/healthz') return 'health';
  if (pathname === TOKEN_PATH) return 'token';
  if (pathname === CONFIG_PATH) return 'config';
  return pathname === '/' || ASSET_FILES.some(([path]) => path === pathname) ? 'static' : 'other';
}

/** Builds (does not start) the HTTP server. `now` and `log` are injectable for tests. */
export function createServer(config, { now = Date.now, log = defaultLog } = {}) {
  const assets = loadAssets();
  const limiter = new SlidingWindowLimiter(TOKEN_LIMIT, TOKEN_WINDOW_MS);
  const widgetConfigJson = JSON.stringify(publicWidgetConfig(config));

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

  const methodNotAllowed = (req, res, allow) => sendJson(req, res, 405, { error: 'method_not_allowed' }, { Allow: allow });

  // The browser always sends Origin on a same-origin POST. Missing, `null`, or any other value
  // (different scheme, host, port, or a look-alike prefix) is refused.
  function originAllowed(req) {
    if (req.headers.origin !== config.publicOrigin) return false;
    const site = req.headers['sec-fetch-site'];
    return site === undefined || site === 'same-origin';
  }

  const hasBody = (req) => {
    const length = req.headers['content-length'];
    return req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
  };

  function tokenRoute(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(req, res, 'POST');
    if (!originAllowed(req)) return sendJson(req, res, 403, { error: 'origin_not_allowed' });
    if (hasBody(req)) return sendJson(req, res, 413, { error: 'body_not_allowed' });
    // Only requests that would otherwise receive a token count against the limit, so failed
    // sign-ins cannot be used to lock the team out.
    const nowMs = now();
    const verdict = limiter.take(nowMs);
    if (!verdict.ok) {
      return sendJson(req, res, 429, { error: 'rate_limited' }, { 'Retry-After': String(verdict.retryAfterSeconds) });
    }
    const token = signWidgetToken({
      widgetId: config.widget.id,
      signingKey: config.signingKey,
      nowSeconds: Math.floor(nowMs / 1000),
    });
    log({ level: 'info', msg: 'widget token issued' });
    return sendJson(req, res, 200, { data: token });
  }

  function dispatch(req, res, pathname) {
    if (pathname === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(req, res, 'GET, HEAD');
      return sendJson(req, res, 200, { status: 'ok' });
    }
    if (!isAuthorized(req)) return unauthorized(req, res);
    if (pathname === TOKEN_PATH) return tokenRoute(req, res);
    const isGetOrHead = req.method === 'GET' || req.method === 'HEAD';
    if (pathname === CONFIG_PATH) {
      if (!isGetOrHead) return methodNotAllowed(req, res, 'GET, HEAD');
      return send(req, res, 200, 'application/json; charset=utf-8', widgetConfigJson);
    }
    const asset = assets.get(pathname);
    if (asset) {
      if (!isGetOrHead) return methodNotAllowed(req, res, 'GET, HEAD');
      return send(req, res, 200, asset.type, asset.body);
    }
    return sendJson(req, res, 404, { error: 'not_found' });
  }

  function handle(req, res) {
    const started = process.hrtime.bigint();
    const target = req.url ?? '';
    // Only origin-form targets ("/path"); no pathname decoding, so nothing can traverse.
    const bad = target[0] !== '/';
    const query = target.indexOf('?');
    const pathname = bad ? '' : query === -1 ? target : target.slice(0, query);
    const route = bad ? 'invalid' : routeLabel(pathname);
    res.on('finish', () =>
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
      return dispatch(req, res, pathname);
    } catch (error) {
      log({ level: 'error', msg: 'request failed', error: error?.name ?? 'Error' });
      if (!res.headersSent) return sendJson(req, res, 500, { error: 'internal_error' }, { Connection: 'close' });
      res.destroy();
    }
  }

  const server = http.createServer({ maxHeaderSize: 8192 }, handle);
  server.headersTimeout = 15_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  return server;
}

export function main(env = process.env) {
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
  const server = createServer(config);
  server.listen(config.port, config.host, () => {
    defaultLog({ level: 'info', msg: 'listening', port: config.port, origin: config.publicOrigin });
  });
  const shutdown = (signal) => {
    defaultLog({ level: 'info', msg: 'shutting down', signal });
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 2_000).unref();
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
