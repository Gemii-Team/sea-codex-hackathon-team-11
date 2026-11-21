FROM node:26-alpine
RUN apk add --no-cache aws-cli && mkdir /data && chown node:node /data
WORKDIR /app
COPY demo/*.mjs demo/
COPY contracts/ contracts/
USER node
CMD ["node", "demo/portal.mjs"]
