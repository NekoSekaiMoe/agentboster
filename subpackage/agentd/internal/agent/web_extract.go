package agent

import (
	"strings"

	"golang.org/x/net/html"
)

// htmlToMarkdown converts an HTML fragment to a very compact markdown string.
// It is intentionally lightweight (no external markdown dep) and only covers
// the common article tags readability emits (headings, paragraphs, lists,
// anchors, emphasis, code, pre, blockquote). Unknown/unsupported tags are
// flattened to their text content.
//
// This is NOT a general-purpose HTML→markdown converter; it exists to turn
// readability's Article.HTMLContent into something models consume more
// cheaply than raw HTML.
func htmlToMarkdown(input string) string {
	input = strings.TrimSpace(input)
	if input == "" {
		return ""
	}
	doc, err := html.Parse(strings.NewReader(input))
	if err != nil {
		return stripHTML(input)
	}
	var sb strings.Builder
	walkNode(doc, &sb)
	out := sb.String()
	// Collapse 3+ blank lines to 2.
	return normalizeBlankLines(out)
}

func walkNode(n *html.Node, sb *strings.Builder) {
	if n == nil {
		return
	}
	switch n.Type {
	case html.TextNode:
		text := strings.TrimSpace(n.Data)
		if text != "" {
			sb.WriteString(text)
			sb.WriteByte(' ')
		}
	case html.ElementNode:
		renderElement(n, sb)
		return
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		walkNode(c, sb)
	}
}

func renderElement(n *html.Node, sb *strings.Builder) {
	tag := n.Data
	switch tag {
	case "br":
		sb.WriteString("\n")
		walkChildren(n, sb)
	case "p", "div", "section", "article", "main", "header", "footer", "figure":
		walkChildren(n, sb)
		sb.WriteString("\n\n")
	case "h1":
		sb.WriteString("\n\n# ")
		walkChildren(n, sb)
		sb.WriteString("\n\n")
	case "h2":
		sb.WriteString("\n\n## ")
		walkChildren(n, sb)
		sb.WriteString("\n\n")
	case "h3":
		sb.WriteString("\n\n### ")
		walkChildren(n, sb)
		sb.WriteString("\n\n")
	case "h4":
		sb.WriteString("\n\n#### ")
		walkChildren(n, sb)
		sb.WriteString("\n\n")
	case "h5", "h6":
		sb.WriteString("\n\n##### ")
		walkChildren(n, sb)
		sb.WriteString("\n\n")
	case "hr":
		sb.WriteString("\n\n---\n\n")
		walkChildren(n, sb)
	case "ul":
		sb.WriteString("\n")
		renderListItems(n, sb, false)
		sb.WriteString("\n")
	case "ol":
		sb.WriteString("\n")
		renderListItems(n, sb, true)
		sb.WriteString("\n")
	case "li":
		// Standalone <li> (no list parent rendered it): emit a bullet.
		sb.WriteString("- ")
		walkChildren(n, sb)
		sb.WriteString("\n")
	case "blockquote":
		sb.WriteString("\n> ")
		walkChildren(n, sb)
		sb.WriteString("\n\n")
	case "strong", "b":
		sb.WriteString("**")
		walkChildren(n, sb)
		sb.WriteString("**")
	case "em", "i":
		sb.WriteString("_")
		walkChildren(n, sb)
		sb.WriteString("_")
	case "code":
		// Inline code (block code is handled by <pre>).
		if hasAncestor(n, "pre") {
			walkChildren(n, sb)
		} else {
			sb.WriteString("`")
			walkChildren(n, sb)
			sb.WriteString("`")
		}
	case "pre":
		sb.WriteString("\n```\n")
		walkChildren(n, sb)
		sb.WriteString("\n```\n\n")
	case "a":
		href := getAttr(n, "href")
		var inner strings.Builder
		walkChildren(n, &inner)
		text := strings.TrimSpace(inner.String())
		if text == "" {
			text = href
		}
		if href != "" && href != "#" {
			sb.WriteString("[")
			sb.WriteString(text)
			sb.WriteString("](")
			sb.WriteString(href)
			sb.WriteString(")")
		} else {
			sb.WriteString(text)
		}
	case "img":
		src := getAttr(n, "src")
		alt := getAttr(n, "alt")
		if src != "" {
			sb.WriteString("![")
			sb.WriteString(alt)
			sb.WriteString("](")
			sb.WriteString(src)
			sb.WriteString(")")
		}
	case "table":
		// Flatten tables to text rows; full GFM table rendering is overkill here.
		sb.WriteString("\n")
		renderTable(n, sb)
		sb.WriteString("\n")
	case "script", "style", "noscript", "svg":
		// Drop non-content elements.
		return
	default:
		walkChildren(n, sb)
	}
}

func walkChildren(n *html.Node, sb *strings.Builder) {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		walkNode(c, sb)
	}
}

func renderListItems(listNode *html.Node, sb *strings.Builder, ordered bool) {
	idx := 0
	for c := listNode.FirstChild; c != nil; c = c.NextSibling {
		if c.Type != html.ElementNode || c.Data != "li" {
			continue
		}
		idx++
		if ordered {
			sb.WriteString(itoa(idx))
			sb.WriteString(". ")
		} else {
			sb.WriteString("- ")
		}
		walkChildren(c, sb)
		sb.WriteString("\n")
	}
}

func renderTable(tableNode *html.Node, sb *strings.Builder) {
	rowIdx := 0
	var walkRows func(*html.Node)
	walkRows = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "tr" {
			cells := collectCells(n)
			sb.WriteString("| ")
			sb.WriteString(strings.Join(cells, " | "))
			sb.WriteString(" |\n")
			if rowIdx == 0 {
				// Header separator after first row.
				sb.WriteString("|")
				for range cells {
					sb.WriteString(" --- |")
				}
				sb.WriteString("\n")
			}
			rowIdx++
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walkRows(c)
		}
	}
	walkRows(tableNode)
}

func collectCells(tr *html.Node) []string {
	var cells []string
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && (n.Data == "td" || n.Data == "th") {
			var inner strings.Builder
			walkChildren(n, &inner)
			cells = append(cells, strings.TrimSpace(inner.String()))
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(tr)
	if len(cells) == 0 {
		return []string{""}
	}
	return cells
}

func getAttr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func hasAncestor(n *html.Node, tag string) bool {
	for p := n.Parent; p != nil; p = p.Parent {
		if p.Type == html.ElementNode && p.Data == tag {
			return true
		}
	}
	return false
}

func normalizeBlankLines(s string) string {
	out := s
	for {
		replaced := strings.ReplaceAll(out, "\n\n\n", "\n\n")
		if len(replaced) == len(out) {
			break
		}
		out = replaced
	}
	return strings.TrimSpace(out)
}

func itoa(i int) string {
	// Small, avoids strconv import in this file.
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}
