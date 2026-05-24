package agent

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/eventbus"
)

// QuestionOption represents a single choice in a question.
type QuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

// QuestionPrompt is a single question to ask the user.
type QuestionPrompt struct {
	Question  string           `json:"question"`
	Header    string           `json:"header"`
	Options   []QuestionOption `json:"options"`
	Multiple  bool             `json:"multiple"`
	Custom    bool             `json:"custom"`
}

// QuestionRequest is a full question request (may contain multiple prompts).
type QuestionRequest struct {
	ID        string           `json:"id"`
	SessionID string           `json:"session_id"`
	Prompts   []QuestionPrompt `json:"prompts"`
	Answers   [][]string       `json:"answers,omitempty"`
	Status    string           `json:"status"`
	CreatedAt time.Time        `json:"created_at"`
	ResolvedAt time.Time       `json:"resolved_at,omitempty"`
	Channel   string           `json:"channel,omitempty"`
}

const (
	QuestionStatusPending  = "pending"
	QuestionStatusSent     = "sent"
	QuestionStatusAnswered = "answered"
	QuestionStatusRejected = "rejected"
	QuestionStatusTimeout  = "timeout"
)

const (
	QuestionTimeout = 3 * time.Minute
)

// pendingEntry holds a question awaiting user response.
type pendingEntry struct {
	request  QuestionRequest
	resolve  chan [][]string
	reject   chan struct{}
}

// QuestionService manages LLM-initiated questions to the user.
type QuestionService struct {
	mu        sync.RWMutex
	pending   map[string]*pendingEntry
	bus       *eventbus.Bus
	clawless  *clawless.Client
	nextID    int64
}

// NewQuestionService creates a new question service.
func NewQuestionService(bus *eventbus.Bus, client *clawless.Client) *QuestionService {
	return &QuestionService{
		pending:  make(map[string]*pendingEntry),
		bus:      bus,
		clawless: client,
		nextID:   1,
	}
}

// Ask publishes a question to the user and waits for the response.
// Returns the answers (one per prompt) or an error if rejected/timed out.
func (qs *QuestionService) Ask(ctx context.Context, sessionID string, prompts []QuestionPrompt) ([][]string, error) {
	qs.mu.Lock()
	id := fmt.Sprintf("que_%d", qs.nextID)
	qs.nextID++

	entry := &pendingEntry{
		request: QuestionRequest{
			ID:        id,
			SessionID: sessionID,
			Prompts:   prompts,
			Status:    QuestionStatusSent,
			CreatedAt: time.Now(),
		},
		resolve: make(chan [][]string, 1),
		reject:  make(chan struct{}, 1),
	}
	qs.pending[id] = entry
	qs.mu.Unlock()

	slog.Info("question asked", "id", id, "session_id", sessionID, "prompts", len(prompts))

	// Publish event via EventBus
	if qs.bus != nil {
		qs.bus.Publish(eventbus.EventL2AuthRequired, map[string]any{
			"type":       "question",
			"question_id": id,
			"session_id": sessionID,
			"prompts":    prompts,
		})
	}

	// Also notify via Clawless API
	if qs.clawless != nil {
		notification := clawless.Notification{
			Type:    "question",
			Title:   "Agent 向您提问",
			Message: formatQuestionMessage(prompts),
			Metadata: map[string]any{
				"question_id": id,
				"session_id":  sessionID,
				"prompts":     prompts,
			},
		}
		if err := qs.clawless.CreateNotification(ctx, &notification); err != nil {
			slog.Warn("failed to create question notification", "error", err)
		}
	}

	// Wait for response or timeout
	select {
	case answers := <-entry.resolve:
		qs.mu.Lock()
		entry.request.Status = QuestionStatusAnswered
		entry.request.Answers = answers
		entry.request.ResolvedAt = time.Now()
		delete(qs.pending, id)
		qs.mu.Unlock()
		return answers, nil

	case <-entry.reject:
		qs.mu.Lock()
		entry.request.Status = QuestionStatusRejected
		delete(qs.pending, id)
		qs.mu.Unlock()
		return nil, fmt.Errorf("question rejected by user")

	case <-time.After(QuestionTimeout):
		qs.mu.Lock()
		entry.request.Status = QuestionStatusTimeout
		delete(qs.pending, id)
		qs.mu.Unlock()
		return nil, fmt.Errorf("question timed out after %v", QuestionTimeout)

	case <-ctx.Done():
		qs.mu.Lock()
		delete(qs.pending, id)
		qs.mu.Unlock()
		return nil, ctx.Err()
	}
}

// Reply resolves a pending question with user answers.
func (qs *QuestionService) Reply(questionID string, answers [][]string) error {
	qs.mu.Lock()
	entry, ok := qs.pending[questionID]
	qs.mu.Unlock()

	if !ok {
		return fmt.Errorf("question %s not found or already resolved", questionID)
	}

	entry.resolve <- answers
	return nil
}

// Reject dismisses a pending question.
func (qs *QuestionService) Reject(questionID string) error {
	qs.mu.Lock()
	entry, ok := qs.pending[questionID]
	qs.mu.Unlock()

	if !ok {
		return fmt.Errorf("question %s not found or already resolved", questionID)
	}

	entry.reject <- struct{}{}
	return nil
}

// ListPending returns all pending questions.
func (qs *QuestionService) ListPending() []QuestionRequest {
	qs.mu.RLock()
	defer qs.mu.RUnlock()

	result := make([]QuestionRequest, 0, len(qs.pending))
	for _, entry := range qs.pending {
		result = append(result, entry.request)
	}
	return result
}

// GetQuestion returns a pending question by ID.
func (qs *QuestionService) GetQuestion(questionID string) (*QuestionRequest, bool) {
	qs.mu.RLock()
	defer qs.mu.RUnlock()

	entry, ok := qs.pending[questionID]
	if !ok {
		return nil, false
	}
	return &entry.request, true
}

func formatQuestionMessage(prompts []QuestionPrompt) string {
	msg := "Agent 向您提问：\n\n"
	for i, p := range prompts {
		msg += fmt.Sprintf("%d. %s\n", i+1, p.Question)
		if p.Header != "" {
			msg += fmt.Sprintf("   [%s]\n", p.Header)
		}
		if len(p.Options) > 0 {
			for _, opt := range p.Options {
				msg += fmt.Sprintf("   - %s: %s\n", opt.Label, opt.Description)
			}
		}
		msg += "\n"
	}
	return msg
}
