# Stage 1: Dependencies
FROM alpine:latest AS deps

WORKDIR /app

# Install dependencies needed for native modules
RUN apk add --no-cache nodejs yarn libc6-compat python3 make g++

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

# Copy Docker environment into the filename Next.js loads automatically.
ARG DOCKER_ENV_FILE=docker.env
RUN if [ ! -f "$DOCKER_ENV_FILE" ]; then \
        echo "Missing $DOCKER_ENV_FILE. Copy docker.env.example to docker.env before docker build."; \
        exit 1; \
    fi && \
    cp "$DOCKER_ENV_FILE" .env

# Set build-time environment variables
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Build Next.js application
# Note: yarn build runs `next build` which includes withWorkflow compilation
RUN yarn build

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
COPY --from=builder /app/.env ./.env
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules

# Copy database scripts and schema for migrations
COPY --from=builder /app/lib/core/db ./lib/core/db
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts

# Set ownership
RUN chown -R nextjs:nodejs /app

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

# Start the application with next start
CMD ["yarn", "start"]
