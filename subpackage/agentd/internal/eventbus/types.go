package eventbus

import "time"

// EventType represents the type of event.
type EventType string

const (
	// Task lifecycle
	EventTaskCreated   EventType = "task.created"
	EventTaskReviewed  EventType = "task.reviewed"
	EventTaskApproved  EventType = "task.approved"
	EventTaskRejected  EventType = "task.rejected"
	EventTaskRunning   EventType = "task.running"
	EventTaskCompleted EventType = "task.completed"
	EventTaskFailed    EventType = "task.failed"
	EventTaskCancelled EventType = "task.cancelled"

	// Sandbox lifecycle
	EventSandboxCreated   EventType = "sandbox.created"
	EventSandboxReady     EventType = "sandbox.ready"
	EventSandboxDestroyed EventType = "sandbox.destroyed"

	// Security
	EventSecurityReview EventType = "security.review"
	EventSecurityAlert  EventType = "security.alert"
	EventL2AuthRequired EventType = "l2.auth_required"
	EventL2AuthApproved EventType = "l2.auth_approved"
	EventL2AuthRejected EventType = "l2.auth_rejected"

	// Memory
	EventMemoryExtracted EventType = "memory.extracted"

	// Session lifecycle
	EventSessionCreated  EventType = "session.created"
	EventSessionSwitched EventType = "session.switched"
	EventSessionClosed   EventType = "session.closed"
	EventSessionArchived EventType = "session.archived"

	// Decision queue
	EventDecisionTimeout EventType = "decision.timeout"
	EventUserOnline      EventType = "user.online"

	// System
	EventSystemHealthCheck EventType = "system.health_check"
	EventConfigReloaded    EventType = "config.reloaded"

	// Task summary
	EventTaskTidyTick EventType = "task_summary.tidy_tick"

	// Parallel exec
	EventExecRequested      EventType = "exec.requested"
	EventExecCompleted      EventType = "exec.completed"
	EventExecBatchCompleted EventType = "exec.batch_completed"
	EventExecBatchFailed    EventType = "exec.batch_failed"
)

// Event represents a domain event.
type Event struct {
	Type      EventType
	Payload   any
	Timestamp time.Time
}
