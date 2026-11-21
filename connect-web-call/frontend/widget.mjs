// DOM-free logic for the AWS-managed Amazon Connect web-calling widget.
//
// Imported by the browser (call.js) and by the Node backend (config.mjs), so there is one
// definition of what counts as the official widget URL and of the widget's identifiers.
//
// What this follows (AWS Connect Administrator Guide, checked 2026-11-21):
//  - The embed snippet is an IIFE that injects a <script> and creates the `amazon_connect`
//    command queue, then queues `styles`, `snippetId`, `supportedMessagingContentTypes` and,
//    with widget security on, `authenticate`.
//      config-com-widget1.html, supported-snippet-fields.html, optional-widget-steps.html
//  - The loader URL for a managed instance is
//    https://<instance-alias>.my.connect.aws/connectwidget/static/amazon-connect-chat-interface-client.js
//      programmatic-chat-disconnect.html (prints the full hosted loader URL; the other pages print
//      the snippet only as an image or with a relative ./ path)
//  - `authenticate` receives a callback; the documented example passes `data.data` (the JWT
//    string) to it. The JWT `sub` is the widget ID (the second argument of the IIFE and the
//    <script> element id), NOT the `snippetId`.
//      add-chat-to-website.html, optional-widget-steps.html
//
// The generated snippet's exact bytes are only available from the Connect admin console, so the
// public fields (URL, widget ID, snippet ID) arrive as runtime configuration.

const WIDGET_SCRIPT_HOST_SUFFIX = '.my.connect.aws';
const WIDGET_SCRIPT_PATH = '/connectwidget/static/amazon-connect-chat-interface-client.js';

const CONFIG_PATH = '/api/widget-config';
const TOKEN_PATH = '/api/widget-token';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNIPPET_ID = /^[A-Za-z0-9+/_=-]{16,4096}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const JWT_SHAPE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}$/;

// Button colours in the documented `styles` shape, in the team portal palette. `iconType` is
// omitted on purpose: AWS documents only CHAT and CHAT_VOICE (the sample snippet image), and
// nothing public documents a value for an audio-only launcher. Which channels the widget offers
// is decided by the widget configuration behind `snippetId`; this object only styles the button.
export const WIDGET_STYLES = Object.freeze({
  openChat: Object.freeze({ color: '#ffffff', backgroundColor: '#152b25' }),
  closeChat: Object.freeze({ color: '#ffffff', backgroundColor: '#152b25' }),
});

const fail = (reason) => ({ ok: false, reason });

/**
 * Accepts only the documented hosted-widget loader URL: https, one DNS label (the instance
 * alias) under my.connect.aws, the exact documented path, no port/credentials/query/fragment,
 * and the canonical (lower-case, normalised) form so no look-alike survives parsing.
 */
export function parseWidgetScriptUrl(value) {
  if (typeof value !== 'string' || value === '') return fail('is required');
  let url;
  try {
    url = new URL(value);
  } catch {
    return fail('is not a valid URL');
  }
  if (url.href !== value) return fail('must be in canonical form (lower-case host, no trailing characters)');
  if (url.protocol !== 'https:') return fail('must use https');
  if (url.username || url.password) return fail('must not contain credentials');
  if (url.port) return fail('must not specify a port');
  if (url.search || url.hash) return fail('must not have a query or fragment');
  if (url.pathname !== WIDGET_SCRIPT_PATH) return fail(`must have the path ${WIDGET_SCRIPT_PATH}`);
  if (!url.hostname.endsWith(WIDGET_SCRIPT_HOST_SUFFIX)) {
    return fail(`must be an https://<instance-alias>${WIDGET_SCRIPT_HOST_SUFFIX} URL`);
  }
  const alias = url.hostname.slice(0, -WIDGET_SCRIPT_HOST_SUFFIX.length);
  if (!DNS_LABEL.test(alias)) return fail('must have exactly one instance-alias label before my.connect.aws');
  return { ok: true, url: value };
}

/** The widget ID is the UUID in the embed script (second IIFE argument); it is the JWT `sub`. */
export const isWidgetId = (value) => typeof value === 'string' && UUID.test(value);

/** The snippet ID is the opaque base64-style string passed to amazon_connect('snippetId', ...). */
export const isSnippetId = (value) => typeof value === 'string' && SNIPPET_ID.test(value);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class WidgetRequestError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'WidgetRequestError';
    this.status = status;
  }
}

/** Public widget configuration as served by GET /api/widget-config; secrets never appear here. */
export function readWidgetConfig(body) {
  if (!isPlainObject(body)) throw new WidgetRequestError('The call configuration was not a JSON object.');
  const script = parseWidgetScriptUrl(body.scriptUrl);
  if (!script.ok) throw new WidgetRequestError(`The widget script URL ${script.reason}.`);
  if (!isWidgetId(body.widgetId)) throw new WidgetRequestError('The widget ID is missing or malformed.');
  if (!isSnippetId(body.snippetId)) throw new WidgetRequestError('The snippet ID is missing or malformed.');
  if (body.widgetId === body.snippetId) {
    throw new WidgetRequestError('The widget ID and the snippet ID must be different values.');
  }
  return { scriptUrl: script.url, widgetId: body.widgetId, snippetId: body.snippetId };
}

/** Truthful, user-facing text for a failed token request; `status` is null for network errors. */
export function describeTokenFailure(status) {
  if (status === 401) return 'Team sign-in is missing or expired. Reload this page and sign in as "team".';
  if (status === 403) return 'The token service refused this page\u2019s origin. Open the site at its official address.';
  if (status === 429) return 'Too many call attempts in the last minute. Wait a minute, then try again.';
  if (status === null) return 'Could not reach the token service (network error or unexpected redirect). Try again.';
  if (status >= 500) return 'The token service failed. Try again in a moment.';
  return `The token service answered unexpectedly (HTTP ${status}).`;
}

async function requestToken(fetchImpl) {
  let response;
  try {
    response = await fetchImpl(TOKEN_PATH, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error', // a redirect must fail the request, never carry the credentials elsewhere
    });
  } catch {
    throw new WidgetRequestError(describeTokenFailure(null));
  }
  if (response.status !== 200) throw new WidgetRequestError(describeTokenFailure(response.status), response.status);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new WidgetRequestError('The token service returned an unreadable response.', response.status);
  }
  const data = isPlainObject(body) ? body.data : undefined;
  if (typeof data !== 'string' || !JWT_SHAPE.test(data)) {
    throw new WidgetRequestError('The token service returned an unexpected response.', response.status);
  }
  return data;
}

/**
 * Builds the function for amazon_connect('authenticate', ...). It adapts the documented example
 * (GET /token) to a same-origin POST and hands AWS only the `data` string. Events carry no token.
 * On any failure the AWS callback gets an empty string (the documented example passes
 * `undefined` for a missing token); AWS then refuses the call, and we report the real reason.
 */
export function createAuthenticate({ fetch: fetchImpl, onEvent }) {
  return function authenticate(callback) {
    onEvent({ type: 'token-requested', at: new Date() });
    requestToken(fetchImpl).then(
      (token) => {
        onEvent({ type: 'token-issued', at: new Date() });
        callback(token);
      },
      (error) => {
        onEvent({ type: 'token-failed', at: new Date(), status: error.status ?? null, message: error.message });
        callback('');
      },
    );
  };
}

/** GET /api/widget-config with the same no-cache, no-redirect, same-origin rules as the token. */
export async function fetchWidgetConfig(fetchImpl) {
  let response;
  try {
    response = await fetchImpl(CONFIG_PATH, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
  } catch {
    throw new WidgetRequestError('Could not reach the server for the call configuration (network error or unexpected redirect).');
  }
  if (response.status === 401) {
    throw new WidgetRequestError('Team sign-in is required. Reload this page and sign in as "team".', 401);
  }
  if (response.status !== 200) {
    throw new WidgetRequestError(`The server could not provide the call configuration (HTTP ${response.status}).`, response.status);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new WidgetRequestError('The call configuration was unreadable.', response.status);
  }
  return readWidgetConfig(body);
}

/**
 * Runs the documented embed snippet for a validated configuration. Nothing here starts a call:
 * the widget only shows its button, and a call begins when the user chooses it (no
 * customLaunchBehavior / auto-launch is queued). `onLoad` means only that the loader script was
 * fetched and ran; it does not mean the widget is available.
 */
export function installWidgetLoader({ window: w, document: d, config, authenticate, onLoad, onError }) {
  const script = parseWidgetScriptUrl(config.scriptUrl);
  if (!script.ok) throw new Error(`widget script URL ${script.reason}`);
  if (!isWidgetId(config.widgetId)) throw new Error('widget ID is missing or malformed');
  if (!isSnippetId(config.snippetId)) throw new Error('snippet ID is missing or malformed');
  if (config.widgetId === config.snippetId) throw new Error('widget ID and snippet ID must differ');

  // The documented IIFE: (function(w, d, x, id){ ... })(window, document, 'amazon_connect', '<widgetId>')
  (function (win, doc, x, id) {
    const s = doc.createElement('script');
    s.src = script.url;
    s.async = true;
    s.id = id;
    s.addEventListener('load', onLoad);
    s.addEventListener('error', onError);
    doc.getElementsByTagName('head')[0].appendChild(s);
    win[x] =
      win[x] ||
      function () {
        (win[x].ac = win[x].ac || []).push(arguments);
      };
  })(w, d, 'amazon_connect', config.widgetId);

  const amazonConnect = w.amazon_connect;
  amazonConnect('styles', structuredClone(WIDGET_STYLES));
  amazonConnect('snippetId', config.snippetId);
  amazonConnect('supportedMessagingContentTypes', ['text/plain', 'text/markdown']);
  amazonConnect('authenticate', authenticate);
}
