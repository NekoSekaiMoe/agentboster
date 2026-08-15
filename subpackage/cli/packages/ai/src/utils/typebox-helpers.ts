import { type TUnsafe, Type } from 'typebox';

/**
 * Creates a string enum schema compatible with Google's API and other providers
 * that don't support anyOf/const patterns.
 *
 * Ported verbatim from upstream pi-ai (utils/typebox-helpers.ts) — extensions
 * such as @narumitw/pi-subagents build their tool parameter schemas with it.
 *
 * @example
 * const OperationSchema = StringEnum(["add", "subtract", "multiply", "divide"], {
 *   description: "The operation to perform"
 * });
 *
 * type Operation = Static<typeof OperationSchema>; // "add" | "subtract" | "multiply" | "divide"
 */
export function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: 'string',
    enum: values as any,
    ...(options?.description && { description: options.description }),
    // `!== undefined` (not truthiness) so an empty-string default survives.
    ...(options?.default !== undefined && { default: options.default }),
  });
}
