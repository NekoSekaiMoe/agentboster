package agent

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/eventbus"
	"github.com/clawless/agentd/internal/security/l2_auth"
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

// Question is a convenience wrapper around DecisionQueue for LLM-initiated questions.
// It translates QuestionPrompt → Decision and delegates to DecisionQueue.Ask().
type QuestionService struct {
	queue    *l2_auth.DecisionQueue
	bus      *eventbus.Bus
	clawless *clawless.Client
}

// NewQuestionService creates a new question service backed by the decision queue.
func NewQuestionService(queue *l2_auth.DecisionQueue, bus *eventbus.Bus, client *clawless.Client) *QuestionService {
	return &QuestionService{
		queue:    queue,
		bus:      bus,
		clawless: client,
	}
}

// Ask publishes a question to the user and blocks until they respond.
func (qs *QuestionService) Ask(ctx context.Context, sessionID string, prompts []QuestionPrompt) ([][]string, error) {
	// Build prompts for the decision
	dqPrompts := make([]l2_auth.Prompt, len(prompts))
	for i, p := range prompts {
		opts := make([]string, len(p.Options))
		for j, o := range p.Options {
			opts[j] = o.Label
		}
		dqPrompts[i] = l2_auth.Prompt{
			Question: p.Question,
			Header:   p.Header,
			Options:  opts,
			Multiple: p.Multiple,
		}
	}

	// Use the first prompt's question as the main question
	question := ""
	if len(prompts) > 0 {
		question = prompts[0].Question
	}

	decision := &l2_auth.Decision{
		Type:      l2_auth.DecisionTypeQuestion,
		SessionID: sessionID,
		Question:  question,
		Prompts:   dqPrompts,
	}

	slog.Info("question asked", "session_id", sessionID, "prompts", len(prompts))

	// Publish event so the frontend can display the question
	if qs.bus != nil {
		qs.bus.Publish("question.asked", map[string]any{
			"session_id": sessionID,
			"prompts":    prompts,
		})
	}

	// Notify via Clawless API
	if qs.clawless != nil {
		notification := clawless.Notification{
			Type:    "question",
			Title:   "Agent 向您提问",
			Message: formatQuestionMessage(prompts),
			Metadata: map[string]any{
				"session_id": sessionID,
				"prompts":    prompts,
			},
		}
		if err := qs.clawless.CreateNotification(ctx, &notification); err != nil {
			slog.Warn("failed to create question notification", "error", err)
		}
	}

	// Block via DecisionQueue
	answers, err := qs.queue.Ask(ctx, decision)
	if err != nil {
		return nil, err
	}

	slog.Info("question answered", "session_id", sessionID)
	return answers, nil
}

// Reply resolves a pending question with user answers.
func (qs *QuestionService) Reply(decisionID string, answers [][]string) error {
	return qs.queue.ResolveWithAnswers(decisionID, answers)
}

// Reject dismisses a pending question.
func (qs *QuestionService) Reject(decisionID string) error {
	return qs.queue.Reject(decisionID)
}

// ListPending returns all pending decisions (both L2 and questions).
func (qs *QuestionService) ListPending() []*l2_auth.Decision {
	return qs.queue.ListPending()
}

// GetQuestion returns a pending decision by ID.
func (qs *QuestionService) GetQuestion(decisionID string) (*l2_auth.Decision, bool) {
	d, err := qs.queue.GetByDecisionID(decisionID)
	if err != nil {
		return nil, false
	}
	return d, true
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

// Ensure DecisionQueue implements the Askable interface.
var _ Askable = (*l2_auth.DecisionQueue)(nil)

// Askable is the interface for blocking question-ask systems.
type Askable interface {
	Ask(ctx context.Context, decision *l2_auth.Decision) ([][]string, error)
	Resolve(decisionID, action, resolvedBy string) error
	ResolveWithAnswers(decisionID string, answers [][]string) error
	Deny(decisionID, resolvedBy string) error
	Reject(decisionID string) error
	ListPending() []*l2_auth.Decision
	GetByDecisionID(id string) (*l2_auth.Decision, error)
	Count(status string) int
	AddChannel(decisionID, channel string)
	GetPendingTaskIDs() map[string]bool
	HasPendingDecision(taskID string) bool
}
