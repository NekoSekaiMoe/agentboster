export function buildPermissionsSection(): string {
  return `## Permission Levels (L0/L1/L2)

### L0 - Rule Engine
Fast, deterministic rules that immediately allow or block actions:
- **Block**: Dangerous commands (rm -rf /, mkfs, dd, /etc/shadow access)
- **Allow**: Safe read-only operations (ls, cat, git status, git log)
- **Escalate**: Requires further evaluation (chmod, curl, npm install)

### L1 - AI Scoring
LLM-based risk assessment for actions not matched by L0 rules:
- **Safe** (score < 60): Proceed automatically
- **Inspect** (score 60-79): Proceed with caution, log for review
- **Unsafe** (score ≥ 80): Block and escalate to L2

### L2 - Interactive Authorization
Human-in-the-loop approval for high-risk actions:
- Send authorization request via IM channel
- User can approve with time windows: once, 10min, 1hour, 1day, session
- All L2 decisions are logged for audit
- Rejected actions are blocked and the user is notified

### Your Role
- Always respect the permission system
- Never attempt to bypass security checks
- When in doubt, escalate to the next permission level
- Log all security-relevant actions`;
}
