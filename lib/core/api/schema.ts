import type { ZodType } from 'zod';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.schema');

export interface ParseOptions {
  /**
   * Endpoint/contract identifier used in the warning log so we can grep
   * for which contract drifted in production telemetry.
   */
  endpoint: string;
}

/**
 * Validate a JSON value (typically parsed from a fetch response) against a
 * zod schema, returning the parsed value on success or `fallback` on failure.
 *
 * On failure we log a warning with the endpoint and zod's structured error,
 * but never throw — the UI layer must keep rendering. This is the boundary
 * defense that turns "API contract drifted" (e.g. an installed CLI/Desktop
 * talking to a newer Web backend) from a white-screen incident into a
 * degraded-but-rendering page.
 *
 * The return type is anchored to `T` (inferred from `fallback`), not to the
 * schema's `z.infer` type. Schemas should be intentionally **lenient** —
 * string enums kept as `z.string()` so an unknown enum value still parses —
 * so the parsed runtime value can be wider than the strict TS type at the
 * call site. The caller asserts compatibility by typing the fallback to the
 * expected `T`; downstream code is already responsible for handling unknown
 * enum values via `default`-bearing switches and optional chaining.
 *
 * Ported from Multica (`ref/packages/core/api/schema.ts`). The Multica
 * `setSchemaLogger` pluggability is collapsed to `createLogger` — agentboster
 * already routes through the Vercel-friendly logger.
 *
 * @example
 *   const users = parseWithFallback(
 *     await res.json(),
 *     z.array(UserSchema),
 *     [],
 *     { endpoint: 'GET /api/auth/users' },
 *   );
 */
export function parseWithFallback<T>(
  data: unknown,
  schema: ZodType,
  fallback: T,
  opts: ParseOptions,
): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data as T;
  logger.warn('API response failed schema validation', {
    endpoint: opts.endpoint,
    issues: result.error.issues,
  });
  return fallback;
}
