// Type stub for the `typebox` package.
//
// The SDK declares `typebox` as an optional peer dependency because the
// CLI runtime injects the real module at extension load time via a
// virtual-module alias. This stub mirrors just enough of `Type`'s public
// surface for the SDK's `examples/` to type-check standalone (without
// typebox installed) — same pattern as vendor/core.d.ts for
// @agentboster-cli/core.
//
// REGEN INSTRUCTIONS:
//   When an example starts using a `Type.*` builder not listed below,
//   add its signature here. The runtime resolves the real typebox at
//   load; this stub is only for standalone type-check.
//
// Do NOT add real schema compilation logic here — typebox is the source
// of truth. The signatures below are intentionally permissive (return
// broad types) so consumers can tighten schemas in their own code.

export interface TypeboxSchema {
  [key: string]: unknown;
}

export const Type: {
  // ── Primitive builders ─────────────────────────────────────────
  String(options?: TypeboxSchema): TypeboxSchema;
  Number(options?: TypeboxSchema): TypeboxSchema;
  Boolean(options?: TypeboxSchema): TypeboxSchema;
  Null(options?: TypeboxSchema): TypeboxSchema;
  Literal<T extends string | number | boolean>(value: T, options?: TypeboxSchema): TypeboxSchema;
  Any(options?: TypeboxSchema): TypeboxSchema;
  Unknown(options?: TypeboxSchema): TypeboxSchema;

  // ── Composite builders ─────────────────────────────────────────
  Object<T extends Record<string, unknown>>(properties: T, options?: TypeboxSchema): TypeboxSchema;
  Array<T>(items: T, options?: TypeboxSchema): TypeboxSchema;
  Tuple<T extends unknown[]>(items: [...T], options?: TypeboxSchema): TypeboxSchema;
  Union<T extends unknown[]>(schemas: [...T], options?: TypeboxSchema): TypeboxSchema;
  Intersect<T extends unknown[]>(schemas: [...T], options?: TypeboxSchema): TypeboxSchema;
  Record<K extends TypeboxSchema, V>(key: K, value: V, options?: TypeboxSchema): TypeboxSchema;

  // ── Modifiers ──────────────────────────────────────────────────
  Optional<T>(schema: T): T & { modifier: 'Optional' };
  Readonly<T>(schema: T): T & { modifier: 'Readonly' };

  // ── Enum / refinement ──────────────────────────────────────────
  Enum<T extends Record<string, string | number>>(values: T, options?: TypeboxSchema): TypeboxSchema;
  Const<T>(value: T, options?: TypeboxSchema): TypeboxSchema;
};

export default Type;
