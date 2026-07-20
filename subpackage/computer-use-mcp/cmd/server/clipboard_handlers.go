package main

import (
	"context"
	"encoding/base64"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/nekisekaimoe/agentboster/subpackages/computer-use-mcp/pkg/clipboard"
)

// registerClipboardTools registers clipboard_read and clipboard_write. They
// are gated on HasDisplay because the upstream clipboard backend needs an X11
// or Wayland session, just like the screenshot tool.
func registerClipboardTools(s *server.MCPServer) {
	s.AddTool(mcp.Tool{
		Name:        "clipboard_read",
		Description: "Read the system clipboard. Returns either UTF-8 text or a base64-encoded PNG image, depending on what the clipboard currently holds. Pass format=\"image\" to force an image read, or omit it (or pass \"text\") for text. If the clipboard is empty, returns an empty string/empty image.",
		InputSchema: mcp.ToolInputSchema{
			Type: "object",
			Properties: map[string]any{
				"format": map[string]any{
					"type":        "string",
					"enum":        []string{"text", "image"},
					"description": "What to read. Default: text.",
				},
			},
		},
	}, handleClipboardRead)

	s.AddTool(mcp.Tool{
		Name:        "clipboard_write",
		Description: "Write to the system clipboard. Either pass text (UTF-8 string) or image_base64 (base64-encoded image bytes — PNG/JPEG/GIF/WebP accepted; PNG input is stored verbatim, others are normalized to PNG). Exactly one of text or image_base64 must be provided.",
		InputSchema: mcp.ToolInputSchema{
			Type: "object",
			Properties: map[string]any{
				"text": map[string]any{
					"type":        "string",
					"description": "UTF-8 text to place on the clipboard.",
				},
				"image_base64": map[string]any{
					"type":        "string",
					"description": "Base64-encoded image bytes (PNG recommended; JPEG/GIF/WebP auto-converted to PNG).",
				},
			},
		},
	}, handleClipboardWrite)
}

func handleClipboardRead(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	format, _ := request.Params.Arguments.(map[string]any)["format"].(string)
	if format == "" {
		format = "text"
	}

	if format == "image" {
		pngBytes, err := clipboard.ReadImage()
		if err != nil {
			return nil, fmt.Errorf("clipboard read (image): %w", err)
		}
		if len(pngBytes) == 0 {
			return &mcp.CallToolResult{
				Content: []mcp.Content{
					mcp.TextContent{Type: "text", Text: `{"empty": true, "format": "image"}`},
				},
			}, nil
		}
		return &mcp.CallToolResult{
			Content: []mcp.Content{
				mcp.TextContent{Type: "text", Text: fmt.Sprintf(`{"format": "image", "size": %d, "mime": "image/png"}`, len(pngBytes))},
				mcp.ImageContent{Type: "image", Data: base64.StdEncoding.EncodeToString(pngBytes), MIMEType: "image/png"},
			},
		}, nil
	}

	// Default: text.
	text, err := clipboard.ReadText()
	if err != nil {
		return nil, fmt.Errorf("clipboard read (text): %w", err)
	}
	return &mcp.CallToolResult{
		Content: []mcp.Content{
			mcp.TextContent{Type: "text", Text: text},
		},
	}, nil
}

func handleClipboardWrite(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	argsMap, ok := request.Params.Arguments.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("invalid arguments type")
	}
	text, _ := argsMap["text"].(string)
	imgB64, _ := argsMap["image_base64"].(string)

	switch {
	case text != "" && imgB64 != "":
		return nil, fmt.Errorf("provide exactly one of text or image_base64, not both")
	case imgB64 != "":
		// Accept any image format the upstream library can normalize. The server
		// blank-imports image/jpeg so JPEG input is handled automatically; GIF/WebP
		// would need a blank import if a caller ever sends them.
		raw, err := base64.StdEncoding.DecodeString(imgB64)
		if err != nil {
			return nil, fmt.Errorf("image_base64 is not valid base64: %w", err)
		}
		if err := clipboard.WriteImage(raw); err != nil {
			return nil, fmt.Errorf("clipboard write (image): %w", err)
		}
		return &mcp.CallToolResult{
			Content: []mcp.Content{
				mcp.TextContent{Type: "text", Text: fmt.Sprintf("Wrote %d bytes of image data to clipboard (normalized to PNG)", len(raw))},
			},
		}, nil
	default:
		// text may be empty string legitimately (clearing the clipboard); the
		// check here is only about not silently treating missing args as a
		// text clear when image_base64 was intended but malformed. An empty
		// text write is allowed.
		if _, hasText := argsMap["text"]; !hasText && imgB64 == "" {
			return nil, fmt.Errorf("provide either text or image_base64")
		}
		if err := clipboard.WriteText(text); err != nil {
			return nil, fmt.Errorf("clipboard write (text): %w", err)
		}
		return &mcp.CallToolResult{
			Content: []mcp.Content{
				mcp.TextContent{Type: "text", Text: fmt.Sprintf("Wrote %d characters to clipboard", len(text))},
			},
		}, nil
	}
}
