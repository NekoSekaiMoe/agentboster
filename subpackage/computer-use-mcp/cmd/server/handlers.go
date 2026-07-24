package main

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/nekisekaimoe/agentboster/subpackages/computer-use-mcp/pkg/capability"
	"github.com/nekisekaimoe/agentboster/subpackages/computer-use-mcp/pkg/input"
)

// Argument structs for each input tool. mcp-go's BindArguments unmarshals the
// JSON-RPC params into these via a marshal/unmarshal round-trip, so the field
// types (float64 for JSON numbers, []string for arrays) match what the wire
// delivers — no manual `argsMap[k].(float64)` assertions, and a malformed
// payload surfaces as a bind error instead of a silent zero value.
type (
	mouseMoveArgs struct {
		X float64 `json:"x"`
		Y float64 `json:"y"`
	}

	mouseClickArgs struct {
		X      float64 `json:"x"`
		Y      float64 `json:"y"`
		Button string  `json:"button"`
		Double bool    `json:"double"`
	}

	mouseDragArgs struct {
		FromX float64 `json:"from_x"`
		FromY float64 `json:"from_y"`
		ToX   float64 `json:"to_x"`
		ToY   float64 `json:"to_y"`
	}

	typeTextArgs struct {
		Text string `json:"text"`
	}

	keyEventArgs struct {
		Key       string   `json:"key"`
		Direction string   `json:"direction"`
		Modifiers []string `json:"modifiers"`
	}
)

// ensureKeyboardController lazily builds the keyboard-only input controller,
// initialized with the detected display scale. Shared by the text and key
// handlers, which previously duplicated this block.
func ensureKeyboardController() *input.Controller {
	if keyboardOnlyController == nil {
		caps := capability.Detect()
		scale := caps.ScaleFactor
		if scale == 0 {
			scale = 1.0
		}
		keyboardOnlyController, _ = input.New(scale)
	}
	return keyboardOnlyController
}

func handleMouseMove(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var args mouseMoveArgs
	if err := request.BindArguments(&args); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	if inputController == nil {
		return nil, fmt.Errorf("no screenshot taken yet - cannot map coordinates")
	}

	if err := inputController.MouseMove(args.X, args.Y); err != nil {
		return nil, err
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{
				Type: "text",
				Text: fmt.Sprintf("Moved mouse to (%.1f, %.1f)", args.X, args.Y),
			},
		},
	}, nil
}

func handleMouseClick(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var args mouseClickArgs
	if err := request.BindArguments(&args); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if args.Button == "" {
		args.Button = "left"
	}

	if inputController == nil {
		return nil, fmt.Errorf("no screenshot taken yet - cannot map coordinates")
	}

	if err := inputController.MouseClick(args.X, args.Y, args.Button, args.Double); err != nil {
		return nil, err
	}

	action := "Clicked"
	if args.Double {
		action = "Double-clicked"
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{
				Type: "text",
				Text: fmt.Sprintf("%s %s button at (%.1f, %.1f)", action, args.Button, args.X, args.Y),
			},
		},
	}, nil
}

func handleMouseDrag(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var args mouseDragArgs
	if err := request.BindArguments(&args); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	if inputController == nil {
		return nil, fmt.Errorf("no screenshot taken yet - cannot map coordinates")
	}

	if err := inputController.MouseDrag(args.FromX, args.FromY, args.ToX, args.ToY); err != nil {
		return nil, err
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{
				Type: "text",
				Text: fmt.Sprintf("Dragged from (%.1f, %.1f) to (%.1f, %.1f)", args.FromX, args.FromY, args.ToX, args.ToY),
			},
		},
	}, nil
}

func handleTypeText(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var args typeTextArgs
	if err := request.BindArguments(&args); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}

	if err := ensureKeyboardController().TypeText(args.Text); err != nil {
		return nil, err
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{
				Type: "text",
				Text: fmt.Sprintf("Typed %d characters", len(args.Text)),
			},
		},
	}, nil
}

func handleKeyEvent(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var args keyEventArgs
	if err := request.BindArguments(&args); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if args.Direction == "" {
		args.Direction = "click"
	}

	kbd := ensureKeyboardController()

	// Modifiers present → treat as a key combo (e.g. Ctrl+C).
	if len(args.Modifiers) > 0 {
		if err := kbd.KeyCombo(args.Key, args.Modifiers); err != nil {
			return nil, err
		}
		return &mcp.CallToolResult{
			Content: []mcp.Content{
				mcp.TextContent{
					Type: "text",
					Text: fmt.Sprintf("Pressed %v+%s", args.Modifiers, args.Key),
				},
			},
		}, nil
	}

	// Simple key event
	if err := kbd.KeyEvent(args.Key, args.Direction); err != nil {
		return nil, err
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{
				Type: "text",
				Text: fmt.Sprintf("Key %s: %s", args.Direction, args.Key),
			},
		},
	}, nil
}
