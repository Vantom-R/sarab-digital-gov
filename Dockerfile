# One image for all backend services (Node 24 runs the TypeScript sources directly
# via type stripping). Each compose service picks its entrypoint with `command:`.
FROM node:24-alpine AS backend
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY packages ./packages
COPY services ./services
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1

# Ops container (backups, audit anchors, monitoring): the same code plus the Postgres 16 tools (pg_dump,
# and a throwaway server for restore tests) and age for encryption. Default user: overridden in compose.
FROM backend AS ops
USER root
RUN apk add --no-cache postgresql16 postgresql16-client age tar
USER node
