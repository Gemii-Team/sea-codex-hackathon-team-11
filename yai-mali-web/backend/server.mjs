// Yai Mali origin: serves the static page, relays typed chat to OpenAI, and brokers one OpenAI
// Realtime WebRTC call.
//
//   GET  /healthz                      readiness, no secrets
//   GET  /, /index.html, and every other regular file under frontend/ (found at startup)
//   POST /api/chat                     JSON {scenario, messages:[{role,text}]} -> {reply}
//   POST /api/voice/calls              body application/sdp (browser offer), optional header
//                                      X-Yai-Scenario; 201 application/sdp (answer) + X-Voice-Call-ID
//   POST /api/voice/calls/{id}/hangup  no body; 204 (idempotent)
//
// Every POST needs the exact same origin. The app is public: there is no login. No dependencies.
// The API key lives only inside the providers (./chat.mjs, ./realtime.mjs); the browser can
// neither see it nor choose the model or the persona. SDP, chat text and the key are never
// logged. No redirects, no CORS headers.
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChatProvider } from './chat.mjs';
import { ConfigError, loadConfig } from './config.mjs';
import { DEFAULT_SCENARIO, isScenario } from './persona.mjs';
import { createVoiceProvider, isValidCallId } from './realtime.mjs';

const START_PATH = '/api/voice/calls';
const CHAT_PATH = '/api/chat';
const HANGUP_PATH = /^\/api\/voice\/calls\/([^/]+)\/hangup$/;
export const MAX_BODY_BYTES = 32 * 1024; // SDP offer
export const MAX_CHAT_BODY_BYTES = 64 * 1024;
export const MAX_CHAT_MESSAGES = 30;
export const MAX_CHAT_TEXT = 2000;
// Error codes the browser may see; anything else collapses to upstream_error.
const SAFE_ERRORS = new Set([
  'invalid_offer', 'invalid_call_id', 'voice_closed', 'busy', 'quota_exhausted', 'shutting_down',
  'not_configured', 'state_unavailable', 'unknown_call', 'upstream_unavailable', 'upstream_error',
  'upstream_rejected', 'upstream_no_call_id', 'upstream_bad_answer', 'hangup_failed',
]);
const SAFE_STATUS = new Set([400, 403, 404, 429, 502, 503]);
// The only failures the chat route reports; anything else collapses to upstream_failed.
const CHAT_ERROR_STATUS = new Map([
  ['not_configured', 503], ['state_unavailable', 503], ['rate_limited', 429], ['quota_exhausted', 429], ['upstream_failed', 502],
]);

const FRONTEND_DIR = new URL('../frontend/', import.meta.url);
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
]);
// A served path segment starts with a letter or digit: no dotfiles, no "..", no odd characters.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Reads every regular file under `dir` with a known content type into memory, keyed by URL
 * path ("/assets/logo.png"). Symlinks, dotfiles and unknown extensions are skipped, and "/" is
 * index.html. Throws when index.html is missing.
 */
export function loadAssets(dir) {
  const assets = new Map();
  const walk = (absDir, prefix) => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (!SEGMENT.test(entry.name)) continue;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) walk(abs, `${prefix}${entry.name}/`);
      else if (entry.isFile()) {
        const type = CONTENT_TYPES.get(path.extname(entry.name).toLowerCase());
        if (type) assets.set(`${prefix}${entry.name}`, { type, body: readFileSync(abs) });
      }
    }
  };
  walk(typeof dir === 'string' ? dir : fileURLToPath(dir), '/');
  const index = assets.get('/index.html');
  if (!index) throw new Error('frontend directory has no index.html');
  assets.set('/', index);
  return assets;
}

// The page needs microphone access and an outbound WebRTC connection only; fetches stay same-origin.
const COMMON_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; font-src 'self'; style-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'microphone=(self)',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

/**
 * Validates a chat request body. Returns {scenario, messages} with each text trimmed, or null.
 */
export function parseChatRequest(buffer) {
  let body;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const { scenario, messages } = body;
  if (!isScenario(scenario)) return null;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_CHAT_MESSAGES) return null;
  const clean = [];
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return null;
    if (message.role !== 'user' && message.role !== 'assistant') return null;
    if (typeof message.text !== 'string') return null;
    const text = message.text.trim();
    if (text.length < 1 || text.length > MAX_CHAT_TEXT) return null;
    clean.push({ role: message.role, text });
  }
  if (clean[clean.length - 1].role !== 'user') return null;
  return { scenario, messages: clean };
}

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
 * Builds (does not start) the HTTP server. `provider` is {start(sdp, {scenario}), hangup(id),
 * shutdown()} from createVoiceProvider and `chat` is {reply(scenario, messages)} from
 * createChatProvider; tests inject fakes. The returned server has `drain()`, which refuses new
 * calls and chat, waits for calls being created, then asks the provider to close everything.
 * `frontendDir` (path or file URL) holds the static files; it is read once, here.
 */
export function createServer(config, { provider, chat, log = defaultLog, frontendDir = FRONTEND_DIR } = {}) {
  if (!provider) throw new TypeError('createServer requires a provider');
  if (!chat) throw new TypeError('createServer requires a chat provider');
  const assets = loadAssets(frontendDir);
  const creating = new Set();
  let draining = false;

  function routeLabel(pathname) {
    if (pathname === '/healthz') return 'health';
    if (pathname === START_PATH) return 'start';
    if (pathname === CHAT_PATH) return 'chat';
    if (HANGUP_PATH.test(pathname)) return 'hangup';
    return assets.has(pathname) ? 'static' : 'other';
  }

  function send(req, res, status, type, body, extra = {}) {
    const payload = Buffer.from(body);
    res.writeHead(status, { ...COMMON_HEADERS, 'Content-Type': type, 'Content-Length': payload.length, ...extra });
    res.end(req.method === 'HEAD' ? undefined : payload);
  }

  const sendJson = (req, res, status, body, extra) =>
    send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(body), extra);

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
    // Absent means the default scenario; a present header must be exactly one allowed value.
    const scenario = req.headers['x-yai-scenario'] ?? DEFAULT_SCENARIO;
    if (!isScenario(scenario)) return sendJson(req, res, 400, { error: 'invalid_scenario' });
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
        const answer = await provider.start(sdp, { scenario });
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

  function chatFailure(req, res, error) {
    // Only an allowlisted code is mirrored, never the provider's message or body.
    const known = typeof error?.code === 'string' && CHAT_ERROR_STATUS.has(error.code);
    const code = known ? error.code : 'upstream_failed';
    const status = CHAT_ERROR_STATUS.get(code);
    log({ level: status === 429 ? 'warn' : 'error', msg: 'chat failed', status, code, error: error?.name ?? 'Error' });
    return sendJson(req, res, status, { error: code });
  }

  async function chatRoute(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(req, res, 'POST');
    if (!originAllowed(req)) return sendJson(req, res, 403, { error: 'origin_not_allowed' });
    if (draining) return sendJson(req, res, 503, { error: 'shutting_down' });
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return sendJson(req, res, 400, { error: 'invalid_request' });
    let buffer;
    try {
      buffer = await readBody(req, MAX_CHAT_BODY_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLarge) return sendJson(req, res, 413, { error: 'too_large' }, { Connection: 'close' });
      return res.destroy();
    }
    const parsed = parseChatRequest(buffer);
    if (!parsed) return sendJson(req, res, 400, { error: 'invalid_request' });
    let reply;
    try {
      reply = await chat.reply(parsed.scenario, parsed.messages);
    } catch (error) {
      return chatFailure(req, res, error);
    }
    if (typeof reply !== 'string' || reply === '') return chatFailure(req, res, null);
    if (res.destroyed) return undefined;
    return sendJson(req, res, 200, { reply });
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
    if (pathname === START_PATH) return startRoute(req, res);
    if (pathname === CHAT_PATH) return chatRoute(req, res);
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
    console.error('yai-mali-web: refusing to start. Fix these environment variables:');
    for (const { name, message } of error.problems) console.error(`  ${name}: ${message}`);
    process.exitCode = 1;
    return undefined;
  }
  const log = (msg) => defaultLog({ level: 'warn', msg });
  const provider = createVoiceProvider({ apiKey: config.apiKey, cutoffAt: config.cutoffAt, stateDir: config.stateDir, log });
  const chat = createChatProvider({ apiKey: config.apiKey, stateDir: config.stateDir, log });
  const server = createServer(config, { provider, chat });
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
