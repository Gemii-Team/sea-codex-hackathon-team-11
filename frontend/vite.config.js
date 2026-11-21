import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const phoneTarget = 'http://127.0.0.1:8783';
const phonePage = /^\/phone-demo\/(?:\?.*)?$/;
const phoneAssets = /^\/(?:app\.js|style\.css)(?:\?.*)?$/;
const phoneApi = /^\/api\/(?:status|calls(?:\/[\w-]+\/finish)?|history(?:\/[\w-]+)?|evidence\/[\w-]+)(?:\?.*)?$/;
const localAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const phoneLoopback = {
  name: 'phone-demo-loopback',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (![phonePage, phoneAssets, phoneApi].some((route) => route.test(req.url ?? ''))) return next();
      const { host, origin } = req.headers;
      const expectedOrigin = 'http://' + host;
      if (localAddresses.has(req.socket.remoteAddress) && /^(?:localhost|127\.0\.0\.1):\d+$/.test(host ?? '') &&
          (!origin || origin === expectedOrigin) && (req.method !== 'POST' || origin === expectedOrigin)) return next();
      res.writeHead(403, { 'Cache-Control': 'no-store' });
      res.end('The locally integrated phone demo requires a same-origin localhost request.');
    });
  },
};

export default defineConfig({
  plugins: [svelte(), phoneLoopback],
  server: {
    proxy: {
      [phonePage.source]: {
        target: phoneTarget,
        changeOrigin: true,
        rewrite: () => '/',
        configure(proxy) {
          proxy.on('proxyRes', (response) => {
            const policy = response.headers['content-security-policy'];
            if (typeof policy === 'string') {
              response.headers['content-security-policy'] = policy.replace("frame-ancestors 'none'", "frame-ancestors 'self'");
            }
          });
        },
      },
      [phoneAssets.source]: { target: phoneTarget, changeOrigin: true },
      [phoneApi.source]: {
        target: phoneTarget,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (upstream, req) => {
            if (req.method === 'POST') upstream.setHeader('Origin', phoneTarget);
          });
        },
      },
      '/api': 'http://127.0.0.1:8080',
    }
  }
});
