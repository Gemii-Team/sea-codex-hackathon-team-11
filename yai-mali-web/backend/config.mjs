// Runtime configuration for the Yai Mali origin.
//
// Every value arrives through the environment. Anything missing or malformed aborts startup
// with the variable *names* that failed, never their values.
import { isIP } from 'node:net';

export const REQUIRED_ENV = ['PUBLIC_ORIGIN', 'OPENAI_API_KEY', 'VOICE_CUTOFF_AT'];
export const DEFAULT_STATE_DIR = '/var/lib/team-voice';

const API_KEY = /^[\x21-\x7e]{20,512}$/;
// Date and time with an explicit zone; a bare local time would silently depend on the host.
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
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

  const apiKey = value('OPENAI_API_KEY');
  if (apiKey !== undefined && !API_KEY.test(apiKey)) {
    problem('OPENAI_API_KEY', 'must be 20-512 visible ASCII characters with no whitespace');
  }

  const cutoffRaw = value('VOICE_CUTOFF_AT');
  let cutoffAt;
  if (cutoffRaw !== undefined) {
    const ms = ISO_DATETIME.test(cutoffRaw) ? Date.parse(cutoffRaw) : Number.NaN;
    if (Number.isNaN(ms)) problem('VOICE_CUTOFF_AT', 'must be an ISO 8601 datetime with a Z or numeric offset');
    else cutoffAt = ms; // Unix epoch milliseconds, as createVoiceProvider requires
  }

  let stateDir = DEFAULT_STATE_DIR;
  if (env.VOICE_STATE_DIR !== undefined && env.VOICE_STATE_DIR !== '') {
    stateDir = env.VOICE_STATE_DIR;
    if (!stateDir.startsWith('/') || stateDir.includes('\0')) problem('VOICE_STATE_DIR', 'must be an absolute path');
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

  const config = { port, host, publicOrigin, apiKey, cutoffAt, stateDir };
  // Guard against `JSON.stringify(config)` ending up in a log line.
  Object.defineProperty(config, 'toJSON', {
    enumerable: false,
    value: () => ({ port, host, publicOrigin, cutoffAt: new Date(cutoffAt).toISOString(), stateDir }),
  });
  return Object.freeze(config);
}
