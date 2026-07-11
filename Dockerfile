# Stage 1 — build everything with dev deps, then prune.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# Stage 2 — runtime: server serves the built client on one port.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
USER node

# The workspace symlink node_modules/@walkietalkie/shared -> ../shared
# survives the copy, so shared/dist + shared/package.json must ride along.
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/shared/package.json shared/
COPY --from=build --chown=node:node /app/shared/dist shared/dist
COPY --from=build --chown=node:node /app/server/package.json server/
COPY --from=build --chown=node:node /app/server/dist server/dist
COPY --from=build --chown=node:node /app/client/dist client/dist

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/dist/index.js"]
