// Tests for the voice-call origin. Run with:
//   node --test connect-web-call/backend/server.test.mjs
// Everything is local and nonbillable: a fake provider replaces ./realtime.mjs and every
// credential below is a fixture.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { ConfigError, loadConfig } from './config.mjs';
import { createServer, isAudioOnlyOffer } from './server.mjs';

const ORIGIN = 'https://call-sea-hackathon.voidbox.io';
const DEMO_PASSWORD = 'fixture-demo-password-not-real';
const API_KEY = 'sk-fixture-not-a-real-openai-key-0000';
const CALL_ID = 'rtc_fixture_call-01';
const OFFER = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=sendrecv', ''].join('\r\n');
const ANSWER = 'v=0\r\ns=fixture-answer\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
// Shape of what Chrome sends for a Realtime call: one audio section plus the oai-events channel.
const CHROME_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126',
  'c=IN IP4 0.0.0.0',
  'a=rtcp:9 IN IP4 0.0.0.0',
  'a=ice-ufrag:abcd',
  'a=ice-pwd:fixturefixturefixturefixture',
  'a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
  'a=setup:actpass',
  'a=mid:0',
  'a=sendrecv',
  'a=rtcp-mux',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:abcd',
  'a=ice-pwd:fixturefixturefixturefixture',
  'a=setup:actpass',
  'a=mid:1',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');
const VALID_ENV = Object.freeze({
  PUBLIC_ORIGIN: ORIGIN,
  DEMO_PASSWORD,
  OPENAI_API_KEY: API_KEY,
  VOICE_CUTOFF_AT: '2026-11-21T16:59:00Z',
});

const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const TEAM_AUTH = basic('team', DEMO_PASSWORD);
const GOOD = Object.freeze({ authorization: TEAM_AUTH, origin: ORIGIN, 'content-type': 'application/sdp' });
const clean = (headers) => Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));

function fakeProvider(overrides = {}) {
  const calls = { start: [], hangup: [], shutdown: 0 };
  return {
    calls,
    async start(sdp) {
      calls.start.push(sdp);
      return { id: CALL_ID, sdp: ANSWER };
    },
    async hangup(id) {
      calls.hangup.push(id);
    },
    async shutdown() {
      calls.shutdown += 1;
      return { hungUp: true, uncertain: false };
    },
    ...overrides,
  };
}

async function withServer(provider, fn, { logs = [] } = {}) {
  const config = loadConfig({ ...VALID_ENV, HOST: '127.0.0.1' });
  const server = createServer(config, { provider, log: (entry) => logs.push(entry) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await fn(server.address().port, server);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: clean(headers), agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const start = (port, extra = {}) => request(port, { method: 'POST', path: '/api/voice/calls', headers: { ...GOOD, ...extra.headers }, body: extra.body ?? OFFER });
const hangup = (port, id = CALL_ID, headers = GOOD) =>
  request(port, { method: 'POST', path: `/api/voice/calls/${id}/hangup`, headers });

describe('config', () => {
  test('loads required values and defaults the state directory', () => {
    const config = loadConfig(VALID_ENV);
    assert.equal(config.stateDir, '/var/lib/team-voice');
    assert.equal(config.cutoffAt, Date.UTC(2026, 10, 21, 16, 59)); // epoch milliseconds
    assert.equal(config.publicOrigin, ORIGIN);
    assert.equal(loadConfig({ ...VALID_ENV, VOICE_STATE_DIR: '/tmp/state' }).stateDir, '/tmp/state');
  });

  test('normalises offsets to UTC', () => {
    assert.equal(loadConfig({ ...VALID_ENV, VOICE_CUTOFF_AT: '2026-11-21T23:59:00+07:00' }).cutoffAt, Date.UTC(2026, 10, 21, 16, 59));
  });

  for (const name of ['PUBLIC_ORIGIN', 'DEMO_PASSWORD', 'OPENAI_API_KEY', 'VOICE_CUTOFF_AT']) {
    test(`missing ${name} names the variable and never a value`, () => {
      const env = { ...VALID_ENV };
      delete env[name];
      assert.throws(() => loadConfig(env), (error) => {
        assert.ok(error instanceof ConfigError);
        assert.deepEqual(error.problems.map((p) => p.name), [name]);
        assert.ok(!error.message.includes(API_KEY) && !error.message.includes(DEMO_PASSWORD));
        return true;
      });
    });
  }

  for (const bad of ['2026-11-21', '2026-11-21T16:59:00', 'tomorrow', '2026-13-45T00:00:00Z']) {
    test(`rejects VOICE_CUTOFF_AT ${bad}`, () => {
      assert.throws(() => loadConfig({ ...VALID_ENV, VOICE_CUTOFF_AT: bad }), ConfigError);
    });
  }

  test('rejects bad origin, relative state dir, short password, reused key', () => {
    assert.throws(() => loadConfig({ ...VALID_ENV, PUBLIC_ORIGIN: 'http://example.com' }), ConfigError);
    assert.throws(() => loadConfig({ ...VALID_ENV, PUBLIC_ORIGIN: `${ORIGIN}/` }), ConfigError);
    assert.throws(() => loadConfig({ ...VALID_ENV, VOICE_STATE_DIR: 'relative' }), ConfigError);
    assert.throws(() => loadConfig({ ...VALID_ENV, DEMO_PASSWORD: 'short' }), ConfigError);
    assert.throws(() => loadConfig({ ...VALID_ENV, DEMO_PASSWORD: API_KEY }), ConfigError);
  });

  test('serialising config leaks no secret', () => {
    const text = JSON.stringify(loadConfig(VALID_ENV));
    assert.ok(!text.includes(API_KEY) && !text.includes(DEMO_PASSWORD));
  });
});

describe('offer validation', () => {
  test('accepts an audio-only offer, CRLF or LF', () => {
    assert.ok(isAudioOnlyOffer(OFFER));
    assert.ok(isAudioOnlyOffer(OFFER.replaceAll('\r\n', '\n')));
  });
  for (const [name, sdp] of [
    ['empty', ''],
    ['not sdp', 'hello'],
    ['video section', `${OFFER}m=video 9 UDP/TLS/RTP/SAVPF 96\r\n`],
    ['chrome offer plus video', `${CHROME_OFFER}m=video 9 UDP/TLS/RTP/SAVPF 96\r\n`],
    ['two audio sections', `${CHROME_OFFER}m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n`],
    ['two data channels', `${CHROME_OFFER}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`],
    ['application that is not SCTP data channel', `${OFFER}m=application 9 RTP/AVP 100\r\n`],
    ['data channel without audio', 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'],
    ['no media', 'v=0\r\ns=-\r\n'],
    ['video only', 'v=0\r\nm=video 9 RTP/AVP 96\r\n'],
    ['stray line', `${OFFER}garbage\r\n`],
    ['non-ascii', `${OFFER}a=x\u00e9\r\n`],
    ['control byte', `${OFFER}a=x\u0000\r\n`],
  ]) {
    test(`rejects ${name}`, () => assert.equal(isAudioOnlyOffer(sdp), false));
  }
  test('accepts a realistic Chrome offer: audio plus the oai-events data channel', () => {
    assert.ok(isAudioOnlyOffer(CHROME_OFFER));
    assert.ok(isAudioOnlyOffer(CHROME_OFFER.replaceAll('\r\n', '\n')));
  });
});

describe('health and static files', () => {
  test('healthz is open, tiny and uncached', async () => {
    await withServer(fakeProvider(), async (port) => {
      const res = await request(port, { path: '/healthz' });
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.text), { status: 'ok' });
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal((await request(port, { method: 'POST', path: '/healthz' })).status, 405);
    });
  });

  test('the three assets need auth and are served no-store', async () => {
    await withServer(fakeProvider(), async (port) => {
      for (const [path, type] of [['/', 'text/html'], ['/index.html', 'text/html'], ['/styles.css', 'text/css'], ['/call.js', 'text/javascript']]) {
        assert.equal((await request(port, { path })).status, 401, path);
        const res = await request(port, { path, headers: { authorization: TEAM_AUTH } });
        assert.equal(res.status, 200, path);
        assert.ok(res.headers['content-type'].startsWith(type));
        assert.equal(res.headers['cache-control'], 'no-store');
        assert.equal(res.headers['access-control-allow-origin'], undefined);
      }
    });
  });

  test('401 carries a Basic challenge for the team realm', async () => {
    await withServer(fakeProvider(), async (port) => {
      const res = await request(port, { path: '/' });
      assert.match(res.headers['www-authenticate'], /^Basic realm="Team 11 Connect call"/);
    });
  });

  test('only fixed routes exist: no widget, config, traversal, recording or redirects', async () => {
    await withServer(fakeProvider(), async (port) => {
      const headers = { authorization: TEAM_AUTH };
      for (const path of ['/widget.mjs', '/api/widget-config', '/api/widget-token', '/api/voice/recordings', '/../server.mjs', '/%2e%2e/server.mjs', '/call.js/', '/api/voice/calls/x/summary']) {
        const res = await request(port, { path, headers });
        assert.equal(res.status, 404, path);
        assert.equal(res.headers.location, undefined);
      }
      assert.equal((await request(port, { path: '//evil.example/', headers })).status, 400);
      assert.equal((await request(port, { method: 'POST', path: '/call.js', headers })).status, 405);
    });
  });
});

describe('POST /api/voice/calls', () => {
  test('happy path: 201, SDP answer, call id header, offer forwarded verbatim', async () => {
    const provider = fakeProvider();
    await withServer(provider, async (port) => {
      const res = await start(port);
      assert.equal(res.status, 201);
      assert.equal(res.headers['content-type'], 'application/sdp');
      assert.equal(res.headers['x-voice-call-id'], CALL_ID);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.text, ANSWER);
      assert.deepEqual(provider.calls.start, [OFFER]);
      assert.deepEqual(provider.calls.hangup, []);
    });
  });

  test('wrong or missing auth never reaches the provider', async () => {
    const provider = fakeProvider();
    await withServer(provider, async (port) => {
      for (const authorization of [undefined, basic('team', 'wrong-password-wrong-pw'), basic('other', DEMO_PASSWORD), 'Bearer x', 'Basic !!!']) {
        const res = await start(port, { headers: { authorization } });
        assert.equal(res.status, 401);
      }
      assert.equal(provider.calls.start.length, 0);
    });
  });

  test('origin must match exactly, Sec-Fetch-Site must be same-origin', async () => {
    const provider = fakeProvider();
    await withServer(provider, async (port) => {
      for (const origin of [undefined, 'null', 'http://call-sea-hackathon.voidbox.io', `${ORIGIN}.evil.example`, `${ORIGIN}/`, 'https://evil.example']) {
        assert.equal((await start(port, { headers: { origin } })).status, 403, String(origin));
      }
      assert.equal((await start(port, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
      assert.equal((await start(port, { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
      assert.equal(provider.calls.start.length, 0);
      assert.equal((await start(port, { headers: { 'sec-fetch-site': 'same-origin' } })).status, 201);
    });
  });

  test('method and media type are strict', async () => {
    const provider = fakeProvider();
    await withServer(provider, async (port) => {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const res = await request(port, { method, path: '/api/voice/calls', headers: GOOD });
        assert.equal(res.status, 405, method);
        assert.equal(res.headers.allow, 'POST');
      }
      for (const type of [undefined, 'application/json', 'text/plain', 'multipart/form-data; boundary=x']) {
        assert.equal((await start(port, { headers: { 'content-type': type } })).status, 415, String(type));
      }
      assert.equal(provider.calls.start.length, 0);
    });
  });

  test('body over 32 KiB is refused before the provider; offers that are not audio-only get 400', async () => {
    const provider = fakeProvider();
    await withServer(provider, async (port) => {
      assert.equal((await start(port, { body: `${OFFER}a=${'x'.repeat(33 * 1024)}\r\n` })).status, 413);
      assert.equal((await start(port, { body: 'not sdp' })).status, 400);
      assert.equal((await start(port, { body: `${OFFER}m=video 9 RTP/AVP 96\r\n` })).status, 400);
      assert.equal((await start(port, { body: '' })).status, 400);
      assert.equal(provider.calls.start.length, 0);
    });
  });

  test('session settings from the browser are not a thing: query string is ignored, only the SDP is forwarded', async () => {
    const provider = fakeProvider();
    await withServer(provider, async (port) => {
      const res = await request(port, {
        method: 'POST',
        path: '/api/voice/calls?model=gpt-x&instructions=evil',
        headers: { ...GOOD, 'x-session': '{"voice":"x"}' },
        body: OFFER,
      });
      assert.equal(res.status, 201);
      assert.deepEqual(provider.calls.start, [OFFER]);
    });
  });

  test('provider failures map to safe statuses without leaking provider text', async () => {
    const cases = [
      [403, 'voice_closed', 403, 'voice_closed'],
      [404, 'unknown_call', 404, 'unknown_call'],
      [429, 'busy', 429, 'busy'],
      [429, 'quota_exhausted', 429, 'quota_exhausted'],
      [503, 'shutting_down', 503, 'shutting_down'],
      [400, 'invalid_offer', 400, 'invalid_offer'],
      [502, 'upstream_rejected', 502, 'upstream_rejected'],
      [500, 'weird_new_code', 502, 'upstream_error'], // unknown code and status are collapsed
      [401, undefined, 502, 'upstream_error'],
      [undefined, undefined, 502, 'upstream_error'],
    ];
    for (const [status, code, expected, expectedCode] of cases) {
      const provider = fakeProvider({
        async start() {
          throw Object.assign(new Error(`upstream secret ${API_KEY} body`), { status, code });
        },
      });
      const logs = [];
      await withServer(provider, async (port) => {
        const res = await start(port);
        assert.equal(res.status, expected);
        assert.deepEqual(JSON.parse(res.text), { error: expectedCode });
        assert.ok(!res.text.includes(API_KEY) && !res.text.includes('upstream secret'));
      }, { logs });
      assert.ok(!JSON.stringify(logs).includes(API_KEY));
    }
  });

  test('an unusable provider answer is a 502 and an otherwise valid call is hung up', async () => {
    const provider = fakeProvider({
      async start() {
        return { id: CALL_ID, sdp: '' };
      },
    });
    await withServer(provider, async (port) => {
      assert.equal((await start(port)).status, 502);
      assert.deepEqual(provider.calls.hangup, [CALL_ID]);
    });
    const badId = fakeProvider({
      async start() {
        return { id: '../../x', sdp: ANSWER };
      },
    });
    await withServer(badId, async (port) => {
      assert.equal((await start(port)).status, 502);
      assert.deepEqual(badId.calls.hangup, []);
    });
  });

  test('browser leaving during creation hangs the new call up', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const provider = fakeProvider({
      async start(sdp) {
        provider.calls.start.push(sdp);
        entered();
        await gate;
        return { id: CALL_ID, sdp: ANSWER };
      },
    });
    await withServer(provider, async (port) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/voice/calls', headers: { ...GOOD, 'content-length': Buffer.byteLength(OFFER) }, agent: false });
      req.on('error', () => {});
      req.end(OFFER);
      await started;
      req.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      for (let i = 0; i < 50 && provider.calls.hangup.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(provider.calls.hangup, [CALL_ID]);
    });
  });

  test('logs contain neither SDP nor credentials', async () => {
    const logs = [];
    await withServer(fakeProvider(), async (port) => {
      await start(port);
      await start(port, { headers: { authorization: basic('team', 'nope-nope-nope-nope') } });
    }, { logs });
    const text = JSON.stringify(logs);
    for (const secret of [API_KEY, DEMO_PASSWORD, 'IN IP4', ANSWER.slice(0, 12), Buffer.from(`team:${DEMO_PASSWORD}`).toString('base64')]) {
      assert.ok(!text.includes(secret), secret);
    }
  });
});

describe('POST /api/voice/calls/{id}/hangup', () => {
  test('204 with no body, and repeating it is fine', async () => {
    const provider = fakeProvider();
    await withServer(provider, async (port) => {
      for (let i = 0; i < 2; i += 1) {
        const res = await hangup(port, CALL_ID, { authorization: TEAM_AUTH, origin: ORIGIN });
        assert.equal(res.status, 204);
        assert.equal(res.text, '');
      }
      assert.deepEqual(provider.calls.hangup, [CALL_ID, CALL_ID]);
    });
  });

  test('auth, origin, method, body and id are enforced before the provider', async () => {
    const provider = fakeProvider();
    await withServer(provider, async (port) => {
      assert.equal((await hangup(port, CALL_ID, { origin: ORIGIN })).status, 401);
      assert.equal((await hangup(port, CALL_ID, { authorization: TEAM_AUTH })).status, 403);
      assert.equal((await hangup(port, CALL_ID, { authorization: TEAM_AUTH, origin: 'https://evil.example' })).status, 403);
      assert.equal((await hangup(port, CALL_ID, { ...GOOD, 'sec-fetch-site': 'cross-site' })).status, 403);
      const get = await request(port, { path: `/api/voice/calls/${CALL_ID}/hangup`, headers: GOOD });
      assert.equal(get.status, 405);
      const withBody = await request(port, { method: 'POST', path: `/api/voice/calls/${CALL_ID}/hangup`, headers: GOOD, body: 'x' });
      assert.equal(withBody.status, 413);
      for (const id of ['abc', 'rtc_', 'rtc_a%2Fb', 'rtc_a.b', 'x_abcdef', `rtc_${'a'.repeat(140)}`]) {
        assert.equal((await hangup(port, id, { authorization: TEAM_AUTH, origin: ORIGIN })).status, 400, id);
      }
      assert.deepEqual(provider.calls.hangup, []);
    });
  });

  test('provider failure is a safe 502', async () => {
    const provider = fakeProvider({
      async hangup() {
        throw Object.assign(new Error(`body with ${API_KEY}`), { status: 500 });
      },
    });
    await withServer(provider, async (port) => {
      const res = await hangup(port, CALL_ID, { authorization: TEAM_AUTH, origin: ORIGIN });
      assert.equal(res.status, 502);
      assert.ok(!res.text.includes(API_KEY));
    });
  });
});

describe('shutdown', () => {
  test('drain waits for a call being created, then shuts the provider down; new calls get 503', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const provider = fakeProvider({
      async start(sdp) {
        provider.calls.start.push(sdp);
        entered();
        await gate;
        return { id: CALL_ID, sdp: ANSWER };
      },
    });
    await withServer(provider, async (port, server) => {
      const pending = start(port);
      await started;
      let drained = false;
      const drain = server.drain().then(() => {
        drained = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(drained, false);
      assert.equal(provider.calls.shutdown, 0);
      assert.equal((await start(port)).status, 503);
      release();
      assert.equal((await pending).status, 503, 'do not hand a browser the SDP of a call being hung up');
      await drain;
      assert.equal(provider.calls.shutdown, 1);
    });
  });
});

describe('shutdown outcome', () => {
  for (const [name, outcome, clean] of [
    ['all hung up', { hungUp: true, uncertain: false }, true],
    ['unconfirmed known call', { hungUp: false, uncertain: false }, false],
    ['id-less reservation', { hungUp: true, uncertain: true }, false],
    ['no answer at all', undefined, false],
  ]) {
    test(`${name}: clean=${clean}`, async () => {
      const provider = fakeProvider({ async shutdown() { return outcome; } });
      await withServer(provider, async (_port, server) => {
        assert.equal((await server.drain()).clean, clean);
      });
    });
  }
});
