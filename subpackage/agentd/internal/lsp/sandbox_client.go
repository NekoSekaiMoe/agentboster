package lsp

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
)

// SandboxClient wraps an LSP client that runs inside a sandbox/container.
// It bridges communication between the host and the LSP server running inside
// the sandbox via lxc-attach or similar mechanism.
type SandboxClient struct {
	client     *Client
	bridgeCmd  *exec.Cmd
	stdinPipe  io.WriteCloser
	stdoutPipe io.ReadCloser
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

// NewSandboxClient creates an LSP client that runs inside an LXC container.
// sandboxID is the LXC container name.
// command and args are the LSP server executable and arguments.
// workDir is the working directory inside the container.
// rootURI is the file:// URI for the project root.
// languageID is the LSP language identifier.
func NewSandboxClient(
	ctx context.Context,
	sandboxID string,
	command string,
	args []string,
	workDir string,
	rootURI string,
	languageID string,
) (*SandboxClient, error) {
	// Build lxc-attach command to run LSP inside container
	// lxc-attach -n <container> -- /bin/sh -c "cd <workDir> && <command> <args>"
	var cmdBuilder strings.Builder
	cmdBuilder.WriteString("cd ")
	cmdBuilder.WriteString(workDir)
	cmdBuilder.WriteString(" && ")
	cmdBuilder.WriteString(command)
	for _, arg := range args {
		cmdBuilder.WriteString(" ")
		cmdBuilder.WriteString(arg)
	}
	cmdLine := cmdBuilder.String()

	lxcArgs := []string{
		"lxc-attach",
		"-n", sandboxID,
		"--",
		"/bin/sh", "-c", cmdLine,
	}

	bridgeCtx, cancel := context.WithCancel(ctx)
	bridgeCmd := exec.CommandContext(bridgeCtx, lxcArgs[0], lxcArgs[1:]...)

	// Create pipes for stdin/stdout
	stdinPipe, err := bridgeCmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	stdoutPipe, err := bridgeCmd.StdoutPipe()
	if err != nil {
		stdinPipe.Close()
		cancel()
		return nil, fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	// Stderr goes to logger
	bridgeCmd.Stderr = &stderrLogger{prefix: fmt.Sprintf("lsp-%s", sandboxID)}

	// Start the bridge command
	if err := bridgeCmd.Start(); err != nil {
		stdinPipe.Close()
		stdoutPipe.Close()
		cancel()
		return nil, fmt.Errorf("failed to start lxc-attach bridge: %w", err)
	}

	slog.Debug("LSP bridge started",
		"sandbox", sandboxID,
		"command", command,
		"workDir", workDir,
	)

	// Create LSP client that uses these pipes
	client := &Client{
		cmd:        bridgeCmd,
		stdin:      stdinPipe,
		stdout:     stdoutPipe,
		scanner:    bufio.NewScanner(stdoutPipe),
		pending:    make(map[int64]chan *jsonRPCResponse),
		rootURI:    rootURI,
		languageID: languageID,
		ctx:        bridgeCtx,
		cancel:     cancel,
	}

	// Start reading responses in background
	client.wg.Add(1)
	go client.readLoop()

	sandboxClient := &SandboxClient{
		client:     client,
		bridgeCmd:  bridgeCmd,
		stdinPipe:  stdinPipe,
		stdoutPipe: stdoutPipe,
		cancel:     cancel,
	}

	return sandboxClient, nil
}

// Initialize sends the initialize request to the LSP server.
func (sc *SandboxClient) Initialize(ctx context.Context) error {
	return sc.client.Initialize(ctx)
}

// DidOpen notifies the server that a document was opened.
func (sc *SandboxClient) DidOpen(uri, text string) error {
	return sc.client.DidOpen(uri, text)
}

// DidChange notifies the server that a document changed.
func (sc *SandboxClient) DidChange(uri, text string, version int) error {
	return sc.client.DidChange(uri, text, version)
}

// DidClose notifies the server that a document was closed.
func (sc *SandboxClient) DidClose(uri string) error {
	return sc.client.DidClose(uri)
}

// Definition requests the definition location of a symbol.
func (sc *SandboxClient) Definition(ctx context.Context, uri string, line, character int) ([]Location, error) {
	return sc.client.Definition(ctx, uri, line, character)
}

// Hover requests hover information at a position.
func (sc *SandboxClient) Hover(ctx context.Context, uri string, line, character int) (*Hover, error) {
	return sc.client.Hover(ctx, uri, line, character)
}

// References finds all references to a symbol.
func (sc *SandboxClient) References(ctx context.Context, uri string, line, character int, includeDeclaration bool) ([]Location, error) {
	return sc.client.References(ctx, uri, line, character, includeDeclaration)
}

// DocumentSymbol requests all symbols in a document.
func (sc *SandboxClient) DocumentSymbol(ctx context.Context, uri string) (any, error) {
	return sc.client.DocumentSymbol(ctx, uri)
}

// Close shuts down the LSP server and closes the bridge.
func (sc *SandboxClient) Close() error {
	// Close the LSP client
	if err := sc.client.Close(); err != nil {
		slog.Warn("LSP client close error", "error", err)
	}

	// Cancel the bridge context
	sc.cancel()

	// Close pipes
	sc.stdinPipe.Close()
	sc.stdoutPipe.Close()

	// Wait for bridge command
	sc.wg.Go(func() {
		sc.bridgeCmd.Wait()
	})
	sc.wg.Wait()

	return nil
}
