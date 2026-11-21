# Build context is yai-mali-web/ itself (not the repo root): `docker build yai-mali-web`.
#
# Base: Node.js 26 "Lithium" LTS on Alpine, pinned to the multi-arch index digest (linux/amd64 and
# linux/arm64) resolved on 2026-11-21. Override NODE_IMAGE to use a mirrored copy of the same image.
ARG NODE_IMAGE=node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
FROM ${NODE_IMAGE}

ENV NODE_ENV=production
WORKDIR /app

# The app has no dependencies, so package managers are not needed at runtime.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

# .dockerignore admits only backend/ and frontend/ (assets/ included), never .env, never tests.
# The server reads every regular file under frontend/ once at startup, so nothing else is needed.
COPY backend/ backend/
COPY frontend/ frontend/
RUN chmod -R a+rX,go-w /app

# Secrets and widget identifiers are runtime environment only; nothing is baked into the image.
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["node", "backend/healthcheck.mjs"]
CMD ["node", "backend/server.mjs"]
