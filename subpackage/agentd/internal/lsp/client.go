package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Client is a JSON-RPC 2.0 client for LSP over stdio.
type Client struct {
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	stdout      io.ReadCloser
	scanner     *bufio.Scanner
	nextID      atomic.Int64
	pending     map[int64]chan *jsonRPCResponse
	pendingLock sync.Mutex
	rootURI     string
	languageID  string
	initialized bool
	shutdown    bool
	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
}

type jsonRPCRequest struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      int64       `json:"id,omitempty"`
	Method  string      `json:"method"`
	Params  any `json:"params,omitempty"`
}

type jsonRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int64           `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *jsonRPCError   `json:"error,omitempty"`
}

type jsonRPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// NewClient creates a new LSP client that communicates with the given command.
// The command should be the LSP server executable with its arguments.
// rootURI is the workspace root (e.g., "file:///path/to/project").
// languageID is the language identifier (e.g., "rust", "go", "cpp").
func NewClient(ctx context.Context, command string, args []string, rootURI, languageID string) (*Client, error) {
	cmd := exec.CommandContext(ctx, command, args...)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return nil, fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	// Redirect stderr to our logger
	cmd.Stderr = &stderrLogger{prefix: command}

	if err := cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		return nil, fmt.Errorf("failed to start LSP server: %w", err)
	}

	clientCtx, cancel := context.WithCancel(ctx)

	client := &Client{
		cmd:        cmd,
		stdin:      stdin,
		stdout:     stdout,
		scanner:    bufio.NewScanner(stdout),
		pending:    make(map[int64]chan *jsonRPCResponse),
		rootURI:    rootURI,
		languageID: languageID,
		ctx:        clientCtx,
		cancel:     cancel,
	}

	// Start reading responses in background
	client.wg.Add(1)
	go client.readLoop()

	return client, nil
}

// Initialize sends the initialize request to the LSP server.
func (c *Client) Initialize(ctx context.Context) error {
	if c.initialized {
		return nil
	}

	pid := 0
	params := InitializeParams{
		ProcessID: &pid,
		RootURI:   c.rootURI,
		Capabilities: ClientCapabilities{
			TextDocument: &TextDocumentClientCapabilities{
				Definition: &DefinitionCapabilities{
					LinkSupport: true,
				},
				Hover: &HoverCapabilities{
					ContentFormat: []string{"markdown", "plaintext"},
				},
				References: &ReferencesCapabilities{},
				DocumentSymbol: &DocumentSymbolCapabilities{
					HierarchicalDocumentSymbolSupport: true,
				},
			},
		},
	}

	var result InitializeResult
	if err := c.call(ctx, "initialize", params, &result); err != nil {
		return fmt.Errorf("initialize failed: %w", err)
	}

	// Send initialized notification
	if err := c.notify("initialized", struct{}{}); err != nil {
		return fmt.Errorf("initialized notification failed: %w", err)
	}

	c.initialized = true
	slog.Debug("LSP client initialized", "rootURI", c.rootURI)
	return nil
}

// DidOpen notifies the server that a document was opened.
func (c *Client) DidOpen(uri, text string) error {
	params := DidOpenTextDocumentParams{
		TextDocument: TextDocumentItem{
			URI:        uri,
			LanguageID: c.languageID,
			Version:    1,
			Text:       text,
		},
	}
	return c.notify("textDocument/didOpen", params)
}

// DidChange notifies the server that a document changed.
func (c *Client) DidChange(uri, text string, version int) error {
	params := DidChangeTextDocumentParams{
		TextDocument: VersionedTextDocumentIdentifier{
			URI:     uri,
			Version: version,
		},
		ContentChanges: []TextDocumentContentChangeEvent{
			{Text: text},
		},
	}
	return c.notify("textDocument/didChange", params)
}

// DidClose notifies the server that a document was closed.
func (c *Client) DidClose(uri string) error {
	params := DidCloseTextDocumentParams{
		TextDocument: TextDocumentIdentifier{URI: uri},
	}
	return c.notify("textDocument/didClose", params)
}

// Definition requests the definition location of a symbol.
func (c *Client) Definition(ctx context.Context, uri string, line, character int) ([]Location, error) {
	params := DefinitionParams{
		TextDocumentPositionParams: TextDocumentPositionParams{
			TextDocument: TextDocumentIdentifier{URI: uri},
			Position:     Position{Line: line, Character: character},
		},
	}

	var result any
	if err := c.call(ctx, "textDocument/definition", params, &result); err != nil {
		return nil, err
	}

	// Result can be Location | Location[] | null
	return parseLocationResult(result)
}

// Hover requests hover information at a position.
func (c *Client) Hover(ctx context.Context, uri string, line, character int) (*Hover, error) {
	params := HoverParams{
		TextDocumentPositionParams: TextDocumentPositionParams{
			TextDocument: TextDocumentIdentifier{URI: uri},
			Position:     Position{Line: line, Character: character},
		},
	}

	var result *Hover
	if err := c.call(ctx, "textDocument/hover", params, &result); err != nil {
		return nil, err
	}

	return result, nil
}

// References finds all references to a symbol.
func (c *Client) References(ctx context.Context, uri string, line, character int, includeDeclaration bool) ([]Location, error) {
	params := ReferenceParams{
		TextDocumentPositionParams: TextDocumentPositionParams{
			TextDocument: TextDocumentIdentifier{URI: uri},
			Position:     Position{Line: line, Character: character},
		},
		Context: ReferenceContext{
			IncludeDeclaration: includeDeclaration,
		},
	}

	var result []Location
	if err := c.call(ctx, "textDocument/references", params, &result); err != nil {
		return nil, err
	}

	return result, nil
}

// DocumentSymbol requests all symbols in a document.
func (c *Client) DocumentSymbol(ctx context.Context, uri string) (any, error) {
	params := DocumentSymbolParams{
		TextDocument: TextDocumentIdentifier{URI: uri},
	}

	var result any
	if err := c.call(ctx, "textDocument/documentSymbol", params, &result); err != nil {
		return nil, err
	}

	// Result can be DocumentSymbol[] | SymbolInformation[]
	return result, nil
}

// Close shuts down the LSP server and closes the connection.
func (c *Client) Close() error {
	if c.shutdown {
		return nil
	}

	c.shutdown = true

	// Send shutdown request (ignore errors, we're closing anyway)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = c.call(ctx, "shutdown", nil, nil)

	// Send exit notification
	_ = c.notify("exit", nil)

	// Cancel context and wait for read loop
	c.cancel()

	// Close pipes
	c.stdin.Close()
	c.stdout.Close()

	// Wait for process with timeout
	done := make(chan error, 1)
	go func() {
		done <- c.cmd.Wait()
	}()

	select {
	case <-time.After(3 * time.Second):
		c.cmd.Process.Kill()
		<-done
	case <-done:
	}

	c.wg.Wait()
	slog.Debug("LSP client closed", "rootURI", c.rootURI)
	return nil
}

// call sends a JSON-RPC request and waits for the response.
func (c *Client) call(ctx context.Context, method string, params, result any) error {
	id := c.nextID.Add(1)

	req := jsonRPCRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  method,
		Params:  params,
	}

	// Register response channel
	respChan := make(chan *jsonRPCResponse, 1)
	c.pendingLock.Lock()
	c.pending[id] = respChan
	c.pendingLock.Unlock()

	defer func() {
		c.pendingLock.Lock()
		delete(c.pending, id)
		c.pendingLock.Unlock()
	}()

	// Send request
	if err := c.send(req); err != nil {
		return err
	}

	// Wait for response
	select {
	case <-ctx.Done():
		return ctx.Err()
	case resp := <-respChan:
		if resp.Error != nil {
			return fmt.Errorf("LSP error %d: %s", resp.Error.Code, resp.Error.Message)
		}
		if result != nil && resp.Result != nil {
			if err := json.Unmarshal(resp.Result, result); err != nil {
				return fmt.Errorf("failed to unmarshal result: %w", err)
			}
		}
		return nil
	}
}

// notify sends a JSON-RPC notification (no response expected).
func (c *Client) notify(method string, params any) error {
	req := jsonRPCRequest{
		JSONRPC: "2.0",
		Method:  method,
		Params:  params,
	}
	return c.send(req)
}

// send writes a JSON-RPC message to the server.
func (c *Client) send(msg any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to marshal message: %w", err)
	}

	header := fmt.Sprintf("Content-Length: %d\r\n\r\n", len(data))

	c.pendingLock.Lock()
	defer c.pendingLock.Unlock()

	if _, err := c.stdin.Write([]byte(header)); err != nil {
		return fmt.Errorf("failed to write header: %w", err)
	}
	if _, err := c.stdin.Write(data); err != nil {
		return fmt.Errorf("failed to write body: %w", err)
	}

	return nil
}

// readLoop reads JSON-RPC messages from the server.
func (c *Client) readLoop() {
	defer c.wg.Done()

	for {
		select {
		case <-c.ctx.Done():
			return
		default:
		}

		// Read headers
		headers := make(map[string]string)
		for {
			if !c.scanner.Scan() {
				if err := c.scanner.Err(); err != nil && err != io.EOF {
					slog.Error("LSP scanner error", "error", err)
				}
				return
			}

			line := c.scanner.Text()
			if line == "" {
				break
			}

			parts := strings.SplitN(line, ": ", 2)
			if len(parts) == 2 {
				headers[parts[0]] = parts[1]
			}
		}

		// Parse content length
		contentLengthStr, ok := headers["Content-Length"]
		if !ok {
			slog.Warn("LSP message missing Content-Length")
			continue
		}

		contentLength, err := strconv.Atoi(contentLengthStr)
		if err != nil {
			slog.Warn("LSP invalid Content-Length", "value", contentLengthStr)
			continue
		}

		// Read body
		body := make([]byte, contentLength)
		totalRead := 0
		for totalRead < contentLength {
			if !c.scanner.Scan() {
				if err := c.scanner.Err(); err != nil && err != io.EOF {
					slog.Error("LSP body read error", "error", err)
				}
				return
			}
			line := c.scanner.Text()
			n := copy(body[totalRead:], []byte(line))
			totalRead += n
			if totalRead < contentLength {
				// Add back newline that scanner stripped
				if totalRead < contentLength {
					body[totalRead] = '\n'
					totalRead++
				}
			}
		}

		// Parse response
		var resp jsonRPCResponse
		if err := json.Unmarshal(body, &resp); err != nil {
			slog.Warn("LSP failed to parse response", "error", err, "body", string(body))
			continue
		}

		// Dispatch to pending request
		if resp.ID > 0 {
			c.pendingLock.Lock()
			ch, ok := c.pending[resp.ID]
			c.pendingLock.Unlock()

			if ok {
				select {
				case ch <- &resp:
				default:
					slog.Warn("LSP response channel full", "id", resp.ID)
				}
			}
		}
	}
}

// parseLocationResult converts various LSP definition result formats to []Location.
func parseLocationResult(result any) ([]Location, error) {
	if result == nil {
		return nil, nil
	}

	// Try to marshal and unmarshal as Location array
	data, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}

	// Try as array first
	var locations []Location
	if err := json.Unmarshal(data, &locations); err == nil {
		return locations, nil
	}

	// Try as single location
	var location Location
	if err := json.Unmarshal(data, &location); err == nil {
		return []Location{location}, nil
	}

	return nil, fmt.Errorf("unexpected definition result format")
}

// stderrLogger captures LSP server stderr and logs it.
type stderrLogger struct {
	prefix string
}

func (l *stderrLogger) Write(p []byte) (n int, err error) {
	msg := strings.TrimSpace(string(p))
	if msg != "" {
		slog.Debug("LSP stderr", "server", l.prefix, "msg", msg)
	}
	return len(p), nil
}
