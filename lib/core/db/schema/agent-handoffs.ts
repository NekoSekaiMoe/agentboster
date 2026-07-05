import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * agentHandoffs: a durable named-pipe / mailbox for cross-session and
 * cross-workflow agent collaboration.
 *
 * Phase B of the multi-agent collaboration design. Barriers (phase A)
 * coordinate N participants synchronously; handoffs let one agent leave
 * a message for another agent to pick up later, possibly in a different
 * workflow run, session, or Vercel instance.
 *
 * Semantics:
 *   - `put` inserts a row keyed by `(fromSessionId, key)`. The optional
 *     `toSessionId` targets a specific recipient session; when null the
 *     row is broadcast (any taker can claim it).
 *   - `take` is a destructive read: returns the oldest matching row and
 *     deletes it. Use `peek` for a non-destructive look.
 *   - `barrierId` optionally links the handoff to a barrier so a
 *     coordinator can release() the barrier from a different process
 *     once the handoff has been consumed (or produced).
 *
 * Why a separate table from agentBarriers: barriers are one-shot
 * (terminal after release); handoffs are a continuous stream of named
 * messages. Conflating the two would force the barrier schema to grow
 * a variable-length collection of messages and complicate its single
 * responsibility (release-condition evaluation).
 *
 * Lifetime: rows are NOT auto-expired. Callers that want TTL semantics
 * should pair the handoff with a barrier whose expiresAt enforces the
 * deadline and use a sweeper (not yet implemented; phase C-full may
 * add one if real-world usage shows rows accumulating).
 */
export const agentHandoffs = pgTable(
  'agent_handoffs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    fromSessionId: uuid('from_session_id'),
    /** Recipient session. Null = broadcast (any taker may claim). */
    toSessionId: uuid('to_session_id'),
    /** Optional workflow run that produced this handoff. */
    runId: text('run_id'),
    /** Optional link to a barrier (phase A) so a remote process can
     *  signal completion via release() after consuming the handoff. */
    barrierId: text('barrier_id'),
    /** Logical name within a session, e.g. "research_result". Takers
     *  filter by key; (fromSessionId, key) is the canonical lookup
     *  pair. Multiple rows with the same key are FIFO-ordered by id. */
    key: text('key').notNull(),
    payload: jsonb('payload').$type<unknown>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Primary access pattern: "what messages for key K are waiting for
    // session S?" — drives take/peek.
    index('agent_handoffs_to_key_idx').on(table.toSessionId, table.key),
    // Secondary: "what did session S emit under key K?" — for audits
    // and the barrier release callback.
    index('agent_handoffs_from_key_idx').on(table.fromSessionId, table.key),
    // Barrier callback: find every handoff linked to a barrier.
    index('agent_handoffs_barrier_idx').on(table.barrierId),
  ],
);

export type AgentHandoff = typeof agentHandoffs.$inferSelect;
export type NewAgentHandoff = typeof agentHandoffs.$inferInsert;
