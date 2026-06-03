# Production image for the marudesk relay (Bridge Model B).
#
# The relay runs its TypeScript directly via Node's built-in type stripping
# (--experimental-strip-types) — there is NO build step — and its only runtime
# dependency is `ws`. TLS is terminated by the Caddy sidecar (docker-compose.yml);
# this image speaks plain HTTP on $PORT behind it.
FROM node:22-alpine

WORKDIR /app

# Install ONLY production deps (just `ws`) for a small, reproducible image. The
# `typescript`/@types packages are devDependencies and are NOT needed at runtime —
# Node strips types natively.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (node_modules / relay-data excluded via .dockerignore).
COPY . .

# Persisted account store — mount a named volume here in compose so accounts
# survive container restarts/redeploys.
RUN mkdir -p /data && chown -R node:node /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8788 \
    DATA_DIR=/data

EXPOSE 8788
USER node

# Mirrors `npm start`. JWT_SECRET (>= 32 bytes) MUST be supplied at runtime, or
# the relay refuses to boot in this production/non-loopback posture.
CMD ["node", "--experimental-strip-types", "src/index.ts"]
