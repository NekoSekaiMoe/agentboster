package logging

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func TestHandlerFormat(t *testing.T) {
	var buf bytes.Buffer
	h := NewHandler(&buf, Config{
		Level:     "debug",
		Module:    "Core",
		AddSource: true,
	})
	logger := slog.New(h)

	logger.Info("Platform adapter registered", "adapter", "aiocqhttp")

	output := buf.String()
	// Should contain: [HH:MM:SS.mmm] [Core] [INFO] [func:line]: Platform adapter registered adapter=aiocqhttp
	if !strings.Contains(output, "[Core]") {
		t.Errorf("expected [Core] in output, got: %s", output)
	}
	if !strings.Contains(output, "[INFO]") {
		t.Errorf("expected [INFO] in output, got: %s", output)
	}
	if !strings.Contains(output, "Platform adapter registered") {
		t.Errorf("expected message in output, got: %s", output)
	}
	if !strings.Contains(output, "adapter=aiocqhttp") {
		t.Errorf("expected attr in output, got: %s", output)
	}
	t.Logf("output: %s", output)
}

func TestHandlerLevels(t *testing.T) {
	var buf bytes.Buffer
	h := NewHandler(&buf, Config{
		Level:     "debug",
		Module:    "Test",
		AddSource: false,
	})
	logger := slog.New(h)

	logger.Debug("debug msg")
	logger.Info("info msg")
	logger.Warn("warn msg")
	logger.Error("error msg")

	output := buf.String()
	for _, level := range []string{"[DBUG]", "[INFO]", "[WARN]", "[ERRO]"} {
		if !strings.Contains(output, level) {
			t.Errorf("expected %s in output", level)
		}
	}
	t.Logf("output:\n%s", output)
}

func TestHandlerLevelFilter(t *testing.T) {
	var buf bytes.Buffer
	h := NewHandler(&buf, Config{
		Level:     "warn",
		Module:    "Test",
		AddSource: false,
	})
	logger := slog.New(h)

	logger.Debug("should not appear")
	logger.Info("should not appear")
	logger.Warn("should appear")

	output := buf.String()
	if strings.Contains(output, "should not appear") {
		t.Errorf("debug/info should be filtered, got: %s", output)
	}
	if !strings.Contains(output, "should appear") {
		t.Errorf("warn should appear, got: %s", output)
	}
}
