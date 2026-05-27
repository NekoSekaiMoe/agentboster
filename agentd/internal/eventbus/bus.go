package eventbus

import (
	"log/slog"
	"sync"
	"time"
)

// Bus is the event bus. Internally delegates to a global channel-based pub/sub
// (from Asika). Each subscriber gets a buffered channel (100); slow subscribers
// have events dropped with a warning, preventing backpressure.
type Bus struct {
	mu          sync.RWMutex
	subscribers []chan Event
}

// New creates a new Bus.
func New() *Bus {
	return &Bus{
		subscribers: make([]chan Event, 0),
	}
}

// Subscribe registers a handler that receives events on a dedicated goroutine.
// Returns a cancel function to unsubscribe.
func (b *Bus) Subscribe(eventType EventType, handler func(Event)) (cancel func()) {
	ch := make(chan Event, 100)

	b.mu.Lock()
	b.subscribers = append(b.subscribers, ch)
	b.mu.Unlock()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for e := range ch {
			if e.Type == eventType {
				func() {
					defer func() {
						if r := recover(); r != nil {
							slog.Error("event handler panic", "event", eventType, "error", r)
						}
					}()
					handler(e)
				}()
			}
		}
	}()

	return func() {
		b.mu.Lock()
		for i, sub := range b.subscribers {
			if sub == ch {
				b.subscribers = append(b.subscribers[:i], b.subscribers[i+1:]...)
				close(ch)
				break
			}
		}
		b.mu.Unlock()
		<-done
	}
}

// Publish emits an event to all subscribers. Non-blocking: if a subscriber's
// channel is full, the event is dropped and logged.
func (b *Bus) Publish(eventType EventType, payload any) {
	e := Event{
		Type:      eventType,
		Payload:   payload,
		Timestamp: time.Now(),
	}

	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, ch := range b.subscribers {
		select {
		case ch <- e:
		default:
			slog.Warn("event dropped: subscriber channel full", "event_type", e.Type)
		}
	}
}

// HasSubscribers returns true if any subscriber channels exist.
func (b *Bus) HasSubscribers() bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.subscribers) > 0
}
