package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/nekisekaimoe/agentboster/subpackages/computer-use-mcp/pkg/recorder"
)

// currentRecording holds the in-progress recording session across MCP calls,
// so that one tools/call starts it and a second tools/call stops it and
// fetches the GIF. The recorder package additionally enforces only one active
// session at a time.
var currentRecording *recorder.Session

func registerRecorderTools(s *server.MCPServer) {
	s.AddTool(mcp.Tool{
		Name:        "screen_record_start",
		Description: "Start capturing the screen as an animated GIF. Returns immediately with a session id and metadata; pair with screen_record_stop to obtain the GIF. Only one recording may be active at a time. The recording also self-terminates when its duration elapses.",
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

func handleScreenRecordStart(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	cfg := recorder.DefaultConfig()

	argsMap, _ := request.Params.Arguments.(map[string]any)
	if v, ok := argsMap["duration_seconds"].(float64); ok && v > 0 {
		cfg.Duration = time.Duration(v*1000) * time.Millisecond
	}
	if v, ok := argsMap["fps"].(float64); ok && v > 0 {
		cfg.FPS = int(v)
	}
	if v, ok := argsMap["max_width"].(float64); ok && v > 0 {
		cfg.MaxWidth = int(v)
	}
	if v, ok := argsMap["monitor_index"].(float64); ok {
		cfg.MonitorIndex = int(v)
	}
	if v, ok := argsMap["exclude_terminals"].(bool); ok {
		cfg.ExcludeTerminals = v
	}

	session, err := recorder.Start(cfg)
	if err != nil {
		return nil, fmt.Errorf("screen_record_start: %w", err)
	}
	currentRecording = session

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
	if currentRecording == nil {
		return nil, fmt.Errorf("no recording in progress; call screen_record_start first")
	}
	session := currentRecording
	currentRecording = nil

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
