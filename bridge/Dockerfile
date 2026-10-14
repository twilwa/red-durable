FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY bridge ./bridge
USER node
ENV RED_BRIDGE_DIR=/home/node/.config/red-durable-bridge
CMD ["node", "bridge/cli.mjs", "run"]
