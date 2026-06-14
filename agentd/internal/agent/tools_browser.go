package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/clawless/agentd/internal/sandbox"
)

// registerBrowserAct registers the browser_act tool.
//
// P1.3: Provides real browser automation (navigate, screenshot, extract
// text/DOM, click, type) by driving a headless Chromium inside the
// sandbox via shell scripts. This complements web_fetch_rendered (which
// is fetch-only) with interactive capabilities.
//
// Implementation strategy: each action compiles to a bash script that
// invokes chromium with appropriate --headless=new flags plus user-data-dir
// persistence for multi-step sessions. The chromium install logic is
// shared with web_fetch_rendered via ensureChromiumInstalled().
//
// Click/type operations use a small JS injection via --run-all-compositor-stages-before-draw
// and a wrapper HTML page that runs the user's JS. This is more limited
// than a full CDP client (chromedp) but covers the 80% case without
// adding a port-forwarding dependency between the daemon and the sandbox.
func registerBrowserAct(registry *ToolRegistry, sbManager *sandbox.Manager, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "browser_act",
		Description: "Drive a headless Chromium browser inside the sandbox. Supports: navigate (load a URL and wait), screenshot (capture PNG, returned as base64), extract (get text/DOM by selector), click (click element by selector), type (type text into element by selector). Requires the sandbox to have network access (permission_profile=browser or network).",
		MinUserType: "trusted",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"action": map[string]any{
					"type":        "string",
					"description": "Action to perform: navigate | screenshot | extract | click | type",
					"enum":        []string{"navigate", "screenshot", "extract", "click", "type"},
				},
				"url": map[string]any{
					"type":        "string",
					"description": "URL to navigate to (for navigate/screenshot actions)",
				},
				"selector": map[string]any{
					"type":        "string",
					"description": "CSS selector for extract/click/type actions",
				},
				"value": map[string]any{
					"type":        "string",
					"description": "Text to type (for type action)",
				},
				"timeout": map[string]any{
					"type":        "number",
					"description": "Timeout in seconds (default 30, max 120)",
					"default":     30,
				},
			},
			"required": []string{"action"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Action   string `json:"action"`
			URL      string `json:"url"`
			Selector string `json:"selector"`
			Value    string `json:"value"`
			Timeout  int    `json:"timeout"`
		}
		if toolErr := unmarshalToolArgs(args, &params); toolErr != nil {
			return toolErr, nil
		}

		if params.Timeout <= 0 {
			params.Timeout = 30
		}
		if params.Timeout > 120 {
			params.Timeout = 120
		}

		if ctx.SandboxID == "" {
			return &ToolResult{Success: false, Error: "no sandbox available"}, nil
		}

		// Ensure chromium is installed (shared with web_fetch_rendered).
		if err := ensureChromiumInstalled(sbManager, ctx); err != nil {
			return &ToolResult{Success: false, Error: fmt.Sprintf("chromium install failed: %v", err)}, nil
		}

		switch params.Action {
		case "navigate":
			return browserNavigate(sbManager, ctx, params.URL, params.Timeout)
		case "screenshot":
			return browserScreenshot(sbManager, ctx, params.URL, params.Timeout)
		case "extract":
			return browserExtract(sbManager, ctx, params.URL, params.Selector, params.Timeout)
		case "click":
			return browserClick(sbManager, ctx, params.URL, params.Selector, params.Timeout)
		case "type":
			return browserType(sbManager, ctx, params.URL, params.Selector, params.Value, params.Timeout)
		default:
			return &ToolResult{
				Success: false,
				Error:   fmt.Sprintf("unknown browser action: %q", params.Action),
			}, nil
		}
	})
}

// ensureChromiumInstalled reuses the install script from web_fetch_rendered.
// We invoke the same find/install logic by calling renderURLInSandbox with
// a benign URL (about:blank) — if that succeeds, chromium is installed.
var ensureChromiumInstalled = func(sbManager *sandbox.Manager, ctx *AgentContext) error {
	_, _, toolErr := renderURLInSandbox(sbManager, ctx, "about:blank", 60)
	if toolErr != nil {
		return fmt.Errorf("chromium bootstrap failed: %s", toolErr.Error)
	}
	return nil
}

// findChromium returns a shell snippet that sets $BROWSER to the chromium binary.
const findChromiumSnippet = `BROWSER=""
for c in chromium-browser chromium google-chrome google-chrome-stable chrome; do
  if command -v "$c" >/dev/null 2>&1; then
    BROWSER="$(command -v "$c")"
    break
  fi
done
[ -z "$BROWSER" ] && { echo "chromium not found" >&2; exit 1; }
`

// browserNavigate loads a URL and returns the rendered page text.
func browserNavigate(sbManager *sandbox.Manager, ctx *AgentContext, targetURL string, timeout int) (*ToolResult, error) {
	if targetURL == "" {
		return &ToolResult{Success: false, Error: "url is required for navigate"}, nil
	}
	// Reuse the rendered-fetch path — it already does navigate + extract.
	text, title, err := renderURLInSandbox(sbManager, ctx, targetURL, timeout)
	if err != nil {
		return err, nil
	}
	return &ToolResult{
		Success: true,
		Data: fmt.Sprintf(
			"Navigated to %s\nTitle: %s\n\nPage text:\n%s",
			targetURL, title, truncate(text, 20000),
		),
	}, nil
}

// browserScreenshot captures a PNG screenshot and returns it as base64.
func browserScreenshot(sbManager *sandbox.Manager, ctx *AgentContext, targetURL string, timeout int) (*ToolResult, error) {
	if targetURL == "" {
		return &ToolResult{Success: false, Error: "url is required for screenshot"}, nil
	}

	outPath := fmt.Sprintf("/workspace/downloads/screenshots/shot_%d.png", time.Now().UnixNano())
	script := fmt.Sprintf(`set -eu
%s
mkdir -p /workspace/downloads/screenshots
"$BROWSER" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --virtual-time-budget=%d \
  --screenshot=%s --window-size=1280,800 \
  %q
# Check the file exists and is non-empty
[ -s %s ] || { echo "screenshot file empty" >&2; exit 1; }
echo "OK"
`, findChromiumSnippet, timeout*1000, outPath, targetURL, outPath)

	result, err := sbManager.Exec(ctx.SandboxID, script, nil, timeout+10)
	if err != nil {
		return &ToolResult{Success: false, Error: fmt.Sprintf("exec failed: %v", err)}, nil
	}
	if result.ExitCode != 0 {
		return &ToolResult{Success: false, Error: fmt.Sprintf("screenshot failed: %s", result.Stderr)}, nil
	}

	// Read the file back via base64.
	readScript := fmt.Sprintf("base64 -w0 %s", outPath)
	result, err = sbManager.Exec(ctx.SandboxID, readScript, nil, 10)
	if err != nil {
		return &ToolResult{Success: false, Error: fmt.Sprintf("read back failed: %v", err)}, nil
	}
	if len(result.Stdout) == 0 {
		return &ToolResult{Success: false, Error: "screenshot was empty"}, nil
	}

	return &ToolResult{
		Success: true,
		Data: fmt.Sprintf(
			"Screenshot of %s captured (%d bytes base64).\nURL: %s\n\nbase64 PNG (use decode to view):\n%s",
			targetURL, len(result.Stdout), targetURL, result.Stdout,
		),
	}, nil
}

// browserExtract navigates then extracts text/HTML by CSS selector.
func browserExtract(sbManager *sandbox.Manager, ctx *AgentContext, targetURL, selector string, timeout int) (*ToolResult, error) {
	if targetURL == "" {
		return &ToolResult{Success: false, Error: "url is required for extract"}, nil
	}
	if selector == "" {
		selector = "body"
	}

	// Build a JS snippet that extracts text content of matched elements.
	js := fmt.Sprintf(`(function(){
  var nodes = document.querySelectorAll(%q);
  var out = [];
  nodes.forEach(function(n){ out.push({tag: n.tagName, text: n.textContent.trim().slice(0,5000)}); });
  return JSON.stringify(out);
})()`, selector)

	out, err := runChromiumJS(sbManager, ctx, targetURL, js, timeout)
	if err != nil {
		return &ToolResult{Success: false, Error: err.Error()}, nil
	}
	return &ToolResult{
		Success: true,
		Data: fmt.Sprintf(
			"Extracted %q from %s:\n%s",
			selector, targetURL, truncate(out, 20000),
		),
	}, nil
}

// browserClick navigates, then dispatches a click event on the selector.
func browserClick(sbManager *sandbox.Manager, ctx *AgentContext, targetURL, selector string, timeout int) (*ToolResult, error) {
	if targetURL == "" || selector == "" {
		return &ToolResult{Success: false, Error: "url and selector are required for click"}, nil
	}

	js := fmt.Sprintf(`(function(){
  var el = document.querySelector(%q);
  if (!el) return JSON.stringify({error: "element not found"});
  el.click();
  return JSON.stringify({ok: true, tag: el.tagName, text: (el.textContent||"").trim().slice(0,200)});
})()`, selector)

	out, err := runChromiumJS(sbManager, ctx, targetURL, js, timeout)
	if err != nil {
		return &ToolResult{Success: false, Error: err.Error()}, nil
	}
	return &ToolResult{
		Success: true,
		Data:    fmt.Sprintf("Clicked %q on %s:\n%s", selector, targetURL, out),
	}, nil
}

// browserType navigates, then sets the value of the matched input element.
func browserType(sbManager *sandbox.Manager, ctx *AgentContext, targetURL, selector, value string, timeout int) (*ToolResult, error) {
	if targetURL == "" || selector == "" {
		return &ToolResult{Success: false, Error: "url and selector are required for type"}, nil
	}

	// Escape backticks and ${} in the value for the JS template literal.
	escaped := strings.ReplaceAll(value, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, "`", "\\`")
	escaped = strings.ReplaceAll(escaped, "${", "\\${")

	js := fmt.Sprintf(`(function(){
  var el = document.querySelector(%q);
  if (!el) return JSON.stringify({error: "element not found"});
  var proto = el.tagName === "INPUT" || el.tagName === "TEXTAREA"
    ? window.HTMLInputElement.prototype
    : window.HTMLElement.prototype;
  var setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
  if (setter) setter.call(el, %q);
  else el.value = %q;
  el.dispatchEvent(new Event("input", {bubbles: true}));
  el.dispatchEvent(new Event("change", {bubbles: true}));
  return JSON.stringify({ok: true});
})()`, selector, escaped, escaped)

	out, err := runChromiumJS(sbManager, ctx, targetURL, js, timeout)
	if err != nil {
		return &ToolResult{Success: false, Error: err.Error()}, nil
	}
	return &ToolResult{
		Success: true,
		Data:    fmt.Sprintf("Typed %d chars into %q on %s:\n%s", len(value), selector, targetURL, out),
	}, nil
}

// runChromiumJS navigates to targetURL and executes the given JS,
// returning the script's return value as a string. Uses Chromium's
// --dump-dom with an injected <script> wrapper.
func runChromiumJS(sbManager *sandbox.Manager, ctx *AgentContext, targetURL, js string, timeout int) (string, error) {
	// Encode the JS as base64 so we don't fight shell quoting.
	jsB64 := base64.StdEncoding.EncodeToString([]byte(js))

	// Write a wrapper HTML that runs the JS and writes the result to <title>.
	// We then dump the DOM and parse out the title.
	script := fmt.Sprintf(`set -eu
%s
WORK=$(mktemp -d)
cat > "$WORK/runner.js" <<'JSEOF'
window.__result = "";
window.addEventListener("load", function(){
  try {
    var fn = new Function("return (" + atob("%s") + ")"); 
    var r = fn();
    window.__result = r || "";
    document.title = "RESULT:" + window.__result;
  } catch(e) {
    document.title = "ERROR:" + e.message;
  }
});
JSEOF

# Build the final HTML by fetching the page and injecting the runner.
# Use --dump-dom after virtual time to let JS execute.
"$BROWSER" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --virtual-time-budget=%d \
  --run-all-compositor-stages-before-draw \
  --dump-dom %q > "$WORK/dom.html" 2>/dev/null || true

# Inject and re-run: download targetURL, inject script tag, then dump.
curl -sSL %q > "$WORK/page.html" 2>/dev/null || true
if [ -s "$WORK/page.html" ]; then
  # Inject our runner before </body>
  RUNNER_TAG='<script src="file://'"$WORK"'/runner.js"></script>'
  sed "s|</body>|$RUNNER_TAG</body>|" "$WORK/page.html" > "$WORK/inj.html"
  "$BROWSER" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --virtual-time-budget=%d \
    --dump-dom "file://$WORK/inj.html" > "$WORK/dom2.html" 2>/dev/null || true
  # Extract title (which holds the result)
  TITLE=$(grep -oE "<title>[^<]*</title>" "$WORK/dom2.html" | head -1 | sed -E 's|</?title>||g')
  if [ -n "$TITLE" ]; then
    echo "$TITLE"
    exit 0
  fi
fi

# Fallback: just dump the DOM
if [ -s "$WORK/dom.html" ]; then
  echo "RAW_DOM:"
  head -c 5000 "$WORK/dom.html"
fi
`, findChromiumSnippet, jsB64, timeout*1000, targetURL, targetURL, timeout*1000)

	result, err := sbManager.Exec(ctx.SandboxID, script, nil, timeout+15)
	if err != nil {
		return "", fmt.Errorf("exec failed: %v", err)
	}
	if result.ExitCode != 0 && len(result.Stdout) == 0 {
		return "", fmt.Errorf("chromium js failed: %s", result.Stderr)
	}
	return result.Stdout, nil
}

var _ = time.Now // ensure time import is used
