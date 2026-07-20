package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/nekisekaimoe/agentboster/subpackages/computer-use-mcp/pkg/accessibility"
)

func registerAccessibilityTools(s *server.MCPServer) {
	// Register get_accessibility_tree tool
	s.AddTool(mcp.Tool{
		Name:        "get_accessibility_tree",
		Description: "Get the complete accessibility tree from the root element. Returns a hierarchical structure with role, name, description, bounding box, enabled/focused state, and children for each element.",
		InputSchema: mcp.ToolInputSchema{
			Type:       "object",
			Properties: map[string]any{},
		},
	}, handleGetAccessibilityTree)

	// Register get_focused_element tool
	s.AddTool(mcp.Tool{
		Name:        "get_focused_element",
		Description: "Get the currently focused accessibility element. Returns the element that has keyboard focus with its properties.",
		InputSchema: mcp.ToolInputSchema{
			Type:       "object",
			Properties: map[string]any{},
		},
	}, handleGetFocusedElement)

	// Register get_element_at_position tool
	s.AddTool(mcp.Tool{
		Name:        "get_element_at_position",
		Description: "Get the accessibility element at specific screen coordinates. Useful for inspecting UI elements after taking a screenshot.",
		InputSchema: mcp.ToolInputSchema{
			Type: "object",
			Properties: map[string]any{
				"x": map[string]any{
					"type":        "number",
					"description": "X coordinate in screen pixels",
				},
				"y": map[string]any{
					"type":        "number",
					"description": "Y coordinate in screen pixels",
				},
			},
			Required: []string{"x", "y"},
		},
	}, handleGetElementAtPosition)

	// Register perform_accessibility_action tool
	s.AddTool(mcp.Tool{
		Name:        "perform_accessibility_action",
		Description: "Perform an accessibility action on an element. The element is identified by its ID from a previous accessibility query (an \"x,y\" screen coordinate). Supported actions: click, press, focus.",
		InputSchema: mcp.ToolInputSchema{
			Type: "object",
			Properties: map[string]any{
				"element_id": map[string]any{
					"type":        "string",
					"description": "Element ID from a previous accessibility query (format: 'x,y')",
				},
				"action": map[string]any{
					"type":        "string",
					"enum":        []string{"click", "press", "focus"},
					"description": "Action to perform. click and press both activate the element (button press); focus sets keyboard focus to the element.",
					"default":     "click",
				},
			},
			Required: []string{"element_id"},
		},
	}, handlePerformAccessibilityAction)
}

func handleGetAccessibilityTree(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	// Lazy initialize accessibility client
	if accessibilityClient == nil {
		var err error
		accessibilityClient, err = accessibility.New()
		if err != nil {
			return nil, fmt.Errorf("failed to initialize accessibility client: %w", err)
		}
	}

	tree, err := accessibilityClient.GetTree()
	if err != nil {
		return nil, fmt.Errorf("failed to get accessibility tree: %w", err)
	}

	treeJSON, err := json.MarshalIndent(tree, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("failed to serialize tree: %w", err)
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{
				Type: "text",
				Text: string(treeJSON),
			},
		},
	}, nil
}

func handleGetFocusedElement(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	// Lazy initialize accessibility client
	if accessibilityClient == nil {
		var err error
		accessibilityClient, err = accessibility.New()
		if err != nil {
			return nil, fmt.Errorf("failed to initialize accessibility client: %w", err)
		}
	}

	// Get the tree and find the focused element
	tree, err := accessibilityClient.GetTree()
	if err != nil {
		return nil, fmt.Errorf("failed to get accessibility tree: %w", err)
	}

	focusedNode := findFocusedNode(tree)
	if focusedNode == nil {
		return &mcp.CallToolResult{
			Content: []mcp.Content{
				mcp.TextContent{
					Type: "text",
					Text: `{"error": "no focused element found"}`,
				},
			},
		}, nil
	}

	nodeJSON, err := json.MarshalIndent(focusedNode, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("failed to serialize node: %w", err)
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{
				Type: "text",
				Text: string(nodeJSON),
			},
		},
	}, nil
}

func handleGetElementAtPosition(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	argsMap, ok := request.Params.Arguments.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("invalid arguments type")
	}

	x, _ := argsMap["x"].(float64)
	y, _ := argsMap["y"].(float64)

	// Lazy initialize accessibility client
	if accessibilityClient == nil {
		var err error
		accessibilityClient, err = accessibility.New()
		if err != nil {
			return nil, fmt.Errorf("failed to initialize accessibility client: %w", err)
		}
	}

	// Use coordinates as ID
	elementID := fmt.Sprintf("%d,%d", int(x), int(y))
	node, err := accessibilityClient.GetNodeByID(elementID)
	if err != nil {
		return nil, fmt.Errorf("failed to get element at position: %w", err)
	}

	nodeJSON, err := json.MarshalIndent(node, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("failed to serialize node: %w", err)
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{
				Type: "text",
				Text: string(nodeJSON),
			},
		},
	}, nil
}

func handlePerformAccessibilityAction(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	argsMap, ok := request.Params.Arguments.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("invalid arguments type")
	}

	elementID, _ := argsMap["element_id"].(string)
	action, _ := argsMap["action"].(string)
	if action == "" {
		action = "click"
	}

	// Lazy initialize accessibility client
	if accessibilityClient == nil {
		var err error
		accessibilityClient, err = accessibility.New()
		if err != nil {
			return nil, fmt.Errorf("failed to initialize accessibility client: %w", err)
		}
	}

	if err := accessibilityClient.PerformAction(elementID, action); err != nil {
		return nil, fmt.Errorf("failed to perform action: %w", err)
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{
				Type: "text",
				Text: fmt.Sprintf("Successfully performed action '%s' on element %s", action, elementID),
			},
		},
	}, nil
}

// findFocusedNode recursively searches for a focused node in the tree
func findFocusedNode(node *accessibility.Node) *accessibility.Node {
	if node == nil {
		return nil
	}

	if node.Focused {
		return node
	}

	for _, child := range node.Children {
		if focused := findFocusedNode(child); focused != nil {
			return focused
		}
	}

	return nil
}
