package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/sandbox"
	"golang.org/x/net/html"
)

const (
	defaultRenderedTimeout  = 180
	maxRenderedTimeout      = 600
	defaultRenderedMaxChars = 20000
	maxRenderedMaxChars     = 100000
)

type renderedFetchResult struct {
	URL              string `json:"url"`
	Title            string `json:"title,omitempty"`
	Extract          string `json:"extract"`
	Content          string `json:"content,omitempty"`
	Rendered         bool   `json:"rendered"`
	Browser          string `json:"browser,omitempty"`
	ContentLength    int    `json:"content_length"`
	Truncated        bool   `json:"truncated,omitempty"`
	JavaScriptLikely bool   `json:"javascript_likely,omitempty"`
}

type renderedSearchResult struct {
	Query    string               `json:"query"`
	Engine   string               `json:"engine"`
	Rendered bool                 `json:"rendered"`
	Browser  string               `json:"browser,omitempty"`
	Results  []renderedSearchItem `json:"results"`
}

type renderedSearchItem struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet,omitempty"`
}

func registerWebRendered(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registerWebFetchRendered(registry, sbMgr, ctx)
	registerWebSearchRendered(registry, sbMgr, ctx)
}

func registerWebFetchRendered(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "web_fetch_rendered",
		Description: "Fetch a URL with a sandbox-local headless Chromium browser, then return rendered text or HTML as JSON. If Chromium is missing, the tool attempts package-manager auto-install first. Use for JS-heavy pages or when the request must originate from the agent sandbox.",
		MinUserType: "unknown",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"url":       map[string]any{"type": "string", "description": "HTTP(S) URL to render"},
				"extract":   map[string]any{"type": "string", "description": "What to return: text or html. Default: text", "default": "text"},
				"max_chars": map[string]any{"type": "integer", "description": "Maximum content characters to return. Default 20000, max 100000", "default": defaultRenderedMaxChars},
				"timeout":   map[string]any{"type": "integer", "description": "Timeout in seconds, including first-run browser auto-install. Default 180, max 600", "default": defaultRenderedTimeout},
			},
			"required": []string{"url"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			URL      string `json:"url"`
			Extract  string `json:"extract"`
			MaxChars int    `json:"max_chars"`
			Timeout  int    `json:"timeout"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		targetURL := strings.TrimSpace(params.URL)
		if err := validateHTTPURL(targetURL); err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}
		extract := strings.ToLower(strings.TrimSpace(params.Extract))
		if extract == "" {
			extract = "text"
		}
		if extract != "text" && extract != "html" {
			return &ToolResult{Success: false, Error: "extract must be text or html"}, nil
		}
		maxChars := clampRenderedMaxChars(params.MaxChars)
		timeout := clampRenderedTimeout(params.Timeout)

		htmlContent, browser, toolResult := renderURLInSandbox(sbMgr, ctx, targetURL, timeout)
		if toolResult != nil {
			return toolResult, nil
		}

		title, text := htmlTitleAndText(htmlContent)
		content := htmlContent
		if extract == "text" {
			content = normalizeWhitespace(text)
		}
		content, truncated := truncateWithFlag(content, maxChars)

		result := renderedFetchResult{
			URL:              targetURL,
			Title:            title,
			Extract:          extract,
			Content:          content,
			Rendered:         true,
			Browser:          browser,
			ContentLength:    len(content),
			Truncated:        truncated,
			JavaScriptLikely: detectsJSLikely(htmlContent, text),
		}
		data, err := json.MarshalIndent(result, "", "  ")
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("marshal result: %v", err)}, nil
		}
		return &ToolResult{Success: true, Data: string(data)}, nil
	})
}

func registerWebSearchRendered(registry *ToolRegistry, sbMgr *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "web_search_rendered",
		Description: "Search the web from the sandbox using a headless Chromium-rendered DuckDuckGo HTML results page. If Chromium is missing, the tool attempts package-manager auto-install first. Returns JSON titles, URLs, and snippets; no image or multimodal transport is used.",
		MinUserType: "unknown",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query":   map[string]any{"type": "string", "description": "Search query"},
				"limit":   map[string]any{"type": "integer", "description": "Max results. Default 5, max 10", "default": 5},
				"timeout": map[string]any{"type": "integer", "description": "Timeout in seconds, including first-run browser auto-install. Default 180, max 600", "default": defaultRenderedTimeout},
			},
			"required": []string{"query"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Query   string `json:"query"`
			Limit   int    `json:"limit"`
			Timeout int    `json:"timeout"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}
		query := strings.TrimSpace(params.Query)
		if query == "" {
			return &ToolResult{Success: false, Error: "query is required"}, nil
		}
		limit := params.Limit
		if limit <= 0 {
			limit = 5
		}
		if limit > 10 {
			limit = 10
		}
		timeout := clampRenderedTimeout(params.Timeout)

		searchURL := "https://html.duckduckgo.com/html/?q=" + url.QueryEscape(query)
		htmlContent, browser, toolResult := renderURLInSandbox(sbMgr, ctx, searchURL, timeout)
		if toolResult != nil {
			return toolResult, nil
		}

		result := renderedSearchResult{
			Query:    query,
			Engine:   "duckduckgo-html",
			Rendered: true,
			Browser:  browser,
			Results:  extractDuckDuckGoResults(htmlContent, limit),
		}
		data, err := json.MarshalIndent(result, "", "  ")
		if err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("marshal result: %v", err)}, nil
		}
		return &ToolResult{Success: true, Data: string(data)}, nil
	})
}

func renderURLInSandbox(sbMgr *sandbox.Manager, ctx *AgentContext, targetURL string, timeout int) (string, string, *ToolResult) {
	if ctx.SandboxID == "" {
		return "", "", &ToolResult{Success: false, Error: "no sandbox available"}
	}

	const command = `set -eu
find_browser() {
  for candidate in chromium-browser chromium google-chrome google-chrome-stable chrome; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

install_chromium() {
  if command -v apk >/dev/null 2>&1; then
    apk update
    for pkg in chromium chromium-browser; do
      if apk search -e "$pkg" 2>/dev/null | grep -qx "$pkg"; then
        apk add --no-cache "$pkg" nss freetype harfbuzz ca-certificates ttf-freefont
        return 0
      fi
    done
    apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
    return 0
  fi

  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    for pkg in chromium chromium-browser google-chrome-stable; do
      if apt-cache show "$pkg" >/dev/null 2>&1; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$pkg" ca-certificates fonts-liberation
        return 0
      fi
    done
    return 1
  fi

  if command -v dnf >/dev/null 2>&1; then
    for pkg in chromium chromium-browser google-chrome-stable; do
      if dnf -q info "$pkg" >/dev/null 2>&1; then
        dnf install -y "$pkg"
        return 0
      fi
    done
    return 1
  fi

  if command -v yum >/dev/null 2>&1; then
    for pkg in chromium chromium-browser google-chrome-stable; do
      if yum -q info "$pkg" >/dev/null 2>&1; then
        yum install -y "$pkg"
        return 0
      fi
    done
    return 1
  fi

  if command -v pacman >/dev/null 2>&1; then
    for pkg in chromium google-chrome; do
      if pacman -Si "$pkg" >/dev/null 2>&1; then
        pacman -Sy --noconfirm "$pkg"
        return 0
      fi
    done
    return 1
  fi

  if command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive refresh
    for pkg in chromium chromium-browser google-chrome-stable; do
      if zypper --non-interactive search --match-exact "$pkg" >/dev/null 2>&1; then
        zypper --non-interactive install "$pkg"
        return 0
      fi
    done
    return 1
  fi

  return 1
}

tmp_root="$(mktemp -d /tmp/agentd-browser-XXXXXX)"
trap 'rm -rf "$tmp_root"' EXIT
install_log="$tmp_root/install.log"
browser="$(find_browser || true)"
if [ -z "$browser" ]; then
  echo "AGENTD_BROWSER_INSTALL=started"
  if ! install_chromium >"$install_log" 2>&1; then
    echo "AGENTD_BROWSER_INSTALL_FAILED"
    cat "$install_log"
    exit 71
  fi
  browser="$(find_browser || true)"
  if [ -z "$browser" ]; then
    echo "AGENTD_BROWSER_NOT_FOUND_AFTER_INSTALL"
    cat "$install_log"
    exit 127
  fi
  echo "AGENTD_BROWSER_INSTALL=completed"
fi
profile="$tmp_root/profile"
mkdir -p "$profile"
echo "AGENTD_BROWSER=$browser"
if ! "$browser" \
    --headless=new \
    --disable-gpu \
    --disable-dev-shm-usage \
    --no-sandbox \
    --disable-setuid-sandbox \
    --user-data-dir="$profile" \
    --virtual-time-budget=5000 \
    --run-all-compositor-stages-before-draw \
    --dump-dom "$TARGET_URL" 2>"$profile/stderr.log"; then
  cat "$profile/stderr.log"
  exit 70
fi`

	result, err := sbMgr.Exec(ctx.SandboxID, command, map[string]string{"TARGET_URL": targetURL}, timeout)
	if err != nil {
		return "", "", &ToolResult{Success: false, Error: fmt.Sprintf("render exec error: %v", err)}
	}
	output := strings.TrimSpace(result.Stdout)
	if strings.Contains(output, "AGENTD_BROWSER_INSTALL_FAILED") {
		return "", "", &ToolResult{Success: false, Error: fmt.Sprintf("headless Chromium auto-install failed; check sandbox package manager and network access: %s", truncate(output, 2000))}
	}
	if strings.Contains(output, "AGENTD_BROWSER_NOT_FOUND_AFTER_INSTALL") {
		return "", "", &ToolResult{Success: false, Error: fmt.Sprintf("headless Chromium was not found after package-manager install; check package names and image repositories: %s", truncate(output, 2000))}
	}
	if result.ExitCode == 127 || strings.Contains(output, "AGENTD_BROWSER_NOT_FOUND") {
		return "", "", &ToolResult{Success: false, Error: "headless Chromium not found in sandbox and auto-install did not make it available; check package manager, permissions, and network access"}
	}
	if result.ExitCode != 0 {
		return "", "", &ToolResult{Success: false, Error: fmt.Sprintf("render failed with exit code %d: %s", result.ExitCode, truncate(output, 2000))}
	}

	browser := ""
	lines := strings.Split(output, "\n")
	htmlStart := 0
	for i, line := range lines {
		if strings.HasPrefix(line, "AGENTD_BROWSER=") {
			browser = strings.TrimPrefix(line, "AGENTD_BROWSER=")
			htmlStart = i + 1
			continue
		}
		if strings.Contains(strings.ToLower(line), "<html") || strings.Contains(strings.ToLower(line), "<!doctype") {
			htmlStart = i
			break
		}
	}
	htmlContent := strings.TrimSpace(strings.Join(lines[htmlStart:], "\n"))
	if htmlContent == "" {
		return "", browser, &ToolResult{Success: false, Error: "render returned empty DOM; check sandbox network access and target URL"}
	}
	return htmlContent, browser, nil
}

func validateHTTPURL(rawURL string) error {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u == nil {
		return fmt.Errorf("invalid URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("invalid URL: only http and https are supported")
	}
	if u.Host == "" {
		return fmt.Errorf("invalid URL: host is required")
	}
	return nil
}

func clampRenderedTimeout(timeout int) int {
	if timeout <= 0 {
		return defaultRenderedTimeout
	}
	if timeout > maxRenderedTimeout {
		return maxRenderedTimeout
	}
	return timeout
}

func clampRenderedMaxChars(maxChars int) int {
	if maxChars <= 0 {
		return defaultRenderedMaxChars
	}
	if maxChars > maxRenderedMaxChars {
		return maxRenderedMaxChars
	}
	return maxChars
}

func truncateWithFlag(s string, maxChars int) (string, bool) {
	if maxChars <= 0 || len(s) <= maxChars {
		return s, false
	}
	return s[:maxChars] + "...", true
}

func normalizeWhitespace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func htmlTitleAndText(rawHTML string) (string, string) {
	doc, err := html.Parse(strings.NewReader(rawHTML))
	if err != nil {
		return "", stripHTML(rawHTML)
	}

	var title string
	var textParts []string
	var walk func(*html.Node, bool)
	walk = func(n *html.Node, skip bool) {
		if n.Type == html.ElementNode {
			switch strings.ToLower(n.Data) {
			case "script", "style", "noscript", "svg":
				skip = true
			case "title":
				title = strings.TrimSpace(nodeText(n))
			}
		}
		if n.Type == html.TextNode && !skip {
			if text := strings.TrimSpace(n.Data); text != "" {
				textParts = append(textParts, text)
			}
		}
		for child := n.FirstChild; child != nil; child = child.NextSibling {
			walk(child, skip)
		}
	}
	walk(doc, false)
	return normalizeWhitespace(title), normalizeWhitespace(strings.Join(textParts, " "))
}

func nodeText(n *html.Node) string {
	var parts []string
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if node.Type == html.TextNode {
			parts = append(parts, node.Data)
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(n)
	return strings.Join(parts, " ")
}

func detectsJSLikely(rawHTML, text string) bool {
	lower := strings.ToLower(rawHTML)
	if strings.Contains(lower, "__next") || strings.Contains(lower, "id=\"root\"") || strings.Contains(lower, "id=\"app\"") {
		return true
	}
	return len(strings.TrimSpace(text)) < 500 && strings.Count(lower, "<script") >= 3
}

func extractDuckDuckGoResults(rawHTML string, limit int) []renderedSearchItem {
	doc, err := html.Parse(strings.NewReader(rawHTML))
	if err != nil {
		return nil
	}
	items := make([]renderedSearchItem, 0, limit)
	seen := make(map[string]bool)

	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if len(items) >= limit {
			return
		}
		if n.Type == html.ElementNode && strings.EqualFold(n.Data, "a") {
			href := attrValue(n, "href")
			class := attrValue(n, "class")
			if href != "" && strings.Contains(class, "result__a") {
				resolvedURL := normalizeDDGResultURL(href)
				title := normalizeWhitespace(nodeText(n))
				if title != "" && resolvedURL != "" && !seen[resolvedURL] {
					seen[resolvedURL] = true
					items = append(items, renderedSearchItem{
						Title:   title,
						URL:     resolvedURL,
						Snippet: findDDGSnippet(n),
					})
				}
			}
		}
		for child := n.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(doc)
	return items
}

func findDDGSnippet(link *html.Node) string {
	for n := link.Parent; n != nil; n = n.Parent {
		if n.Type == html.ElementNode && classContains(n, "result") {
			if snippet := findTextByClass(n, "result__snippet"); snippet != "" {
				return snippet
			}
			break
		}
	}
	return ""
}

func findTextByClass(n *html.Node, className string) string {
	if n.Type == html.ElementNode && classContains(n, className) {
		return normalizeWhitespace(nodeText(n))
	}
	for child := n.FirstChild; child != nil; child = child.NextSibling {
		if text := findTextByClass(child, className); text != "" {
			return text
		}
	}
	return ""
}

func classContains(n *html.Node, className string) bool {
	classes := strings.Fields(attrValue(n, "class"))
	for _, class := range classes {
		if class == className {
			return true
		}
	}
	return false
}

func attrValue(n *html.Node, key string) string {
	for _, attr := range n.Attr {
		if strings.EqualFold(attr.Key, key) {
			return attr.Val
		}
	}
	return ""
}

func normalizeDDGResultURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err == nil {
		if uddg := u.Query().Get("uddg"); uddg != "" {
			if decoded, decodeErr := url.QueryUnescape(uddg); decodeErr == nil {
				return decoded
			}
			return uddg
		}
		if u.Scheme == "http" || u.Scheme == "https" {
			return rawURL
		}
	}
	if strings.HasPrefix(rawURL, "//") {
		return "https:" + rawURL
	}
	return rawURL
}
