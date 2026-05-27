package workers

import (
	"context"
	"log/slog"
	"time"

	"github.com/clawless/agentd/internal/agent"
	"github.com/clawless/agentd/internal/clawless"
)

// RunTaskTidy scans active task summaries and generates tidy suggestions.
// Called periodically by the dispatcher via EventTaskTidyTick.
func RunTaskTidy(ctx context.Context, client *clawless.Client, _ *agent.Manager, taskIDs []string) error {
	slog.Info("task tidy: starting scan", "count", len(taskIDs))

	for _, taskID := range taskIDs {
		if err := tidyOneTask(ctx, client, taskID); err != nil {
			slog.Warn("task tidy: failed to tidy task", "task_id", taskID, "error", err)
			continue
		}
	}

	slog.Info("task tidy: scan complete", "scanned", len(taskIDs))
	return nil
}

func tidyOneTask(ctx context.Context, client *clawless.Client, taskID string) error {
	report, err := client.TidyTaskSummary(ctx, taskID)
	if err != nil {
		return err
	}

	if report == nil || len(report.Suggestions) == 0 {
		slog.Info("task tidy: no suggestions", "task_id", taskID)
		return nil
	}

	// Send notification with tidy suggestions
	notification := map[string]any{
		"type":                 "tidy_report",
		"task_id":              taskID,
		"title":                "Task Summary Tidy Report",
		"suggestions":          report.Suggestions,
		"summary_last_updated": report.SummaryLastUpdated.Format(time.RFC3339Nano),
		"merge_ids":            report.MergeIDs,
		"delete_ids":           report.DeleteIDs,
		"update_ids":           report.UpdateIDs,
		"resolved_pending":     report.ResolvedPending,
		"resolved_issues":      report.ResolvedIssues,
		"summary":              "Your task summary has been reviewed. Here are suggestions for cleanup.",
	}

	notifCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	err = client.PostJSON(notifCtx, "/api/agentd/v1/notifications/send", notification, nil)
	if err != nil {
		slog.Warn("task tidy: failed to send notification", "task_id", taskID, "error", err)
	}

	slog.Info("task tidy: suggestions generated", "task_id", taskID, "count", len(report.Suggestions))
	return nil
}
