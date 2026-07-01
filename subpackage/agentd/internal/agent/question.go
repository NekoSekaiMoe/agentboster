package agent

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/eventbus"
)

// QuestionOption represents a single choice in a question.
type QuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

// QuestionPrompt is a single question to ask the user.
type QuestionPrompt struct {
	Question string           `json:"question"`
	Header   string           `json:"header"`
	Options  []QuestionOption `json:"options"`
	Multiple bool             `json:"multiple"`
	Custom   bool             `json:"custom"`
}

// QuestionService handles LLM-initiated questions via ClawLess API.
// DecisionQueue moved to clawless web layer; this service only sends notifications.
type QuestionService struct {
	bus      *eventbus.Bus
	clawless *clawless.Client
}

// NewQuestionService creates a new question service.
func NewQuestionService(bus *eventbus.Bus, client *clawless.Client) *QuestionService {
	return &QuestionService{
		bus:      bus,
		clawless: client,
	}
}

// Ask sends a question notification to the user via ClawLess API.
// Note: This is now fire-and-forget; blocking wait moved to clawless web layer.
func (qs *QuestionService) Ask(ctx context.Context, sessionID string, prompts []QuestionPrompt) error {
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
			return err
		}
	}

	return nil
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
