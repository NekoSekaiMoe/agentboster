package eventbus

import (
	"log/slog"
	"sync"
	"time"
)

// Bus implements a simple publish/subscribe event bus (replicating Asika pattern).
type Bus struct {
	mu       sync.RWMutex
	handlers map[EventType][]Handler
}

// New creates a new EventBus.
func New() *Bus {
	return &Bus{
		handlers: make(map[EventType][]Handler),
	}
}

// Subscribe registers a handler for the given event type.
func (b *Bus) Subscribe(eventType EventType, handler Handler) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.handlers[eventType] = append(b.handlers[eventType], handler)
}

// Publish emits an event to all registered handlers synchronously.
func (b *Bus) Publish(eventType EventType, payload any) {
	b.mu.RLock()
	handlers := make([]Handler, len(b.handlers[eventType]))
	copy(handlers, b.handlers[eventType])
	b.mu.RUnlock()

	event := Event{
		Type:      eventType,
		Payload:   payload,
		Timestamp: time.Now(),
	}

	for _, h := range handlers {
		h(event)
	}
}

// PublishAsync emits an event to all registered handlers in goroutines.
func (b *Bus) PublishAsync(eventType EventType, payload any) {
	b.mu.RLock()
	handlers := make([]Handler, len(b.handlers[eventType]))
	copy(handlers, b.handlers[eventType])
	b.mu.RUnlock()

	event := Event{
		Type:      eventType,
		Payload:   payload,
		Timestamp: time.Now(),
	}

	for _, h := range handlers {
		go func(handler Handler) {
			defer func() {
				if r := recover(); r != nil {
					slog.Error("event handler panic", "event", eventType, "error", r)
				}
			}()
			handler(event)
		}(h)
	}
}

// HasSubscribers returns true if the event type has any subscribers.
func (b *Bus) HasSubscribers(eventType EventType) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.handlers[eventType]) > 0
}
