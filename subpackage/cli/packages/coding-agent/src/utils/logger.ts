/**
 * Lightweight server-side logger for the coding-agent package.
 *
 * Wraps `console.*` so logs surface in the terminal / Web backend logs.
 * Avoid pulling in any external dependency — this package ships as a
 * standalone CLI binary.
 */

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta) return '';
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return '';
  }
}

export function createLogger(scope: string): Logger {
  return {
    debug(message, meta) {
      console.debug(`[${scope}] ${message}${formatMeta(meta)}`);
    },
    info(message, meta) {
      console.info(`[${scope}] ${message}${formatMeta(meta)}`);
    },
    warn(message, meta) {
      console.warn(`[${scope}] ${message}${formatMeta(meta)}`);
    },
    error(message, meta) {
      console.error(`[${scope}] ${message}${formatMeta(meta)}`);
    },
  };
}
