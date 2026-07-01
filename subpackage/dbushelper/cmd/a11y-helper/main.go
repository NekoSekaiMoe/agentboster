// a11y-helper is a thin CLI wrapper around the dbushelper package. It
// runs INSIDE the agentd sandbox (NOT on the host) and is exec'd by
// agentd via sbMgr.Exec. The agentd daemon parses the JSON envelope
// printed on stdout and surfaces it to the Web workflow as a
// desktop_inspect / desktop_a11y_click / desktop_a11y_type tool result.
//
// Usage:
//
//	a11y-helper snapshot [--limit N]           # walk the tree, print JSON
//	a11y-helper click <ref>                    # DoAction on a snapshot ref
//	a11y-helper type <ref> <text>              # InsertText at the caret
//	a11y-helper fill <ref> <text>              # SetTextContents (replace)
//
// All subcommands print a single JSON object on stdout (no other output)
// so the host can decode stdout verbatim. Diagnostics and error context
// go to stderr, where they show up in agentd logs but never pollute the
// JSON envelope.
//
// The helper must be invoked with DBUS_SESSION_BUS_ADDRESS and DISPLAY
// set to match the sandbox's per-session D-Bus started in
// desktop.go::startStack (source desktop-env.sh before exec).

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	dbushelper "github.com/NekoSekaiMoe/agentboster/subpackage/dbushelper"
)

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  a11y-helper snapshot [--limit N]
  a11y-helper click <ref>
  a11y-helper type <ref> <text>
  a11y-helper fill <ref> <text>`)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	cmd := os.Args[1]
	args := os.Args[2:]

	var err error
	switch cmd {
	case "snapshot":
		err = runSnapshot(parseLimit(args))
	case "click":
		err = withRef(cmd, args, runClick)
	case "type":
		err = withRefText(cmd, args, runType)
	case "fill":
		err = withRefText(cmd, args, runFill)
	case "-h", "--help", "help":
		usage()
		return
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand %q\n", cmd)
		usage()
		os.Exit(2)
	}

	if err != nil {
		// Catastrophic errors (D-Bus unreachable, refs file unreadable,
		// JSON serialization failure). Per-action failures are NOT
		// returned here — they go out as JSON envelopes with ok=false.
		fmt.Fprintf(os.Stderr, "a11y-helper %s: %v\n", cmd, err)
		os.Exit(1)
	}
}

// emitJSON serializes v as a single JSON object on stdout. Errors here
// are catastrophic (the host cannot parse the output without it).
func emitJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}

func runSnapshot(limit int) error {
	out, err := dbushelper.RunSnapshot(limit)
	if err != nil {
		return err
	}
	return emitJSON(out)
}

func runClick(ref string) error {
	out, err := dbushelper.RunClick(ref)
	if err != nil {
		return err
	}
	return emitJSON(out)
}

func runType(ref, text string) error {
	out, err := dbushelper.RunType(ref, text)
	if err != nil {
		return err
	}
	return emitJSON(out)
}

func runFill(ref, text string) error {
	out, err := dbushelper.RunFill(ref, text)
	if err != nil {
		return err
	}
	return emitJSON(out)
}

// parseLimit extracts --limit N (default DefaultLimit) from the args
// after `snapshot`. Unknown flags are ignored to keep the surface
// flexible for future additions.
func parseLimit(args []string) int {
	limit := dbushelper.DefaultLimit
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--limit" && i+1 < len(args):
			if n, err := strconv.Atoi(args[i+1]); err == nil && n > 0 {
				limit = n
				i++
			}
		case len(args[i]) > 8 && args[i][:8] == "--limit=":
			if n, err := strconv.Atoi(args[i][8:]); err == nil && n > 0 {
				limit = n
			}
		}
	}
	return limit
}

func withRef(cmd string, args []string, fn func(string) error) error {
	if len(args) < 1 {
		fmt.Fprintf(os.Stderr, "%s: missing <ref> argument\n", cmd)
		usage()
		os.Exit(2)
	}
	return fn(args[0])
}

func withRefText(cmd string, args []string, fn func(string, string) error) error {
	if len(args) < 2 {
		fmt.Fprintf(os.Stderr, "%s: missing <ref> or <text> argument\n", cmd)
		usage()
		os.Exit(2)
	}
	return fn(args[0], args[1])
}
