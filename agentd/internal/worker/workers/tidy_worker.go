package workers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/clawless/agentd/internal/agent"
	"github.com/clawless/agentd/internal/clawless"
)

const tidyPromptTemplate = `You are a Task Summary Analyzer. Review the following long-running task summary and suggest improvements.

## Current Task Summary
Progress: {{progress}}
Decisions ({{decision_count}}):
{{decisions}}

Pending items ({{pending_count}}):
{{pending}}

Known issues ({{issue_count}}):
{{issues}}

## Rules
- Identify duplicate or near-duplicate decisions that could be merged
- Flag pending items that appear to be completed based on the progress text
- Flag known issues that appear to be resolved based on the progress text
- Do NOT suggest deleting anything — only flag items for user review
- If no improvements are needed, return an empty suggestions array

## Output format (JSON only):
{"suggestions": ["<suggestion 1>", "<suggestion 2>"], "merge_ids": ["<decision_id>"], "delete_ids": ["<decision_id>"], "resolved_pending": ["<item text>"], "resolved_issues": ["<item text>"]}`

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
	summary, err := client.GetTaskSummary(ctx, taskID)
	if err != nil {
		return fmt.Errorf("get summary: %w", err)
	}

	if summary.Status != "active" {
		return nil
	}

	// Build the analysis prompt
	prompt := buildTidyPrompt(summary)

	req := clawless.LLMProxyRequest{
		Model: "default",
		Messages: []clawless.Message{
			{Role: "system", Content: "You analyze task summaries. Respond only with JSON."},
			{Role: "user", Content: prompt},
		},
		Stream: false,
	}

	respData, err := client.LLMProxyRequest(ctx, &req)
	if err != nil {
		return fmt.Errorf("LLM proxy: %w", err)
	}

	var report clawless.TaskTidyReport
	text := string(respData)
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start >= 0 && end > start {
		if err := json.Unmarshal([]byte(text[start:end+1]), &report); err != nil {
			return fmt.Errorf("parse tidy report: %w", err)
		}
	}

	if len(report.Suggestions) == 0 {
		slog.Info("task tidy: no suggestions", "task_id", taskID)
		return nil
	}

	// Send notification with tidy suggestions
	report.TaskID = taskID
	notification := map[string]any{
		"type":         "tidy_report",
		"task_id":      taskID,
		"title":        "Task Summary Tidy Report",
		"suggestions":  report.Suggestions,
		"merge_ids":    report.MergeIDs,
		"delete_ids":   report.DeleteIDs,
		"summary":      "Your task summary has been reviewed. Here are suggestions for cleanup.",
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

func buildTidyPrompt(summary *clawless.TaskSummary) string {
	var decisions strings.Builder
	for i, d := range summary.Decisions {
		decisions.WriteString(fmt.Sprintf("%d. [%s] %s (Reason: %s)\n", i+1, d.Timestamp.Format("2006-01-02"), d.Description, d.Reason))
	}

	var pending strings.Builder
	for _, p := range summary.Pending {
		pending.WriteString(fmt.Sprintf("- %s\n", p))
	}

	var issues strings.Builder
	for _, i := range summary.KnownIssues {
		issues.WriteString(fmt.Sprintf("- %s\n", i))
	}

	prompt := tidyPromptTemplate
	prompt = strings.ReplaceAll(prompt, "{{progress}}", summary.Progress)
	prompt = strings.ReplaceAll(prompt, "{{decision_count}}", fmt.Sprintf("%d", len(summary.Decisions)))
	prompt = strings.ReplaceAll(prompt, "{{decisions}}", decisions.String())
	prompt = strings.ReplaceAll(prompt, "{{pending_count}}", fmt.Sprintf("%d", len(summary.Pending)))
	prompt = strings.ReplaceAll(prompt, "{{pending}}", pending.String())
	prompt = strings.ReplaceAll(prompt, "{{issue_count}}", fmt.Sprintf("%d", len(summary.KnownIssues)))
	prompt = strings.ReplaceAll(prompt, "{{issues}}", issues.String())

	return prompt
}
