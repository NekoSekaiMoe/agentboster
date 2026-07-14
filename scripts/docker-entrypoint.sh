#!/bin/sh
# Docker entrypoint for the self-hosted web app.
#
# Runs database migrations (idempotent) before starting the Next.js server.
# On Vercel this script is unused — Vercel runs `postbuild` instead. Here we
# own the lifecycle, so migrations happen at container start, after the
# database is reachable (compose `depends_on` + healthcheck should gate this,
# but we also tolerate a not-yet-ready DB by failing loudly).
#
# Set SKIP_DB_MIGRATE=1 to bypass migrations (e.g. when a separate one-shot
# job owns schema management in a multi-replica deployment).
set -e

if [ "${SKIP_DB_MIGRATE}" = "1" ]; then
  echo "[entrypoint] SKIP_DB_MIGRATE=1 — skipping database migrations"
else
  echo "[entrypoint] running database migrations"
  # tsx is available via node_modules; run the self-host migration which does
  # ensure-vector + drizzle-kit push + message-version data migration.
  node_modules/.bin/tsx scripts/self-host-migrate.ts
fi

echo "[entrypoint] starting Next.js server"
exec yarn start
