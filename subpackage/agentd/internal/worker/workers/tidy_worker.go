package workers

import (
	"context"
	"log/slog"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
)

// RunTaskTidy asks ClawLess to run the task-summary tidy scan.
// Called periodically by the dispatcher via EventTaskTidyTick.
func RunTaskTidy(ctx context.Context, client *clawless.Client) error {
	slog.Info("task tidy: delegating scan to ClawLess")
	return client.RunTaskSummaryTidy(ctx)
}
