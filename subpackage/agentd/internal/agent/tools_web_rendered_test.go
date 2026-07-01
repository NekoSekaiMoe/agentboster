package agent

import "testing"

func TestValidateHTTPURL(t *testing.T) {
	valid := []string{
		"https://example.com",
		"http://example.com/path?q=1",
	}
	for _, rawURL := range valid {
		if err := validateHTTPURL(rawURL); err != nil {
			t.Fatalf("expected %q to be valid: %v", rawURL, err)
		}
	}

	invalid := []string{
		"file:///etc/passwd",
		"javascript:alert(1)",
		"https:///missing-host",
		"not a url",
	}
	for _, rawURL := range invalid {
		if err := validateHTTPURL(rawURL); err == nil {
			t.Fatalf("expected %q to be invalid", rawURL)
		}
	}
}

func TestHTMLTitleAndText(t *testing.T) {
	title, text := htmlTitleAndText(`<!doctype html>
<html>
  <head>
    <title> Example Page </title>
    <style>body { color: red; }</style>
  </head>
  <body>
    <h1>Hello</h1>
    <script>window.secret = "ignored"</script>
    <p>Rendered content</p>
  </body>
</html>`)

	if title != "Example Page" {
		t.Fatalf("unexpected title: %q", title)
	}
	if text != "Example Page Hello Rendered content" {
		t.Fatalf("unexpected text: %q", text)
	}
}

func TestExtractDuckDuckGoResults(t *testing.T) {
	results := extractDuckDuckGoResults(`<html><body>
<div class="result">
  <a class="result__a" href="/l/?kh=-1&uddg=https%3A%2F%2Fexample.com%2Fdocs">Example Docs</a>
  <a class="result__snippet">Useful documentation snippet</a>
</div>
<div class="result">
  <a class="result__a" href="https://example.org">Example Org</a>
</div>
</body></html>`, 10)

	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	if results[0].Title != "Example Docs" {
		t.Fatalf("unexpected first title: %q", results[0].Title)
	}
	if results[0].URL != "https://example.com/docs" {
		t.Fatalf("unexpected first URL: %q", results[0].URL)
	}
	if results[0].Snippet != "Useful documentation snippet" {
		t.Fatalf("unexpected first snippet: %q", results[0].Snippet)
	}
	if results[1].URL != "https://example.org" {
		t.Fatalf("unexpected second URL: %q", results[1].URL)
	}
}
