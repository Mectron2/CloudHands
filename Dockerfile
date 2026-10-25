FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

# Install search tools up front so Pi does not need runtime downloads.
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates fd-find git ripgrep \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    MCP_CWD=/workspace \
    MCP_STATE_DIR=/var/lib/cloudhands \
    MCP_ALLOWED_HOSTS=localhost,127.0.0.1,[::1] \
    PI_OFFLINE=1

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /workspace /var/lib/cloudhands \
    && chown node:node /workspace /var/lib/cloudhands \
    && chmod 700 /var/lib/cloudhands

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
