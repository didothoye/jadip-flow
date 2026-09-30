# Jadip Flow — image de production (interface + API dans un seul conteneur)
FROM node:22-bookworm-slim AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim AS server
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data WEB_DIR=/app/web
RUN apt-get update && apt-get install -y --no-install-recommends tini curl && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data && chown node:node /data
WORKDIR /app/server
COPY --from=server --chown=node:node /build/server/node_modules ./node_modules
COPY --from=server --chown=node:node /build/server/dist ./dist
COPY --from=server --chown=node:node /build/server/migrations ./migrations
COPY --from=server --chown=node:node /build/server/package.json ./
COPY --from=web --chown=node:node /build/web/dist /app/web
COPY --chown=node:node tools/fake-n8n /app/tools/fake-n8n
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
