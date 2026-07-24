// Package jsonstream defines agentd's stdout JSON Lines contract for
// lightweight local plugins (Rust / Python / shell scripts spawned by the
// daemon).
//
// Borrowed from aionrs' --json-stream protocol
// (crates/aion-cli/src/json_stream/). aionrs runs a full bidirectional
// Event/Command/Approval protocol over stdin+stdout. AgentBoster only needs
// the OUTPUT half today: a spawned child process emits one JSON object per
// line on stdout, this package parses each line into a typed Event, and the
// spawner (task stream / tool executor) forwards them as structured SSE
// events instead of opaque text blobs.
//
// Why a contract at all: today agentd treats captured child stdout as an
// opaque string (exec_worker.go maxOutputBytes = 100 KiB hard cap, then
// fed verbatim into ExecResult.Stdout). That's fine for `ls` / `git status`
// but throws away structure when the child IS an agent (a python tool that
// emits progress events, a rust helper that streams findings). A shared
// line-delimited JSON contract lets those children produce rich, typed
// output without agentd knowing anything child-specific.
//
// The contract is intentionally minimal — four event kinds:
//
//   {"type":"log","level":"info","message":"..."}
//   {"type":"progress","current":N,"total":M,"label":"..."}
//   {"type":"result","data":<any json>}
//   {"type":"error","message":"...","code":"..."}
//
// Lines that don't parse as JSON or that omit `type` are surfaced as `log`
// events at info level so partially-conforming children still produce
// useful output instead of being silently dropped.
package jsonstream

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// EventKind is the discriminator for the four event types.
type EventKind string

const (
	KindLog     EventKind = "log"
	KindProgress EventKind = "progress"
	KindResult  EventKind = "result"
	KindError   EventKind = "error"
)

// Event is the parsed shape of one stdout JSON line. Exactly one of the
// kind-specific fields is populated, keyed off `type`.
type Event struct {
	Kind EventKind `json:"type"`

	// Log + Error
	Level   string `json:"level,omitempty"`
	Message string `json:"message,omitempty"`
	Code    string `json:"code,omitempty"`

	// Progress
	Current *int   `json:"current,omitempty"`
	Total   *int   `json:"total,omitempty"`
	Label   string `json:"label,omitempty"`

	// Result (arbitrary JSON payload)
	Data json.RawMessage `json:"data,omitempty"`

	// Line is the original raw line (useful for debugging / fallback).
	Line string `json:"-"`
}

// ParseLine parses a single stdout line into an Event. Returns an event
// of KindLog even when the line isn't valid JSON or lacks a type, so the
// spawner can treat every line uniformly. The error is non-nil only when
// the line was non-empty but unparseable (callers may log it).
func ParseLine(line string) (Event, error) {
	trimmed := strings.TrimRight(line, "\r\n")
	if strings.TrimSpace(trimmed) == "" {
		return Event{}, io.EOF // sentinel for blank lines handled by scanner
	}

	var ev Event
	if err := json.Unmarshal([]byte(trimmed), &ev); err != nil {
		// Non-JSON line: surface as an info log so the output isn't lost.
		return Event{
			Kind:    KindLog,
			Level:   "info",
			Message: trimmed,
			Line:    trimmed,
		}, fmt.Errorf("line is not JSON: %w", err)
	}
	ev.Line = trimmed

	// Default missing/unknown type to log so partially-conforming children
	// still surface their text. Override the discriminator so downstream
	// switches don't silently drop the line.
	if ev.Kind == "" {
		ev.Kind = KindLog
		// If the JSON had a "message" field but no type, keep it; else
		// fall back to the raw line so nothing is lost.
		if ev.Message == "" {
			ev.Message = trimmed
		}
	}
	if ev.Kind == KindLog && ev.Level == "" {
		ev.Level = "info"
	}
	return ev, nil
}

// Scanner reads newline-delimited JSON events from an io.Reader. It is the
// expected entry point for stream-parsing a child process's stdout.
type Scanner struct {
	r       *bufio.Scanner
	closed  bool
	lastErr error
}

// NewScanner returns a Scanner that reads from r. The internal bufio
// scanner's max token size is raised so a single large event line (e.g. a
// result with a big JSON payload) isn't truncated.
func NewScanner(r io.Reader) *Scanner {
	scan := bufio.NewScanner(r)
	scan.Buffer(make([]byte, 0, 64*1024), 4*1024*1024) // up to 4MB / line
	return &Scanner{r: scan}
}

// Next reads and parses the next event. Returns io.EOF when the stream is
// exhausted. Blank lines are skipped silently.
func (s *Scanner) Next() (Event, error) {
	for {
		if !s.r.Scan() {
			s.closed = true
			if err := s.r.Err(); err != nil {
				s.lastErr = err
				return Event{}, err
			}
			return Event{}, io.EOF
		}
		line := s.r.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		ev, err := ParseLine(line)
		if err != nil {
			s.lastErr = err
			// Still return the recovered event (ParseLine always returns one).
			return ev, err
		}
		return ev, nil
	}
}

// Err returns the first non-EOF error encountered, or nil. Mirrors
// bufio.Scanner.Err semantics.
func (s *Scanner) Err() error {
	if s.lastErr == io.EOF {
		return nil
	}
	return s.lastErr
}
