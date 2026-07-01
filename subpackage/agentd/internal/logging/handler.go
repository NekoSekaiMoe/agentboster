package logging

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

// Config controls the custom text logger.
type Config struct {
	Level     string `mapstructure:"level" default:"info"`
	Module    string `mapstructure:"module" default:"AgentD"`
	AddSource bool   `mapstructure:"add_source" default:"true"`
}

// Handler implements slog.Handler with AstrBot-style text format:
//
//	[HH:MM:SS.mmm] [Module] [LEVEL] [func.name:line]: message key=value ...
type Handler struct {
	level     slog.Level
	module    string
	addSource bool
	mu        sync.Mutex
	w         io.Writer
	attrs     string // pre-formatted WithAttrs
	group     string // current group prefix
}

// NewHandler creates a new custom text handler.
func NewHandler(w io.Writer, cfg Config) *Handler {
	level := slog.LevelInfo
	switch strings.ToLower(cfg.Level) {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}

	module := cfg.Module
	if module == "" {
		module = "AgentD"
	}

	return &Handler{
		level:     level,
		module:    module,
		addSource: cfg.AddSource,
		w:         w,
	}
}

func (h *Handler) Enabled(_ context.Context, level slog.Level) bool {
	return level >= h.level
}

func (h *Handler) Handle(_ context.Context, r slog.Record) error {
	var buf bytes.Buffer

	// [HH:MM:SS.mmm]
	buf.WriteString("[")
	buf.WriteString(r.Time.Format("15:04:05.000"))
	buf.WriteString("] ")

	// [Module]
	buf.WriteString("[")
	buf.WriteString(h.module)
	buf.WriteString("] ")

	// [LEVEL]
	buf.WriteString("[")
	buf.WriteString(formatLevel(r.Level))
	buf.WriteString("] ")

	// [func.name:line]
	if h.addSource {
		if pc := r.PC; pc != 0 {
			frame, _ := runtime.CallersFrames([]uintptr{pc}).Next()
			if frame.Function != "" {
				funcName := frame.Function
				// Strip package path, keep only function name
				if idx := strings.LastIndex(funcName, "."); idx >= 0 {
					funcName = funcName[idx+1:]
				}
				buf.WriteString("[")
				buf.WriteString(funcName)
				buf.WriteString(":")
				buf.WriteString(strconv.Itoa(frame.Line))
				buf.WriteString("] ")
			}
		}
	}

	// message
	buf.WriteString(r.Message)

	// pre-formatted attrs from WithAttrs
	if h.attrs != "" {
		buf.WriteString(h.attrs)
	}

	// inline attrs from the record
	r.Attrs(func(a slog.Attr) bool {
		buf.WriteString(" ")
		buf.WriteString(formatAttr(a))
		return true
	})

	buf.WriteString("\n")

	h.mu.Lock()
	defer h.mu.Unlock()
	_, err := h.w.Write(buf.Bytes())
	return err
}

func (h *Handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	if len(attrs) == 0 {
		return h
	}
	// Clone with pre-formatted attrs
	var buf bytes.Buffer
	for _, a := range attrs {
		buf.WriteString(" ")
		buf.WriteString(formatAttr(a))
	}
	newH := &Handler{
		level:     h.level,
		module:    h.module,
		addSource: h.addSource,
		w:         h.w,
		attrs:     h.attrs + buf.String(),
		group:     h.group,
	}
	return newH
}

func (h *Handler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	newH := &Handler{
		level:     h.level,
		module:    h.module,
		addSource: h.addSource,
		w:         h.w,
		attrs:     h.attrs,
		group:     h.group + name + ".",
	}
	return newH
}

func formatLevel(level slog.Level) string {
	switch {
	case level <= slog.LevelDebug:
		return "DBUG"
	case level <= slog.LevelInfo:
		return "INFO"
	case level <= slog.LevelWarn:
		return "WARN"
	default:
		return "ERRO"
	}
}

func formatAttr(a slog.Attr) string {
	a.Value = a.Value.Resolve()
	if a.Value.Kind() == slog.KindGroup {
		attrs := a.Value.Group()
		if len(attrs) == 0 {
			return ""
		}
		var buf bytes.Buffer
		for i, g := range attrs {
			if i > 0 {
				buf.WriteString(" ")
			}
			buf.WriteString(a.Key)
			buf.WriteString(".")
			buf.WriteString(formatAttr(g))
		}
		return buf.String()
	}
	return a.Key + "=" + quoteValue(a.Value)
}

func quoteValue(v slog.Value) string {
	s := v.String()
	if strings.ContainsAny(s, " \t\n\"=") {
		return strconv.Quote(s)
	}
	return s
}
