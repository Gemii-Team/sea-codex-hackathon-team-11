// HS256 JWT for the Amazon Connect communications widget.
//
// AWS (optional-widget-steps.html): algorithm HS256; claims `sub` = widgetId, `iat`, and `exp`
// (10 minutes at most). `iat`/`exp` are NumericDate: integer seconds since the Unix epoch.
import { createHmac } from 'node:crypto';

const TOKEN_TTL_SECONDS = 60;

const base64url = (value) => Buffer.from(value).toString('base64url');

/**
 * `signingKey` is the 44-character widget security key used *literally*: the HMAC key is its
 * UTF-8 bytes. It is deliberately not base64-decoded.
 */
export function signWidgetToken({ widgetId, signingKey, nowSeconds }) {
  if (typeof widgetId !== 'string' || widgetId === '') throw new TypeError('widgetId is required');
  if (typeof signingKey !== 'string' || signingKey === '') throw new TypeError('signingKey is required');
  if (!Number.isInteger(nowSeconds) || nowSeconds <= 0 || nowSeconds >= 1e11) {
    throw new TypeError('nowSeconds must be integer Unix seconds (not milliseconds)');
  }
  const header = base64url(JSON.stringify({ typ: 'JWT', alg: 'HS256' }));
  const payload = base64url(JSON.stringify({ sub: widgetId, iat: nowSeconds, exp: nowSeconds + TOKEN_TTL_SECONDS }));
  const signature = createHmac('sha256', signingKey).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}
