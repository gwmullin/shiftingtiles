# Multi-arch (amd64/arm64/...) image: node:24-slim is published for all major
# platforms, sharp installs the matching prebuilt libvips binary per arch, and
# TensorFlow.js runs on its WASM/CPU backend — no GPU, no native compilation.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/

ENV PHOTOS_DIR=/photos \
    CACHE_DIR=/data \
    PORT=8080

RUN mkdir -p /photos /data && chown -R node:node /photos /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8080}/healthz`).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "server.js"]
