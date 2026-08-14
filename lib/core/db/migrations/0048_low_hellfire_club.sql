CREATE INDEX CONCURRENTLY "messages_trace_run_created_idx" ON "messages" USING btree (("payload"->'metadata'->>'runId'),"created_at") WHERE ("messages"."payload"->'metadata'->>'runId') IS NOT NULL;
