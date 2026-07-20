package main

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/yourusername/computer-use-mcp-go/pkg/input"
)

func handleMouseMove(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	argsMap, ok := request.Params.Arguments.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("invalid arguments type")
	}

	x, _ := argsMap["x"].(float64)
	y, _ := argsMap["y"].(float64)

	if inputController == nil {
		return nil, fmt.Errorf("no screenshot taken yet - cannot map coordinates")
	}

	if err := inputController.MouseMove(x, y); err != nil {
		return nil, err
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{
				Type: "text",
				Text: fmt.Sprintf("Moved mouse to (%.1f, %.1f)", x, y),
			},
		},
	}, nil
}

func handleMouseClick(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	argsMap, ok := request.Params.Arguments.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("invalid arguments type")
	}

	x, _ := argsMap["x"].(float64)
	y, _ := argsMap["y"].(float64)
	button, _ := argsMap["button"].(string)
	if button == "" {
		button = "left"
	}
	double, _ := argsMap["double"].(bool)

	if inputController == nil {
		return nil, fmt.Errorf("no screenshot taken yet - cannot map coordinates")
	}

	if err := inputController.MouseClick(x, y, button, double); err != nil {
		return nil, err
	}

	action := "Clicked"
	if double {
		action = "Double-clicked"
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{
				Type: "text",
				Text: fmt.Sprintf("%s %s button at (%.1f, %.1f)", action, button, x, y),
			},
		},
	}, nil
}

func handleMouseDrag(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	argsMap, ok := request.Params.Arguments.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("invalid arguments type")
	}

	fromX, _ := argsMap["from_x"].(float64)
	fromY, _ := argsMap["from_y"].(float64)
	toX, _ := argsMap["to_x"].(float64)
	toY, _ := argsMap["to_y"].(float64)

	if inputController == nil {
		return nil, fmt.Errorf("no screenshot taken yet - cannot map coordinates")
	}

	if err := inputController.MouseDrag(fromX, fromY, toX, toY); err != nil {
		return nil, err
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{
				Type: "text",
				Text: fmt.Sprintf("Dragged from (%.1f, %.1f) to (%.1f, %.1f)", fromX, fromY, toX, toY),
			},
		},
	}, nil
}

func handleTypeText(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	argsMap, ok := request.Params.Arguments.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("invalid arguments type")
	}

	text, _ := argsMap["text"].(string)

	if inputController == nil {
		// Initialize a basic controller without coordinate mapping for keyboard-only ops
		inputController, _ = input.New(1.0)
	}

	if err := inputController.TypeText(text); err != nil {
		return nil, err
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{
				Type: "text",
				Text: fmt.Sprintf("Typed %d characters", len(text)),
			},
		},
	}, nil
}

func handleKeyEvent(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	argsMap, ok := request.Params.Arguments.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("invalid arguments type")
	}

	key, _ := argsMap["key"].(string)
	direction, _ := argsMap["direction"].(string)
	if direction == "" {
		direction = "click"
	}

	if inputController == nil {
		inputController, _ = input.New(1.0)
	}

	// Handle modifiers if present
	if modifiersRaw, ok := argsMap["modifiers"]; ok {
		if modifiersList, ok := modifiersRaw.([]interface{}); ok && len(modifiersList) > 0 {
			modifiers := make([]string, len(modifiersList))
			for i, m := range modifiersList {
				modifiers[i], _ = m.(string)
			}
			if err := inputController.KeyCombo(key, modifiers); err != nil {
				return nil, err
			}
			return &mcp.CallToolResult{
				Content: []mcp.Content{
					mcp.TextContent{
						Type: "text",
						Text: fmt.Sprintf("Pressed %v+%s", modifiers, key),
					},
				},
			}, nil
		}
	}

	// Simple key event
	if err := inputController.KeyEvent(key, direction); err != nil {
		return nil, err
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{
				Type: "text",
				Text: fmt.Sprintf("Key %s: %s", direction, key),
			},
		},
	}, nil
}
