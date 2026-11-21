// Tests for the connect-web-call origin. Run with:
//   node --test connect-web-call/backend/server.test.mjs
// This also loads widget.test.mjs (the browser-side logic: widget URL allow-list, documented
// snippet, token callback), so the one command above covers both halves.
//
// Everything is local: the server listens on 127.0.0.1 with fixture credentials. A fake token
// response proves nothing about Amazon Connect; the live acceptance call is a separate step.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConfigError, REQUIRED_ENV, loadConfig, publicWidgetConfig } from './config.mjs';
import { signWidgetToken } from './jwt.mjs';
import { TOKEN_LIMIT, TOKEN_WINDOW_MS, createServer } from './server.mjs';
import './widget.test.mjs';

const ORIGIN = 'https://call-sea-hackathon.voidbox.io';
const SCRIPT_URL = 'https://team-11-call.my.connect.aws/connectwidget/static/amazon-connect-chat-interface-client.js';
const WIDGET_ID = '3f1c2a9e-8b7d-4c3a-9e21-5d6f7a8b9c0d';
// Deliberately different from WIDGET_ID: the JWT subject must be the widget ID.
const SNIPPET_ID = 'QVFJREFIZml4dHVyZS1zbmlwcGV0LWlkLW5vdC10aGUtd2lkZ2V0LWlk';
// Fixture only. 44 characters used literally, like the key Connect issues (it is base64-looking
// on purpose so that wrongly decoding it would produce a different signature).
const SIGNING_KEY = 'Zml4dHVyZS1rZXktbm90LWEtcmVhbC1zZWNyZXQtb2s=';
const DEMO_PASSWORD = 'fixture-demo-password-not-real';
assert.equal(SIGNING_KEY.length, 44);

const VALID_ENV = Object.freeze({
  PUBLIC_ORIGIN: ORIGIN,
  WIDGET_SCRIPT_URL: SCRIPT_URL,
  WIDGET_ID,
  WIDGET_SNIPPET_ID: SNIPPET_ID,
  WIDGET_SIGNING_KEY: SIGNING_KEY,
  DEMO_PASSWORD,
});

// 2026-11-21T10:00:00Z. KNOWN_TOKEN was computed with an independent implementation (Python
// hmac/hashlib/base64) over this widget ID, this clock and the literal SIGNING_KEY.
const T0_MS = Date.UTC(2026, 10, 21, 10, 0, 0);
const T0_SECONDS = 1795255200;
const KNOWN_TOKEN =
  'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIzZjFjMmE5ZS04YjdkLTRjM2EtOWUyMS01ZDZmN2E4YjljMGQiLCJpYXQiOjE3OTUyNTUyMDAsImV4cCI6MTc5NTI1NTI2MH0.S5NhQeYj0mR_fNBFXpJHBptIf3q6wU7LuiU7LX6ZxH0';
const SIGNATURE_IF_KEY_WERE_BASE64_DECODED = 'bwRx5_lfwkpMaxDLaCiXkDcDtq2nZeKChXiM8oFqwRM';

const SERVER_PATH = fileURLToPath(new URL('./server.mjs', import.meta.url));

const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const TEAM_AUTH = basic('team', DEMO_PASSWORD);
const clean = (headers) => Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: clean(headers), agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// Pass `auth: undefined` or `origin: undefined` to omit that header: a default parameter would
// silently substitute the valid value and turn the negative cases into vacuous happy paths.
const option = (options, key, fallback) => (Object.hasOwn(options, key) ? options[key] : fallback);

const post = (port, options = {}) =>
  request(port, {
    method: 'POST',
    path: '/api/widget-token',
    headers: {
      authorization: option(options, 'auth', TEAM_AUTH),
      origin: option(options, 'origin', ORIGIN),
      ...(options.headers ?? {}),
    },
    body: options.body,
  });

const get = (port, path) => request(port, { path, headers: { authorization: TEAM_AUTH } });

async function withServer(fn, { env = {} } = {}) {
  const config = loadConfig({ ...VALID_ENV, ...env });
  const clock = { ms: T0_MS };
  const logs = [];
  const server = createServer(config, { now: () => clock.ms, log: (entry) => logs.push(entry) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn({ port: server.address().port, clock, logs });
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

const decodePart = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/** Independent verification: recompute HS256 over the signing input with the literal key. */
function verifyToken(token) {
  const parts = token.split('.');
  assert.equal(parts.length, 3);
  const expected = createHmac('sha256', SIGNING_KEY).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  assert.equal(parts[2], expected, 'signature must verify against the literal signing key');
  return { header: decodePart(parts[0]), payload: decodePart(parts[1]) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

describe('configuration', () => {
  test('accepts the documented environment and keeps secrets out of its JSON form', () => {
    const config = loadConfig(VALID_ENV);
    assert.equal(config.host, '0.0.0.0', 'containers bind every interface by default');
    assert.equal(loadConfig({ ...VALID_ENV, HOST: '127.0.0.1' }).host, '127.0.0.1', 'local development binds loopback');
    assert.equal(config.publicOrigin, ORIGIN);
    assert.equal(loadConfig({ ...VALID_ENV, PUBLIC_ORIGIN: 'http://localhost:8080' }).publicOrigin, 'http://localhost:8080');
    const json = JSON.stringify(config);
    assert.ok(!json.includes(SIGNING_KEY) && !json.includes(DEMO_PASSWORD));
    assert.deepEqual(publicWidgetConfig(config), { scriptUrl: SCRIPT_URL, widgetId: WIDGET_ID, snippetId: SNIPPET_ID });
  });

  for (const name of REQUIRED_ENV) {
    test(`refuses to load without ${name}`, () => {
      for (const missing of [undefined, '']) {
        const env = { ...VALID_ENV, [name]: missing };
        if (missing === undefined) delete env[name];
        assert.throws(
          () => loadConfig(env),
          (error) => {
            assert.ok(error instanceof ConfigError);
            assert.deepEqual(error.problems.map((problem) => problem.name), [name]);
            assert.ok(!error.message.includes(SIGNING_KEY) && !error.message.includes(DEMO_PASSWORD));
            return true;
          },
        );
      }
    });
  }

  // One representative per rule that guards the auth/JWT boundary.
  const INVALID = {
    'an http origin that is not localhost': ['PUBLIC_ORIGIN', 'http://call-sea-hackathon.voidbox.io'],
    'an origin with a path': ['PUBLIC_ORIGIN', `${ORIGIN}/path`],
    'a script URL outside my.connect.aws': ['WIDGET_SCRIPT_URL', 'https://attacker.example/connectwidget/static/amazon-connect-chat-interface-client.js'],
    'a widget ID that is not a UUID': ['WIDGET_ID', SNIPPET_ID],
    'a snippet ID equal to the widget ID': ['WIDGET_SNIPPET_ID', WIDGET_ID],
    'a signing key of the wrong length': ['WIDGET_SIGNING_KEY', SIGNING_KEY.slice(0, 43)],
    'a signing key with a trailing newline': ['WIDGET_SIGNING_KEY', `${SIGNING_KEY}\n`],
    'a short demo password': ['DEMO_PASSWORD', 'too-short'],
    'the signing key reused as the demo password': ['DEMO_PASSWORD', SIGNING_KEY],
    'a HOST that is not an IP address': ['HOST', 'not-an-ip'],
  };
  for (const [description, [name, value]] of Object.entries(INVALID)) {
    test(`rejects ${description}`, () => {
      assert.throws(
        () => loadConfig({ ...VALID_ENV, [name]: value }),
        (error) => {
          assert.ok(error instanceof ConfigError);
          assert.ok(error.problems.some((problem) => problem.name === name), `expected a problem for ${name}`);
          assert.ok(!error.message.includes(SIGNING_KEY) && !error.message.includes(DEMO_PASSWORD));
          return true;
        },
      );
    });
  }
});

describe('widget JWT', () => {
  test('matches an independently computed HS256 known answer', () => {
    const token = signWidgetToken({ widgetId: WIDGET_ID, signingKey: SIGNING_KEY, nowSeconds: T0_SECONDS });
    assert.equal(token, KNOWN_TOKEN);
    const { header, payload } = verifyToken(token);
    assert.deepEqual(header, { typ: 'JWT', alg: 'HS256' });
    assert.deepEqual(payload, { sub: WIDGET_ID, iat: T0_SECONDS, exp: T0_SECONDS + 60 });
  });

  test('uses the key literally, not base64-decoded, and the widget ID, not the snippet ID', () => {
    const [header, payload, signature] = KNOWN_TOKEN.split('.');
    const decodedKeySignature = createHmac('sha256', Buffer.from(SIGNING_KEY, 'base64'))
      .update(`${header}.${payload}`)
      .digest('base64url');
    assert.equal(decodedKeySignature, SIGNATURE_IF_KEY_WERE_BASE64_DECODED);
    assert.notEqual(signature, SIGNATURE_IF_KEY_WERE_BASE64_DECODED);
    assert.notEqual(decodePart(payload).sub, SNIPPET_ID);
  });

  test('refuses milliseconds where Unix seconds are required', () => {
    assert.throws(
      () => signWidgetToken({ widgetId: WIDGET_ID, signingKey: SIGNING_KEY, nowSeconds: T0_MS }),
      TypeError,
    );
  });
});

describe('startup', () => {
  test('refuses to start without configuration', () => {
    const result = spawnSync(process.execPath, [SERVER_PATH], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, 1);
    for (const name of REQUIRED_ENV) assert.match(result.stderr, new RegExp(name));
    assert.equal(result.stdout, '', 'it must not have started listening');
  });

  test('refuses to start with one missing secret and never prints the others', () => {
    const env = { PATH: process.env.PATH, ...VALID_ENV };
    delete env.DEMO_PASSWORD;
    const result = spawnSync(process.execPath, [SERVER_PATH], { env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DEMO_PASSWORD/);
    for (const output of [result.stdout, result.stderr]) {
      assert.ok(!output.includes(SIGNING_KEY));
      assert.ok(!output.includes(DEMO_PASSWORD));
    }
  });

  test('starts from the environment, answers readiness, challenges anonymous users, and stops on SIGTERM', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [SERVER_PATH], {
      env: { PATH: process.env.PATH, ...VALID_ENV, PORT: String(port), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    // 'close' (not 'exit') fires only after stdout/stderr are fully drained.
    const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    try {
      await waitFor(() => output.includes('"listening"'), 'the server to report listening');
      assert.deepEqual((await request(port, { path: '/healthz' })).json(), { status: 'ok' });
      assert.equal((await request(port, { path: '/' })).status, 401);
      child.kill('SIGTERM');
      const outcome = await Promise.race([exited, sleep(10_000).then(() => 'timeout')]);
      assert.deepEqual(outcome, { code: 0, signal: null });
    } finally {
      child.kill('SIGKILL');
    }
    assert.ok(!output.includes(SIGNING_KEY) && !output.includes(DEMO_PASSWORD));
  });
});

describe('readiness', () => {
  test('GET /healthz is public and reveals nothing but readiness', async () => {
    await withServer(async ({ port }) => {
      const res = await request(port, { path: '/healthz' });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json(), { status: 'ok' });
      for (const secret of [WIDGET_ID, SNIPPET_ID, SIGNING_KEY, DEMO_PASSWORD, SCRIPT_URL]) {
        assert.ok(!res.text.includes(secret));
      }
    });
  });
});

describe('team authentication', () => {
  const BAD_AUTH = {
    'no credentials': undefined,
    'a wrong password': basic('team', `${DEMO_PASSWORD}x`),
    'a wrong username': basic('admin', DEMO_PASSWORD),
    'a non-Basic scheme': `Bearer ${DEMO_PASSWORD}`,
    'a malformed Basic payload': 'Basic !!!!',
  };
  for (const [name, auth] of Object.entries(BAD_AUTH)) {
    test(`token request with ${name} is 401 and carries no token`, async () => {
      await withServer(async ({ port }) => {
        const res = await post(port, { auth });
        assert.equal(res.status, 401);
        assert.match(res.headers['www-authenticate'], /^Basic realm=".+"/);
        assert.equal(res.text, '{"error":"unauthorized"}');
        assert.equal(res.headers['cache-control'], 'no-store');
      });
    });
  }

  test('a password containing colons is accepted (only the first colon splits)', async () => {
    const password = 'fixture:demo:password:not-real';
    await withServer(
      async ({ port }) => {
        assert.equal((await post(port, { auth: basic('team', password) })).status, 200);
      },
      { env: { DEMO_PASSWORD: password } },
    );
  });

  test('every route except /healthz requires auth, before any method or origin check', async () => {
    await withServer(async ({ port }) => {
      for (const path of ['/', '/call.js', '/api/widget-config', '/api/widget-token', '/nope']) {
        assert.equal((await request(port, { path })).status, 401, `GET ${path}`);
      }
      const wrongOriginNoAuth = await post(port, { auth: undefined, origin: 'https://evil.example' });
      assert.equal(wrongOriginNoAuth.status, 401, 'anonymous callers learn nothing about the origin policy');
    });
  });

  test('an unauthenticated browser navigation gets a readable page with the challenge', async () => {
    await withServer(async ({ port }) => {
      const res = await request(port, { path: '/', headers: { accept: 'text/html,application/xhtml+xml' } });
      assert.equal(res.status, 401);
      assert.match(res.headers['content-type'], /^text\/html/);
      assert.match(res.headers['www-authenticate'], /^Basic /);
    });
  });
});

describe('POST /api/widget-token', () => {
  test('issues a verifiable HS256 token for the widget ID with exp = iat + 60', async () => {
    await withServer(async ({ port }) => {
      const res = await post(port, { headers: { 'sec-fetch-site': 'same-origin' } });
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.json()), ['data']);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.match(res.headers['content-type'], /^application\/json/);
      assert.equal(res.headers['access-control-allow-origin'], undefined);
      assert.equal(res.headers.location, undefined);

      const token = res.json().data;
      assert.equal(token, KNOWN_TOKEN);
      const { header, payload } = verifyToken(token);
      assert.deepEqual(header, { typ: 'JWT', alg: 'HS256' });
      assert.deepEqual(payload, { sub: WIDGET_ID, iat: T0_SECONDS, exp: T0_SECONDS + 60 });
      assert.notEqual(payload.sub, SNIPPET_ID, 'the subject is the widget ID, never the snippet ID');
    });
  });

  const BAD_ORIGINS = {
    'a missing Origin': undefined,
    'another site': 'https://evil.example',
    'a look-alike suffix': `${ORIGIN}.evil.example`,
    'another scheme': 'http://call-sea-hackathon.voidbox.io',
  };
  for (const [name, origin] of Object.entries(BAD_ORIGINS)) {
    test(`403 for ${name}, with no token`, async () => {
      await withServer(async ({ port }) => {
        const res = await post(port, { origin });
        assert.equal(res.status, 403);
        assert.equal(res.text, '{"error":"origin_not_allowed"}');
        assert.equal(res.headers['access-control-allow-origin'], undefined);
      });
    });
  }

  test('403 when the browser reports a cross-site request, even with the right Origin', async () => {
    await withServer(async ({ port }) => {
      const res = await post(port, { headers: { 'sec-fetch-site': 'cross-site' } });
      assert.equal(res.status, 403);
      assert.doesNotMatch(res.text, /"data"/);
    });
  });

  for (const method of ['GET', 'OPTIONS']) {
    test(`${method} is 405 and advertises POST only`, async () => {
      await withServer(async ({ port }) => {
        const res = await request(port, {
          method,
          path: '/api/widget-token',
          headers: { authorization: TEAM_AUTH, origin: ORIGIN },
        });
        assert.equal(res.status, 405);
        assert.equal(res.headers.allow, 'POST');
        assert.equal(res.headers['access-control-allow-origin'], undefined);
        assert.doesNotMatch(res.text, /"data"/);
      });
    });
  }

  test('a CORS preflight from another origin gets no permission headers', async () => {
    await withServer(async ({ port }) => {
      const res = await request(port, {
        method: 'OPTIONS',
        path: '/api/widget-token',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      });
      assert.equal(res.status, 401);
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    });
  });

  test('a request body is refused and consumes no token', async () => {
    await withServer(async ({ port }) => {
      const res = await post(port, { body: 'x', headers: { 'content-length': '1' } });
      assert.equal(res.status, 413);
      assert.doesNotMatch(res.text, /"data"/);
      for (let i = 0; i < TOKEN_LIMIT; i += 1) assert.equal((await post(port)).status, 200);
    });
  });
});

describe('rate limit', () => {
  test('six tokens per minute across the whole process, then 429 until the window passes', async () => {
    await withServer(async ({ port, clock }) => {
      assert.equal(TOKEN_LIMIT, 6);
      assert.equal(TOKEN_WINDOW_MS, 60_000);
      for (let i = 0; i < 6; i += 1) assert.equal((await post(port)).status, 200, `token ${i + 1}`);

      clock.ms = T0_MS + 10_000;
      const limited = await post(port);
      assert.equal(limited.status, 429);
      assert.equal(limited.headers['retry-after'], '50');
      assert.equal(limited.text, '{"error":"rate_limited"}');

      clock.ms = T0_MS + TOKEN_WINDOW_MS;
      assert.equal((await post(port)).status, 200, 'the window has passed');
    });
  });

  test('only requests that would receive a token count against the limit', async () => {
    await withServer(async ({ port }) => {
      for (let i = 0; i < 10; i += 1) {
        assert.equal((await post(port, { auth: basic('team', 'wrong-password-fixture') })).status, 401);
        assert.equal((await post(port, { origin: 'https://evil.example' })).status, 403);
        assert.equal((await request(port, { path: '/api/widget-token', headers: { authorization: TEAM_AUTH } })).status, 405);
      }
      for (let i = 0; i < 6; i += 1) assert.equal((await post(port)).status, 200, `token ${i + 1} still available`);
      assert.equal((await post(port)).status, 429);
    });
  });
});

describe('no redirects', () => {
  test('no response is ever a redirect or carries a Location header', async () => {
    await withServer(async ({ port }) => {
      const paths = ['/', '//evil.example', '/api/widget-token/', '/call.js?next=https://evil.example'];
      for (const method of ['GET', 'POST']) {
        for (const auth of [TEAM_AUTH, undefined]) {
          for (const path of paths) {
            const res = await request(port, { method, path, headers: { authorization: auth, origin: ORIGIN } });
            assert.ok(res.status < 300 || res.status >= 400, `${method} ${path} -> ${res.status}`);
            assert.equal(res.headers.location, undefined, `${method} ${path} must not redirect`);
          }
        }
      }
    });
  });

  test('an absolute-form request target is a 400 and never reaches routing', async () => {
    await withServer(async ({ port }) => {
      const res = await request(port, {
        method: 'POST',
        path: 'http://evil.example/api/widget-token',
        headers: { authorization: TEAM_AUTH, origin: ORIGIN },
      });
      assert.equal(res.status, 400);
      assert.doesNotMatch(res.text, /"data"/);
    });
  });
});

describe('static page and configuration endpoint', () => {
  test('serves the page and its scripts to the team', async () => {
    await withServer(async ({ port }) => {
      const page = await get(port, '/');
      assert.equal(page.status, 200);
      assert.match(page.headers['content-type'], /^text\/html/);
      assert.match(page.text, /Team Eleven\. Your browser is connected to Amazon Connect\./);
      for (const [path, type] of [['/call.js', /^text\/javascript/], ['/widget.mjs', /^text\/javascript/], ['/styles.css', /^text\/css/]]) {
        const res = await get(port, path);
        assert.equal(res.status, 200, path);
        assert.match(res.headers['content-type'], type, path);
      }
    });
  });

  test('serves nothing outside the frontend allow-list', async () => {
    await withServer(async ({ port }) => {
      for (const path of ['/backend/server.mjs', '/.env', '/server.test.mjs', '/../backend/config.mjs', '/%2e%2e/backend/server.mjs']) {
        const res = await get(port, path);
        assert.equal(res.status, 404, path);
        assert.equal(res.text, '{"error":"not_found"}');
      }
    });
  });

  test('GET /api/widget-config exposes public widget fields only', async () => {
    await withServer(async ({ port }) => {
      const res = await get(port, '/api/widget-config');
      assert.equal(res.status, 200);
      assert.deepEqual(res.json(), { scriptUrl: SCRIPT_URL, widgetId: WIDGET_ID, snippetId: SNIPPET_ID });
      for (const secret of [SIGNING_KEY, DEMO_PASSWORD]) assert.ok(!res.text.includes(secret));
    });
  });

  test('responses are uncacheable, unframeable, and keep an origin-only referrer for the widget', async () => {
    await withServer(async ({ port }) => {
      const responses = [await request(port, { path: '/' }), await get(port, '/'), await get(port, '/api/widget-config'), await post(port)];
      for (const res of responses) {
        assert.equal(res.headers['cache-control'], 'no-store');
        assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
        // Origin-only referrer: the AWS widget still needs to see which site embeds it.
        assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
      }
    });
  });
});

describe('logging', () => {
  test('log lines never contain credentials, tokens, or header values', async () => {
    await withServer(async ({ port, logs }) => {
      const wrongPassword = 'wrong-password-marker-12345';
      const wrongAuth = basic('team', wrongPassword);
      const issued = await post(port);
      assert.equal(issued.status, 200);
      await post(port, { auth: wrongAuth });
      await post(port, { origin: 'https://evil.example' });
      await get(port, '/secret-looking-path?token=abc');
      for (let i = 0; i < TOKEN_LIMIT; i += 1) await post(port);
      await sleep(50); // access-log lines are written when each response finishes

      assert.ok(logs.length >= 6, 'the log must not be empty, or this test proves nothing');
      assert.ok(logs.some((entry) => entry.msg === 'widget token issued'));
      assert.ok(logs.some((entry) => entry.msg === 'request' && entry.route === 'token' && entry.status === 429));
      const text = JSON.stringify(logs);
      for (const secret of [
        DEMO_PASSWORD,
        SIGNING_KEY,
        issued.json().data,
        TEAM_AUTH,
        TEAM_AUTH.slice('Basic '.length),
        wrongPassword,
        wrongAuth,
        wrongAuth.slice('Basic '.length),
        'secret-looking-path',
        'token=abc',
      ]) {
        assert.ok(!text.includes(secret), 'a secret or request detail reached the log');
      }
    });
  });
});
