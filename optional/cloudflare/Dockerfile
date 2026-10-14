# Build context: repository root. This is an intentionally disabled integration image.
# No credentials, .env files, host identity, generated facets, or agent memories copied.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY bridge ./bridge
COPY optional/cloudflare/container-entry.mjs ./container-entry.mjs
USER node
CMD ["node", "container-entry.mjs"]
