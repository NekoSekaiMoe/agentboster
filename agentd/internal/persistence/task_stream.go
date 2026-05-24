package persistence

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/clawless/agentd/internal/clawless"
)

// StreamOutputRequest is the payload sent to ClawLess for streaming output.
type StreamOutputRequest struct {
	TaskID         string `json:"task_id"`
	SessionID      string `json:"session_id"`
	Output         string `json:"output"`
	StreamPosition int64  `json:"stream_position"`
	Timestamp      string `json:"timestamp"`
}

// TaskStreamer streams command output back to ClawLess.
type TaskStreamer struct {
	mu         sync.Mutex
	clawless   *clawless.Client
	taskID     string
	sessionID  string
	buffer     []byte
	position   int64
	ticker     *time.Ticker
	stopCh     chan struct{}
	doneCh     chan struct{}
}

// NewTaskStreamer creates a new task output streamer.
func NewTaskStreamer(clawlessClient *clawless.Client, taskID, sessionID string) *TaskStreamer {
	return &TaskStreamer{
		clawless:  clawlessClient,
		taskID:    taskID,
		sessionID: sessionID,
		buffer:    make([]byte, 0, 65536),
		stopCh:    make(chan struct{}),
		doneCh:    make(chan struct{}),
	}
}

// Write appends output to the buffer and flushes periodically.
func (ts *TaskStreamer) Write(output string) {
	ts.mu.Lock()
	ts.buffer = append(ts.buffer, []byte(output)...)
	ts.mu.Unlock()
}

// Start begins the periodic flush loop.
func (ts *TaskStreamer) Start(ctx context.Context, interval time.Duration) {
	ts.ticker = time.NewTicker(interval)
	go func() {
		defer close(ts.doneCh)
		for {
			select {
			case <-ts.ticker.C:
				ts.Flush(ctx)
			case <-ts.stopCh:
				ts.Flush(ctx) // final flush
				return
			case <-ctx.Done():
				ts.Flush(ctx) // final flush
				return
			}
		}
	}()
}

// Stop halts the flush loop.
func (ts *TaskStreamer) Stop() {
	close(ts.stopCh)
	<-ts.doneCh
}

// Flush sends buffered output to ClawLess.
func (ts *TaskStreamer) Flush(ctx context.Context) {
	ts.mu.Lock()
	if len(ts.buffer) == 0 {
		ts.mu.Unlock()
		return
	}
	output := string(ts.buffer)
	ts.buffer = ts.buffer[:0]
	pos := ts.position
	ts.position += int64(len(output))
	ts.mu.Unlock()

	req := StreamOutputRequest{
		TaskID:         ts.taskID,
		SessionID:      ts.sessionID,
		Output:         output,
		StreamPosition: pos,
		Timestamp:      time.Now().UTC().Format(time.RFC3339),
	}

	body, err := json.Marshal(req)
	if err != nil {
		slog.Warn("task stream: marshal failed", "task_id", ts.taskID, "error", err)
		return
	}

	ts.mu.Lock()
	client := ts.clawless
	ts.mu.Unlock()

	if client == nil {
		return
	}

	sendCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(sendCtx, http.MethodPost,
		fmt.Sprintf("%s/api/agentd/v1/tasks/%s/stream-output", client.BaseURL, ts.taskID),
		bytes.NewReader(body))
	if err != nil {
		slog.Warn("task stream: request creation failed", "task_id", ts.taskID, "error", err)
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-API-Key", client.APIKey)

	resp, err := client.HTTPClient.Do(httpReq)
	if err != nil {
		slog.Warn("task stream: send failed", "task_id", ts.taskID, "error", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		slog.Warn("task stream: non-ok response", "task_id", ts.taskID, "status", resp.StatusCode)
	}
}
