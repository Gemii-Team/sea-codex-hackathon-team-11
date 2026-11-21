// Tests for frontend/widget.mjs (the logic behind the browser page). Loaded by server.test.mjs;
// also runnable alone: node --test connect-web-call/backend/widget.test.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WIDGET_STYLES,
  WidgetRequestError,
  createAuthenticate,
  describeTokenFailure,
  fetchWidgetConfig,
  installWidgetLoader,
  isSnippetId,
  isWidgetId,
  parseWidgetScriptUrl,
  readWidgetConfig,
} from '../frontend/widget.mjs';

const SCRIPT_URL = 'https://team-11-call.my.connect.aws/connectwidget/static/amazon-connect-chat-interface-client.js';
const WIDGET_ID = '3f1c2a9e-8b7d-4c3a-9e21-5d6f7a8b9c0d';
const SNIPPET_ID = 'QVFJREFIZml4dHVyZS1zbmlwcGV0LWlkLW5vdC10aGUtd2lkZ2V0LWlk';
// JWT-shaped (the known-answer vector from server.test.mjs); never a real credential.
const TOKEN =
  'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIzZjFjMmE5ZS04YjdkLTRjM2EtOWUyMS01ZDZmN2E4YjljMGQiLCJpYXQiOjE3OTUyNTUyMDAsImV4cCI6MTc5NTI1NTI2MH0.S5NhQeYj0mR_fNBFXpJHBptIf3q6wU7LuiU7LX6ZxH0';

const GOOD_CONFIG = Object.freeze({ scriptUrl: SCRIPT_URL, widgetId: WIDGET_ID, snippetId: SNIPPET_ID });

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function fakeBrowser() {
  const head = { children: [], appendChild(element) { this.children.push(element); return element; } };
  const created = [];
  const document = {
    createElement(tag) {
      const element = { tag, listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } };
      created.push(element);
      return element;
    },
    getElementsByTagName() {
      return [head];
    },
  };
  return { window: {}, document, head, created };
}

/** Runs authenticate once and returns what AWS's callback received plus the events emitted. */
async function runAuthenticate(handler) {
  const events = [];
  const authenticate = createAuthenticate({ fetch: fakeFetch(handler), onEvent: (event) => events.push(event) });
  const received = [];
  await new Promise((resolve) => authenticate((...args) => { received.push(args); resolve(); }));
  return { events, received };
}

describe('official widget script URL', () => {
  test('accepts the documented hosted-widget loader for an instance alias', () => {
    assert.deepEqual(parseWidgetScriptUrl(SCRIPT_URL), { ok: true, url: SCRIPT_URL });
  });

  // One representative per rule: scheme, domain, host suffix trick, extra label, query, path.
  const REJECTED = {
    'plain http': SCRIPT_URL.replace('https://', 'http://'),
    'third-party CDN': 'https://d1234abcd.cloudfront.net/amazon-connect-chat-interface-client.js',
    'look-alike host suffix': 'https://team-11-call.my.connect.aws.attacker.example/connectwidget/static/amazon-connect-chat-interface-client.js',
    'nested subdomain': 'https://a.b.my.connect.aws/connectwidget/static/amazon-connect-chat-interface-client.js',
    'query string': `${SCRIPT_URL}?v=1`,
    'other script path': SCRIPT_URL.replace('amazon-connect-chat-interface-client.js', 'other.js'),
  };
  for (const [name, value] of Object.entries(REJECTED)) {
    test(`rejects ${name}`, () => {
      assert.equal(parseWidgetScriptUrl(value).ok, false);
    });
  }
});

describe('widget configuration', () => {
  test('the widget ID (UUID) and the snippet ID are different kinds of value', () => {
    assert.equal(isWidgetId(WIDGET_ID), true);
    assert.equal(isWidgetId(SNIPPET_ID), false);
    assert.equal(isSnippetId(SNIPPET_ID), true);
  });

  test('readWidgetConfig accepts good input and refuses a foreign URL or equal IDs', () => {
    assert.deepEqual(readWidgetConfig(GOOD_CONFIG), GOOD_CONFIG);
    assert.throws(() => readWidgetConfig({ ...GOOD_CONFIG, scriptUrl: 'https://evil.example/x.js' }), WidgetRequestError);
    assert.throws(() => readWidgetConfig({ ...GOOD_CONFIG, snippetId: WIDGET_ID }), WidgetRequestError);
  });

  test('fetchWidgetConfig reads with no-cache, no-redirect, same-origin rules', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(200, GOOD_CONFIG));
    assert.deepEqual(await fetchWidgetConfig(fetchImpl), GOOD_CONFIG);
    const { url, init } = fetchImpl.calls[0];
    assert.equal(url, '/api/widget-config');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.credentials, 'same-origin');
  });

  test('fetchWidgetConfig fails on a signed-out response and on an unsafe configuration', async () => {
    await assert.rejects(fetchWidgetConfig(fakeFetch(() => jsonResponse(401, {}))), WidgetRequestError);
    const unsafe = () => jsonResponse(200, { ...GOOD_CONFIG, scriptUrl: 'https://evil.example/x.js' });
    await assert.rejects(fetchWidgetConfig(fakeFetch(unsafe)), WidgetRequestError);
  });
});

describe('documented embed snippet', () => {
  test('runs the documented loader and queues the documented fields, without starting a call', () => {
    const { window, document, head, created } = fakeBrowser();
    const fetchSpy = fakeFetch(() => jsonResponse(200, { data: TOKEN }));
    const authenticate = createAuthenticate({ fetch: fetchSpy, onEvent: () => {} });
    const onLoad = () => {};
    const onError = () => {};

    installWidgetLoader({ window, document, config: GOOD_CONFIG, authenticate, onLoad, onError });

    assert.equal(created.length, 1);
    const [script] = created;
    assert.equal(script.tag, 'script');
    assert.equal(script.src, SCRIPT_URL);
    assert.equal(script.id, WIDGET_ID, 'the <script> id is the widget ID');
    assert.equal(script.async, true);
    assert.deepEqual(head.children, [script]);
    assert.equal(script.listeners.load, onLoad);
    assert.equal(script.listeners.error, onError);

    const queued = window.amazon_connect.ac.map((args) => Array.from(args));
    assert.deepEqual(
      queued.map(([name]) => name),
      ['styles', 'snippetId', 'supportedMessagingContentTypes', 'authenticate'],
    );
    const byName = Object.fromEntries(queued);
    assert.equal(byName.snippetId, SNIPPET_ID, 'snippetId carries the snippet ID, not the widget ID');
    assert.deepEqual(byName.styles, WIDGET_STYLES);
    assert.equal(byName.styles.iconType, 'VOICE', 'use the generated web-calling launcher');
    assert.equal(byName.authenticate, authenticate);
    assert.ok(!('customLaunchBehavior' in byName), 'no auto-launch: a call starts only from the widget');
    assert.equal(fetchSpy.calls.length, 0, 'installing the widget requests no token');
  });

  test('fails closed, creating nothing, for a foreign script URL or a widget ID equal to the snippet ID', () => {
    for (const config of [
      { ...GOOD_CONFIG, scriptUrl: 'https://evil.example/amazon-connect-chat-interface-client.js' },
      { ...GOOD_CONFIG, snippetId: WIDGET_ID },
    ]) {
      const { window, document, created } = fakeBrowser();
      assert.throws(() => installWidgetLoader({ window, document, config, authenticate: () => {} }), Error);
      assert.equal(created.length, 0, 'no script element may be created');
      assert.equal(window.amazon_connect, undefined, 'no command queue may be created');
    }
  });
});

describe('authenticate callback', () => {
  test('requests a same-origin POST and gives AWS only the data string', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(200, { data: TOKEN, extra: 'ignored' }));
    const events = [];
    const authenticate = createAuthenticate({ fetch: fetchImpl, onEvent: (event) => events.push(event) });
    const received = [];
    await new Promise((resolve) => authenticate((...args) => { received.push(args); resolve(); }));

    assert.deepEqual(received, [[TOKEN]], 'the callback is called once with exactly the JWT string');
    const { url, init } = fetchImpl.calls[0];
    assert.equal(url, '/api/widget-token');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error', 'a redirect must fail rather than follow');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.body, undefined);
    assert.deepEqual(events.map((event) => event.type), ['token-requested', 'token-issued']);
    assert.ok(!JSON.stringify(events).includes(TOKEN), 'events never carry the token');
  });

  for (const status of [401, 403, 429, 500]) {
    test(`HTTP ${status} is reported truthfully and AWS never receives a token`, async () => {
      const { events, received } = await runAuthenticate(() => jsonResponse(status, {}));
      assert.deepEqual(received, [['']]);
      const failure = events.at(-1);
      assert.equal(failure.type, 'token-failed');
      assert.equal(failure.status, status);
      assert.equal(failure.message, describeTokenFailure(status));
    });
  }

  test('a 200 response that is not a JWT is rejected', async () => {
    for (const respond of [() => jsonResponse(200, { data: 'not.a.jwt' }), () => new Response('<html>', { status: 200 })]) {
      const { events, received } = await runAuthenticate(respond);
      assert.deepEqual(received, [['']]);
      assert.equal(events.at(-1).type, 'token-failed');
    }
  });

  test('a network error or blocked redirect is reported as such', async () => {
    const { events, received } = await runAuthenticate(() => { throw new TypeError('redirect mode is set to error'); });
    assert.deepEqual(received, [['']]);
    assert.equal(events.at(-1).status, null);
    assert.equal(events.at(-1).message, describeTokenFailure(null));
  });
});
