// Runtime configuration for the connect-web-call origin.
//
// Every value arrives through the environment. Anything missing or malformed aborts startup
// with the variable *names* that failed, never their values. There are no defaults for the
// widget identifiers or for either secret.
import { isIP } from 'node:net';
import { isSnippetId, isWidgetId, parseWidgetScriptUrl } from '../frontend/widget.mjs';

export const REQUIRED_ENV = [
  'PUBLIC_ORIGIN',
  'WIDGET_SCRIPT_URL',
  'WIDGET_ID',
  'WIDGET_SNIPPET_ID',
  'WIDGET_SIGNING_KEY',
  'DEMO_PASSWORD',
];

const SIGNING_KEY = /^[\x21-\x7e]{44}$/; // Connect issues a 44-character key; it is used literally.
const DEMO_PASSWORD = /^[\x21-\x7e]{16,128}$/; // visible ASCII only, so Basic-auth encoding is unambiguous
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class ConfigError extends Error {
  constructor(problems) {
    super(`invalid configuration: ${problems.map((problem) => problem.name).join(', ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function parseOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== value) return null; // canonical origin only: no path, slash, userinfo, default port
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url.origin; // local development
  return null;
}

/** Validates an environment object and returns frozen configuration, or throws ConfigError. */
export function loadConfig(env) {
  const problems = [];
  const problem = (name, message) => problems.push({ name, message });
  const value = (name) => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') {
      problem(name, 'is required');
      return undefined;
    }
    return raw;
  };

  const origin = value('PUBLIC_ORIGIN');
  let publicOrigin;
  if (origin !== undefined) {
    publicOrigin = parseOrigin(origin);
    if (!publicOrigin) problem('PUBLIC_ORIGIN', 'must be an https origin with no path (http only for localhost)');
  }

  const scriptRaw = value('WIDGET_SCRIPT_URL');
  let scriptUrl;
  if (scriptRaw !== undefined) {
    const parsed = parseWidgetScriptUrl(scriptRaw);
    if (parsed.ok) scriptUrl = parsed.url;
    else problem('WIDGET_SCRIPT_URL', parsed.reason);
  }

  const widgetId = value('WIDGET_ID');
  if (widgetId !== undefined && !isWidgetId(widgetId)) {
    problem('WIDGET_ID', 'must be the widget ID UUID from the embed script');
  }

  const snippetId = value('WIDGET_SNIPPET_ID');
  if (snippetId !== undefined && !isSnippetId(snippetId)) {
    problem('WIDGET_SNIPPET_ID', 'must be the snippetId string from the embed script');
  }
  if (widgetId !== undefined && widgetId === snippetId) {
    problem('WIDGET_SNIPPET_ID', 'must differ from WIDGET_ID (the JWT subject is the widget ID, not the snippet ID)');
  }

  const signingKey = value('WIDGET_SIGNING_KEY');
  if (signingKey !== undefined && !SIGNING_KEY.test(signingKey)) {
    problem('WIDGET_SIGNING_KEY', 'must be the 44-character widget security key, with no whitespace');
  }

  const demoPassword = value('DEMO_PASSWORD');
  if (demoPassword !== undefined && !DEMO_PASSWORD.test(demoPassword)) {
    problem('DEMO_PASSWORD', 'must be 16-128 visible ASCII characters with no whitespace');
  }
  if (demoPassword !== undefined && demoPassword === signingKey) {
    problem('DEMO_PASSWORD', 'must not reuse the widget signing key');
  }

  let port = 8080;
  if (env.PORT !== undefined && env.PORT !== '') {
    port = /^\d{1,5}$/.test(env.PORT) ? Number(env.PORT) : 0;
    if (port < 1 || port > 65535) problem('PORT', 'must be an integer from 1 to 65535');
  }

  // Containers bind all interfaces; local development sets HOST=127.0.0.1.
  const host = env.HOST === undefined || env.HOST === '' ? '0.0.0.0' : env.HOST;
  if (!isIP(host)) problem('HOST', 'must be an IP address');

  if (problems.length > 0) throw new ConfigError(problems);

  const config = {
    port,
    host,
    publicOrigin,
    signingKey,
    demoPassword,
    widget: Object.freeze({ scriptUrl, id: widgetId, snippetId }),
  };
  // Guard against `JSON.stringify(config)` ending up in a log line.
  Object.defineProperty(config, 'toJSON', {
    enumerable: false,
    value: () => ({ port, host, publicOrigin, widget: { scriptUrl, id: widgetId, snippetId } }),
  });
  return Object.freeze(config);
}

/** The only widget fields the browser may receive. */
export function publicWidgetConfig(config) {
  return { scriptUrl: config.widget.scriptUrl, widgetId: config.widget.id, snippetId: config.widget.snippetId };
}
