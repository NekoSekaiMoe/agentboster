package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/nekisekaimoe/agentboster/subpackages/computer-use-mcp/pkg/recorder"
)

// recordingMu guards currentRecording across the start/stop MCP tool calls.
// The MCP server may dispatch tools/call concurrently; without this a
// start writing and a stop reading currentRecording would race.
var (
	recordingMu      sync.Mutex
	currentRecording *recorder.Session
)

func registerRecorderTools(s *server.MCPServer) {
	s.AddTool(mcp.Tool{
		Name:        "screen_record_start",
		Description: "Start capturing the screen as an animated GIF. Returns immediately with recording metadata; pair with screen_record_stop to obtain the GIF. Only one recording may be active at a time. The recording also self-terminates when its duration elapses.",
		InputSchema: mcp.ToolInputSchema{
			Type: "object",
			Properties: map[string]any{
				"duration_seconds": map[string]any{
					"type":        "number",
					"description": "Recording length in seconds. Default 15; hard cap 60.",
				},
				"fps": map[string]any{
					"type":        "integer",
					"description": "Frames per second. Default 4; higher values inflate GIF size rapidly; cap 10.",
				},
				"max_width": map[string]any{
					"type":        "integer",
					"description": "Frame width cap (aspect preserved). Default 800.",
				},
				"monitor_index": map[string]any{
					"type":        "integer",
					"description": "Display to capture (0 = primary). Default 0.",
				},
				"exclude_terminals": map[string]any{
					"type":        "boolean",
					"description": "Black out terminal windows in each frame (safety). Default true.",
				},
			},
		},
	}, handleScreenRecordStart)

	s.AddTool(mcp.Tool{
		Name:        "screen_record_stop",
		Description: "Stop the in-progress screen recording and return the encoded animated GIF as base64. Errors if no recording is active or if zero frames were captured.",
		InputSchema: mcp.ToolInputSchema{
			Type:       "object",
			Properties: map[string]any{},
		},
	}, handleScreenRecordStop)
}

// recordStartArgs mirrors the screen_record_start input schema. ExcludeTerminals
// is a pointer so an omitted key preserves the DefaultConfig() value (true)
// instead of a JSON-zero false silently disabling terminal masking.
type recordStartArgs struct {
	DurationSeconds  float64 `json:"duration_seconds"`
	FPS              int     `json:"fps"`
	MaxWidth         int     `json:"max_width"`
	MonitorIndex     int     `json:"monitor_index"`
	ExcludeTerminals *bool   `json:"exclude_terminals"`
}

func handleScreenRecordStart(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	cfg := recorder.DefaultConfig()

	var args recordStartArgs
	if err := request.BindArguments(&args); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if args.DurationSeconds > 0 {
		cfg.Duration = time.Duration(args.DurationSeconds*1000) * time.Millisecond
	}
	if args.FPS > 0 {
		cfg.FPS = args.FPS
	}
	if args.MaxWidth > 0 {
		cfg.MaxWidth = args.MaxWidth
	}
	cfg.MonitorIndex = args.MonitorIndex
	if args.ExcludeTerminals != nil {
		cfg.ExcludeTerminals = *args.ExcludeTerminals
	}

	session, err := recorder.Start(cfg)
	if err != nil {
		return nil, fmt.Errorf("screen_record_start: %w", err)
	}
	recordingMu.Lock()
	currentRecording = session
	recordingMu.Unlock()

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{
				Type: "text",
				Text: fmt.Sprintf(`{"status": "recording", "duration_seconds": %.1f, "fps": %d, "max_width": %d, "monitor_index": %d, "exclude_terminals": %v}`,
					cfg.Duration.Seconds(), cfg.FPS, cfg.MaxWidth, cfg.MonitorIndex, cfg.ExcludeTerminals),
			},
		},
	}, nil
}

func handleScreenRecordStop(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	recordingMu.Lock()
	if currentRecording == nil {
		recordingMu.Unlock()
		return nil, fmt.Errorf("no recording in progress; call screen_record_start first")
	}
	session := currentRecording
	currentRecording = nil
	recordingMu.Unlock()

	gifBytes, err := session.GIF() // GIF() calls Stop() internally if still running
	if err != nil {
		return nil, fmt.Errorf("screen_record_stop: %w", err)
	}

	frameCount := session.FrameCount()
	b64 := base64.StdEncoding.EncodeToString(gifBytes)

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{
				Type: "text",
				Text: fmt.Sprintf(`{"format": "gif", "frames": %d, "size_bytes": %d, "mime": "image/gif"}`, frameCount, len(gifBytes)),
			},
			mcp.ImageContent{
				Type:     "image",
				Data:     b64,
				MIMEType: "image/gif",
			},
		},
	}, nil
}
