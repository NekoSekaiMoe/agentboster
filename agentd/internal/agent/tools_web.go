package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func registerWebFetch(registry *ToolRegistry) {
	registry.Register(ToolDefinition{
		Name:        "web_fetch",
		Description: "Fetch content from a URL. Returns the page content as text.",
		MinUserType: "unknown",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"url":     map[string]any{"type": "string", "description": "URL to fetch"},
				"extract": map[string]any{"type": "string", "description": "What to extract: text, html, or markdown. Default: text", "default": "text"},
			},
			"required": []string{"url"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			URL     string `json:"url"`
			Extract string `json:"extract"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		// Validate URL
		u, err := url.Parse(params.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			return &ToolResult{Success: false, Error: "invalid URL"}, nil
		}

		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Get(params.URL)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("fetch error: %v", err)}, nil
		}
		defer resp.Body.Close()

		if resp.StatusCode >= 400 {
			return &ToolResult{Success: false, Error: fmt.Sprintf("HTTP %d", resp.StatusCode)}, nil
		}

		data, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024)) // 1MB limit
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("read error: %v", err)}, nil
		}

		content := string(data)
		if params.Extract == "text" {
			// Strip HTML tags for text extraction
			content = stripHTML(content)
		}

		return &ToolResult{Success: true, Data: content}, nil
	})
}

func registerWebSearch(registry *ToolRegistry) {
	registry.Register(ToolDefinition{
		Name:        "web_search",
		Description: "Search the web. Returns top search results with titles, URLs, and snippets.",
		MinUserType: "unknown",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": map[string]any{"type": "string", "description": "Search query"},
				"limit": map[string]any{"type": "integer", "description": "Max results (default 5)", "default": 5},
			},
			"required": []string{"query"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		if params.Limit <= 0 {
			params.Limit = 5
		}

		// Use DuckDuckGo instant answer API (no key required)
		searchURL := fmt.Sprintf("https://api.duckduckgo.com/?q=%s&format=json&no_html=1", url.QueryEscape(params.Query))
		client := &http.Client{Timeout: 15 * time.Second}
		resp, err := client.Get(searchURL)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("search error: %v", err)}, nil
		}
		defer resp.Body.Close()

		data, err := io.ReadAll(resp.Body)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("read error: %v", err)}, nil
		}

		// Parse DuckDuckGo response
		var ddgResp struct {
			AbstractText string `json:"AbstractText"`
			Results      []struct {
				Text string `json:"Text"`
				URL  string `json:"FirstURL"`
				Icon struct {
					URL string `json:"URL"`
				} `json:"Icon"`
			} `json:"Results"`
			RelatedTopics []struct {
				Text string `json:"Text"`
				URL  string `json:"FirstURL"`
			} `json:"RelatedTopics"`
		}

		if err := json.Unmarshal(data, &ddgResp); err != nil {
			return &ToolResult{Success: true, Data: string(data)}, nil
		}

		var result strings.Builder
		if ddgResp.AbstractText != "" {
			result.WriteString(fmt.Sprintf("## Abstract\n%s\n\n", ddgResp.AbstractText))
		}
		result.WriteString("## Results\n")
		count := 0
		for _, r := range ddgResp.Results {
			if count >= params.Limit {
				break
			}
			result.WriteString(fmt.Sprintf("- %s\n  %s\n", r.Text, r.URL))
			count++
		}
		for _, r := range ddgResp.RelatedTopics {
			if count >= params.Limit {
				break
			}
			result.WriteString(fmt.Sprintf("- %s\n  %s\n", r.Text, r.URL))
			count++
		}

		return &ToolResult{Success: true, Data: result.String()}, nil
	})
}

func stripHTML(html string) string {
	// Simple HTML tag stripper
	result := html
	for {
		start := strings.Index(result, "<")
		if start == -1 {
			break
		}
		end := strings.Index(result[start:], ">")
		if end == -1 {
			break
		}
		result = result[:start] + result[start+end+1:]
	}
	return strings.TrimSpace(result)
}
