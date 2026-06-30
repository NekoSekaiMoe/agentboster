package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	nurl "net/url"

	"github.com/go-shiori/go-readability"
)

const (
	webFetchMaxBytes      = 2 * 1024 * 1024 // 2MB cap on raw body
	webFetchHTTPTimeout   = 30 * time.Second
	webFetchTextLimit     = 50_000
	webFetchMarkdownLimit = 80_000
	webFetchHTMLLimit     = 100_000
)

func registerWebFetch(registry *ToolRegistry) {
	registry.Register(ToolDefinition{
		Name:        "web_fetch",
		Description: "Fetch content from a URL. Extracts the main article content (not raw HTML).",
		MinUserType: "unknown",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"url": map[string]any{
					"type":        "string",
					"description": "URL to fetch (http or https)",
				},
				"extract": map[string]any{
					"type":        "string",
					"description": "Output format: \"markdown\" (default, main article as markdown), \"text\" (plain text), or \"html\" (raw page HTML).",
					"default":     "markdown",
				},
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

		rawURL := strings.TrimSpace(params.URL)
		u, err := url.Parse(rawURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			return &ToolResult{Success: false, Error: "invalid URL"}, nil
		}

		extract := strings.ToLower(strings.TrimSpace(params.Extract))
		if extract == "" {
			extract = "markdown"
		}
		switch extract {
		case "markdown", "text", "html":
		default:
			return &ToolResult{Success: false, Error: "extract must be one of: markdown, text, html"}, nil
		}

		client := &http.Client{Timeout: webFetchHTTPTimeout}
		req, err := http.NewRequestWithContext(toolCtx, http.MethodGet, rawURL, nil)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("request build error: %v", err)}, nil
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
		req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")

		resp, err := client.Do(req)
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("fetch error: %v", err)}, nil
		}
		defer resp.Body.Close()

		if resp.StatusCode >= 400 {
			return &ToolResult{Success: false, Error: fmt.Sprintf("HTTP %d", resp.StatusCode)}, nil
		}

		body, err := io.ReadAll(io.LimitReader(resp.Body, webFetchMaxBytes))
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("read error: %v", err)}, nil
		}

		// "html" mode: return raw page HTML (capped).
		if extract == "html" {
			return &ToolResult{Success: true, Data: truncate(string(body), webFetchHTMLLimit)}, nil
		}

		// "markdown" / "text": run readability extraction.
		pageURL, _ := nurl.Parse(rawURL)
		article, err := readability.FromReader(bytes.NewReader(body), pageURL)
		if err != nil {
			// Fall back to raw text on extraction failure (still more useful than an error).
			return &ToolResult{Success: true, Data: truncate(stripHTML(string(body)), webFetchTextLimit)}, nil
		}

		var out strings.Builder
		if article.Title != "" {
			out.WriteString("# ")
			out.WriteString(article.Title)
			out.WriteString("\n\n")
		}
		if article.Byline != "" {
			out.WriteString("_by ")
			out.WriteString(article.Byline)
			out.WriteString("_\n\n")
		}

		if extract == "markdown" {
			md := htmlToMarkdown(article.Content)
			if strings.TrimSpace(md) == "" {
				md = article.TextContent
			}
			out.WriteString(truncate(md, webFetchMarkdownLimit))
		} else {
			out.WriteString(truncate(article.TextContent, webFetchTextLimit))
		}

		return &ToolResult{Success: true, Data: out.String()}, nil
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
	// Fallback tag stripper, only used when readability extraction fails.
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
