-- P3.3: per-sandbox cgroup v2 aggregates for resource-aware node selection.
-- Rolled up in the heartbeat handler from per-sandbox samples sent by agentd.
-- All three default to NULL — NodeSelector treats NULL as "no cgroup data"
-- and falls back to host-level metrics.
ALTER TABLE "agentd_nodes" ADD COLUMN "sandbox_mem_current_total" integer;--> statement-breakpoint
ALTER TABLE "agentd_nodes" ADD COLUMN "sandbox_mem_peak_total" integer;--> statement-breakpoint
ALTER TABLE "agentd_nodes" ADD COLUMN "sandbox_cpu_usec_total" integer;
