// Dependency-free readiness probe for the container: exits 0 only if this container's own
// /healthz answers 200 {"status":"ok"}. It needs no credentials and prints nothing.
//
//   docker compose exec connect-web-call node backend/healthcheck.mjs
const port = process.env.PORT || '8080';
try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    redirect: 'error',
    signal: AbortSignal.timeout(3_000),
  });
  const body = await response.json();
  process.exit(response.status === 200 && body?.status === 'ok' ? 0 : 1);
} catch {
  process.exit(1);
}
