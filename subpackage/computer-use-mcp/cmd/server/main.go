package main

import (
	"context"
	"encoding/json"
	"fmt"
	_ "image/gif"  // register GIF decoder so clipboard.WriteImage normalizes GIF input to PNG
	_ "image/jpeg" // register JPEG decoder so clipboard.WriteImage normalizes JPEG input to PNG
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/nekisekaimoe/agentboster/subpackages/computer-use-mcp/pkg/capability"
	"github.com/nekisekaimoe/agentboster/subpackages/computer-use-mcp/pkg/escape"
	"github.com/nekisekaimoe/agentboster/subpackages/computer-use-mcp/pkg/input"
	"github.com/nekisekaimoe/agentboster/subpackages/computer-use-mcp/pkg/lock"
	"github.com/nekisekaimoe/agentboster/subpackages/computer-use-mcp/pkg/screenshot"
)

var (
	lastScreenshotResult   *screenshot.Result
	inputController        *input.Controller
	keyboardOnlyController *input.Controller
)

// accessibilityClient is declared in accessibility_client.go and lazily
// initialized through ensureAccessibilityClient (sync.Once-guarded).

func main() {
	// Acquire session lock
	homeDir, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to resolve home directory: %v\n", err)
		os.Exit(1)
	}
	lockPath := filepath.Join(homeDir, ".config", "agentboster-cli", "computer-use.lock")
	sessionLock, err := lock.New(lockPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to acquire session lock: %v\n", err)
		os.Exit(1)
	}

	// Shared shutdown function to prevent double-release
	var shutdownOnce sync.Once
	doShutdown := func() {
		shutdownOnce.Do(func() {
			sessionLock.Release()
		})
	}
	defer doShutdown()

	// Setup escape hook
	escapeHook := escape.New(func() {
		fmt.Fprintf(os.Stderr, "Emergency stop: Escape key pressed\n")
		doShutdown()
		os.Exit(0)
	})
	if err := escapeHook.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: Failed to start escape hook: %v\n", err)
	}
	defer escapeHook.Stop()

	// Setup signal handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigChan
		fmt.Fprintf(os.Stderr, "Received shutdown signal\n")
		escapeHook.Stop()
		doShutdown()
		os.Exit(0)
	}()

	// Detect capabilities
	caps := capability.Detect()

	// Create MCP server
	s := server.NewMCPServer(
		"computer-use-mcp",
		"0.1.0",
	)

	// Register screenshot tool (always available if display exists)
	if caps.HasDisplay {
		registerClipboardTools(s)
		registerRecorderTools(s)

		s.AddTool(mcp.Tool{
			Name:        "screenshot",
			Description: "Capture the screen. Returns a scaled image (default JPEG quality 80 — 5-10x smaller than PNG with negligible vision loss; pass format=\"png\" for pixel-perfect output).",
			InputSchema: mcp.ToolInputSchema{
				Type: "object",
				Properties: map[string]interface{}{
					"max_width": map[string]interface{}{
						"type":        "integer",
						"description": "Max width in pixels (default: 1400)",
					},
					"monitor_index": map[string]interface{}{
						"type":        "integer",
						"description": "Monitor index (default: primary)",
					},
					"format": map[string]interface{}{
						"type":        "string",
						"enum":        []string{"png", "jpeg"},
						"description": "Image format. Default: jpeg",
					},
					"quality": map[string]interface{}{
						"type":        "integer",
						"description": "JPEG quality 1-100. Ignored for png. Default: 80",
					},
				},
			},
		}, handleScreenshot)

		// Register input tools if accessibility is granted
		if caps.AccessibilityGranted {
			registerInputTools(s)
			registerAccessibilityTools(s)
		}
	}

	// Start server on stdio
	if err := server.ServeStdio(s); err != nil {
		fmt.Fprintf(os.Stderr, "Server error: %v\n", err)
		os.Exit(1)
	}
}

// screenshotArgs mirrors the screenshot tool's input schema. The optional
// integer fields are pointers so an omitted key stays nil (defaults applied
// downstream) rather than collapsing to a meaningful zero.
type screenshotArgs struct {
	MaxWidth     *int   `json:"max_width"`
	MonitorIndex *int   `json:"monitor_index"`
	Format       string `json:"format"`
	Quality      *int   `json:"quality"`
}

func handleScreenshot(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var args screenshotArgs
	if err := request.BindArguments(&args); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	maxWidth := args.MaxWidth
	monitorIndex := args.MonitorIndex

	format := screenshot.FormatJPEG
	if args.Format != "" {
		format = screenshot.ParseFormat(args.Format)
	}

	quality := 80
	if args.Quality != nil {
		quality = *args.Quality
	}

	// TODO: Read allow_terminal_edit from session settings
	excludeTerminals := true

	result, err := screenshot.CaptureAndScale(maxWidth, monitorIndex, excludeTerminals, format, quality)
	if err != nil {
		return nil, fmt.Errorf("screenshot failed: %w", err)
	}

	// Build response
	meta := map[string]interface{}{
		"nativeSize":    result.NativeSize,
		"scaledSize":    result.ScaledSize,
		"scaleFactor":   result.ScaleFactor,
		"monitorOrigin": result.MonitorOrigin,
		"monitorIndex":  result.MonitorIndex,
		"format":        map[screenshot.Format]string{screenshot.FormatPNG: "png", screenshot.FormatJPEG: "jpeg"}[result.Format],
	}

	metaJSON, _ := json.Marshal(meta)

	// Store for input coordinate mapping
	lastScreenshotResult = result
	if inputController == nil || inputController.CoordMapper() == nil {
		inputController, _ = input.NewWithOrigin(result.ScaleFactor, result.MonitorOrigin[0], result.MonitorOrigin[1])
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{
				Type: "text",
				Text: string(metaJSON),
			},
			mcp.ImageContent{
				Type:     "image",
				Data:     result.ImageBase64,
				MIMEType: result.Format.MIME(),
			},
		},
	}, nil
}

func registerInputTools(s *server.MCPServer) {
	// Register mouse tools
	s.AddTool(mcp.Tool{
		Name:        "mouse_move",
		Description: "Move the mouse cursor to absolute (x, y) coordinates in screenshot-scaled space.",
		InputSchema: mcp.ToolInputSchema{
			Type: "object",
			Properties: map[string]any{
				"x": map[string]any{
					"type":        "number",
					"description": "X coordinate in screenshot space",
				},
				"y": map[string]any{
					"type":        "number",
					"description": "Y coordinate in screenshot space",
				},
			},
			Required: []string{"x", "y"},
		},
	}, handleMouseMove)

	s.AddTool(mcp.Tool{
		Name:        "mouse_click",
		Description: "Click at (x, y) with specified button. Optionally double-click.",
		InputSchema: mcp.ToolInputSchema{
			Type: "object",
			Properties: map[string]any{
				"x": map[string]any{
					"type":        "number",
					"description": "X coordinate in screenshot space",
				},
				"y": map[string]any{
					"type":        "number",
					"description": "Y coordinate in screenshot space",
				},
				"button": map[string]any{
					"type":        "string",
					"enum":        []string{"left", "right", "middle"},
					"description": "Mouse button. Default: left",
				},
				"double": map[string]any{
					"type":        "boolean",
					"description": "Double-click. Default: false",
				},
			},
			Required: []string{"x", "y"},
		},
	}, handleMouseClick)

	s.AddTool(mcp.Tool{
		Name:        "mouse_drag",
		Description: "Drag from (from_x, from_y) to (to_x, to_y).",
		InputSchema: mcp.ToolInputSchema{
			Type: "object",
			Properties: map[string]any{
				"from_x": map[string]any{
					"type":        "number",
					"description": "Start X coordinate",
				},
				"from_y": map[string]any{
					"type":        "number",
					"description": "Start Y coordinate",
				},
				"to_x": map[string]any{
					"type":        "number",
					"description": "End X coordinate",
				},
				"to_y": map[string]any{
					"type":        "number",
					"description": "End Y coordinate",
				},
			},
			Required: []string{"from_x", "from_y", "to_x", "to_y"},
		},
	}, handleMouseDrag)

	// Register keyboard tools
	s.AddTool(mcp.Tool{
		Name:        "type_text",
		Description: "Type a string of text.",
		InputSchema: mcp.ToolInputSchema{
			Type: "object",
			Properties: map[string]any{
				"text": map[string]any{
					"type":        "string",
					"description": "Text to type",
				},
			},
			Required: []string{"text"},
		},
	}, handleTypeText)

	s.AddTool(mcp.Tool{
		Name:        "key_event",
		Description: "Press a key with optional modifiers.",
		InputSchema: mcp.ToolInputSchema{
			Type: "object",
			Properties: map[string]any{
				"key": map[string]any{
					"type":        "string",
					"description": "Key name (e.g., 'a', 'Return', 'Ctrl', 'F1')",
				},
				"direction": map[string]any{
					"type":        "string",
					"enum":        []string{"press", "release", "click"},
					"description": "Key direction. 'click' = press+release. Default: click",
				},
				"modifiers": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"description": "Modifier keys (e.g., ['Ctrl', 'Shift'])",
				},
			},
			Required: []string{"key"},
		},
	}, handleKeyEvent)
}
