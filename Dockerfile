# COVENANT gateway — multi-stage build.
#
# Stage 1 compiles better-sqlite3's native binding (needs python3/make/g++,
# which we don't want in the final image). Stage 2 ships only the compiled
# node_modules + source, on a slim base, as a non-root user.

FROM node:22-bookworm-slim AS build
WORKDIR /app/gateway

# better-sqlite3 needs a toolchain to compile its native binding.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY gateway/package.json gateway/package-lock.json ./
RUN npm ci --omit=dev

COPY gateway/ ./

FROM node:22-bookworm-slim AS run
WORKDIR /app/gateway
ENV NODE_ENV=production

RUN groupadd -r covenant && useradd -r -g covenant covenant

COPY --from=build /app/gateway /app/gateway
RUN mkdir -p /app/gateway/data && chown -R covenant:covenant /app/gateway

USER covenant

# Defaults; override at `docker run -e` or via docker-compose / .env.
ENV COVENANT_PORT=8792
ENV COVENANT_DB_PATH=/app/gateway/data/gateway.db
# Server defaults to binding 127.0.0.1 (correct for the bare-metal/tunnel
# deployment this was built for) — inside a container that's unreachable
# from the host even with -p mapped, so bind all interfaces here instead.
ENV COVENANT_HOST=0.0.0.0

EXPOSE 8792

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.COVENANT_PORT||8792) +'/x402/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
