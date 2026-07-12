//go:build linux

package server

import (
	"net/http"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
	"github.com/gin-gonic/gin"
)

// AdvisorRequest is the request body for POST /api/v1/advisor.
type AdvisorRequest struct {
	Model         string             `json:"model"`
	Messages      []clawless.Message `json:"messages"`
	SystemPrompt  string             `json:"system_prompt"`
	ThinkingLevel string             `json:"thinking_level,omitempty"`
}

// handleAdvisor performs a one-shot LLM completion for the advisor pattern.
// It reuses the existing LLM proxy infrastructure but wraps it with the
// advisor system prompt and strips tool-calling.
//
//	POST /api/v1/advisor
func (s *Server) handleAdvisor(c *gin.Context) {
	var req AdvisorRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
		return
	}

	if req.Model == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "model is required"})
		return
	}

	if len(req.Messages) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "messages are required"})
		return
	}

	// Prepend the advisor system prompt as a system message.
	systemPrompt := req.SystemPrompt
	if systemPrompt == "" {
		systemPrompt = defaultAdvisorSystemPrompt
	}

	messages := make([]clawless.Message, 0, len(req.Messages)+1)
	messages = append(messages, clawless.Message{
		Role:    "system",
		Content: systemPrompt,
	})
	messages = append(messages, req.Messages...)

	proxyReq := &clawless.LLMProxyRequest{
		Model:    req.Model,
		Messages: messages,
		Stream:   false,
	}

	if req.ThinkingLevel != "" {
		if proxyReq.Metadata == nil {
			proxyReq.Metadata = make(map[string]any)
		}
		proxyReq.Metadata["thinking_level"] = req.ThinkingLevel
	}

	data, err := s.clawless.LLMProxyRequest(c.Request.Context(), proxyReq)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}

	c.Data(http.StatusOK, "application/json", data)
}

const defaultAdvisorSystemPrompt = `You are an advisor model in an advisor-strategy pattern. An executor model is running a task end-to-end — calling tools, reading results, iterating toward a solution. When the executor hits a decision it cannot reasonably solve alone, it consults you for guidance.

You read the shared conversation context and return ONE of:
- a plan (concrete next steps the executor should take),
- a correction (the executor is going down a wrong path — redirect it),
- a stop signal (the executor should halt and escalate to the user).

You NEVER call tools. You NEVER produce user-facing output. Be concise, directive, and grounded in the shared context. Name files, functions, and line numbers where possible. No preamble, no apologies, no meta-commentary about being an advisor — just the guidance the executor needs.`
