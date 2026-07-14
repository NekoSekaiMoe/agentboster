# syntax=docker/dockerfile:1
# The syntax directive enables BuildKit features (RUN --mount=type=secret),
# used below to feed docker.env into `next build` without baking it into a layer.

# Stage 1: Dependencies
FROM node:22-alpine AS deps

WORKDIR /app

# Install dependencies needed for native modules
RUN apk add --no-cache libc6-compat python3 make g++

# Copy package files
COPY package.json yarn.lock* ./

# Install dependencies with frozen lockfile
RUN yarn install --frozen-lockfile --production=false

# Stage 2: Builder
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY . .

# Set build-time environment variables
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Build Next.js application.
# `yarn build` runs `next build` (incl. withWorkflow compilation). Next.js
# auto-loads `.env` from the working dir, so we mount docker.env there as a
# BuildKit secret for the duration of this RUN only: it lives on a tmpfs and is
# never written to an image layer, so AUTH_SECRET / model keys / S3 creds do NOT
# ship in the image. Runtime env is supplied separately via compose `env_file`.
# Requires BuildKit (DOCKER_BUILDKIT=1, default with `docker compose build`).
RUN --mount=type=secret,id=docker_env,target=/app/.env,required=true \
    yarn build

# Stage 3: Runner
FROM node:22-alpine AS runner

WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache \
    postgresql-client \
    curl \
    tini

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Set environment
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Copy necessary files for runtime
COPY --from=builder /app/next.config.ts ./
COPY --from=builder /app/package.json ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules

# Copy database scripts and schema for migrations
COPY --from=builder /app/lib/core/db ./lib/core/db
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts

# Make the startup script executable, then set ownership.
RUN chmod +x /app/scripts/docker-entrypoint.sh && chown -R nextjs:nodejs /app

USER nextjs

# Expose port
EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/', (r) => {process.exit(r.statusCode === 200 || r.statusCode === 307 ? 0 : 1)})"

# Use tini to handle signals properly
ENTRYPOINT ["/sbin/tini", "--"]

# Run self-host DB migrations (idempotent), then start the Next.js server.
# Set SKIP_DB_MIGRATE=1 to bypass migrations for read-replica / multi-instance
# rollouts where a single migration job runs separately.
CMD ["/app/scripts/docker-entrypoint.sh"]
