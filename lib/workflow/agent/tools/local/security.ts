export type RiskLevel = 'low' | 'medium' | 'high' | 'block';

export interface RiskAssessment {
  level: RiskLevel;
  reason: string;
  ruleId: string;
}

const DANGEROUS_COMMANDS =
  /\b(rm\s+(-[-rfRF]+\s+)+|rm\s+--recursive|rm\s+--force|mkfs\.|dd\s+.*of=\/dev\/|fdisk|format\s+[a-z]:|shutdown|reboot|init\s+[06]|systemctl\s+(halt|poweroff|reboot)|halt\b)/;

const DANGEROUS_COMMANDS_IFS = /rm\s*\$\{?IFS\}?-[rfRF]/;

const ADMIN_COMMANDS =
  /\b(sudo\s|su\s|doas\s|pkexec\s|runas\s|gsudo\s|chmod\s+(777|666|u\+s|4[0-7]{3})|chown\s)/;

const NETWORK_COMMANDS =
  /\b(curl|wget|nc\s|ncat\s|nmap\s|telnet\s|ssh\s|scp\s|rsync\s.*:)/;

const PACKAGE_INSTALL =
  /\b(npm\s+install|yarn\s+add|pip\s+install|apt\s+install|apt-get\s+install|brew\s+install|pacman\s+-S|dnf\s+install|yum\s+install|gem\s+install|cargo\s+install)/;

const SENSITIVE_PATHS =
  /(\/(etc\/(passwd|shadow|sudoers|ssh|ssl)|\.ssh\/|\.gnupg\/|\.aws\/|\.config\/)|[A-Za-z]:\\.*\\(\.ssh|\.gnupg|\.aws)\\)/;

const DANGEROUS_KEY_COMBOS =
  /^(ctrl\+alt\+del(ete)?|alt\+f4|ctrl\+alt\+f[1-9])$/i;

export function assessLocalToolRisk(
  toolName: string,
  toolInput: Record<string, unknown>,
): RiskAssessment {
  switch (toolName) {
    case 'local_exec':
      return assessExecRisk(String(toolInput.command ?? ''));
    case 'local_write_file':
      return assessWriteRisk(String(toolInput.path ?? ''));
    case 'local_read_file':
    case 'local_grep':
    case 'local_ask_question':
      return {
        level: 'low',
        reason: 'Read-only or interactive',
        ruleId: 'rc-read',
      };
    case 'key_event':
      return assessKeyEventRisk(
        String(toolInput.key ?? ''),
        (toolInput.modifiers as string[]) ?? [],
      );
    case 'screenshot':
    case 'mouse_move':
    case 'mouse_click':
    case 'mouse_drag':
    case 'type_text':
    case 'get_accessibility_tree':
    case 'get_focused_element':
      return {
        level: 'low',
        reason: 'GUI observation or interaction',
        ruleId: 'rc-gui',
      };
    default:
      return { level: 'medium', reason: 'Unknown tool', ruleId: 'rc-unknown' };
  }
}

function assessExecRisk(command: string): RiskAssessment {
  if (
    DANGEROUS_COMMANDS.test(command) ||
    DANGEROUS_COMMANDS_IFS.test(command)
  ) {
    return {
      level: 'block',
      reason: 'Destructive system command',
      ruleId: 'rc-exec-block',
    };
  }
  if (ADMIN_COMMANDS.test(command)) {
    return {
      level: 'high',
      reason: 'Requires elevated privileges',
      ruleId: 'rc-exec-admin',
    };
  }
  if (NETWORK_COMMANDS.test(command)) {
    return {
      level: 'medium',
      reason: 'Network access',
      ruleId: 'rc-exec-net',
    };
  }
  if (PACKAGE_INSTALL.test(command)) {
    return {
      level: 'medium',
      reason: 'Package installation',
      ruleId: 'rc-exec-pkg',
    };
  }
  return { level: 'low', reason: 'Standard command', ruleId: 'rc-exec-ok' };
}

function assessWriteRisk(path: string): RiskAssessment {
  if (SENSITIVE_PATHS.test(path)) {
    return {
      level: 'high',
      reason: 'Writes to sensitive system path',
      ruleId: 'rc-write-sensitive',
    };
  }
  return { level: 'low', reason: 'Standard file write', ruleId: 'rc-write-ok' };
}

function assessKeyEventRisk(key: string, modifiers: string[]): RiskAssessment {
  const combo = [...modifiers, key].join('+');
  if (DANGEROUS_KEY_COMBOS.test(combo)) {
    return {
      level: 'high',
      reason: 'Dangerous key combination',
      ruleId: 'rc-key-danger',
    };
  }
  return { level: 'low', reason: 'Standard key event', ruleId: 'rc-key-ok' };
}

export function shouldRequireApproval(
  risk: RiskAssessment,
  isRemoteControlMode: boolean,
): boolean {
  if (risk.level === 'block') return true;
  if (!isRemoteControlMode) return false;
  return risk.level === 'high' || risk.level === 'medium';
}

/**
 * Request L2 approval for a remote tool execution via IM.
 *
 * Sends a notification to the IM thread with approve/reject buttons,
 * then waits for the user's decision via KV polling.
 *
 * @param params - Tool execution context and risk information
 * @returns 'approved', 'rejected', or 'timeout'
 */
export async function requestL2ApprovalForRemoteTool(params: {
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  decisionId: string;
  riskReason: string;
  requiresAdmin: boolean;
  remoteAdapter?: string;
  remoteThreadId?: string;
  userId?: string;
}): Promise<'approved' | 'rejected' | 'timeout'> {
  const {
    sessionId,
    toolName,
    toolInput,
    decisionId,
    riskReason,
    requiresAdmin,
    remoteAdapter,
    remoteThreadId,
    userId,
  } = params;

  // Send IM notification with approval buttons
  try {
    const { sendNotification } = await import(
      '@/lib/extra/channels/send-notification'
    );

    if (!remoteAdapter || !remoteThreadId) {
      return 'rejected';
    }

    // Construct L2 notification message body
    let body = `Risk: ${riskReason}`;
    if (requiresAdmin) {
      body += `\n⚠️ This operation requires administrator privileges. CLI will request elevation if approved.`;
    }

    // Add tool input preview (truncated)
    if (typeof toolInput === 'object' && toolInput !== null) {
      const preview = JSON.stringify(toolInput, null, 2).slice(0, 500);
      body += `\n\`\`\`\n${preview}${preview.length >= 500 ? '\n...' : ''}\n\`\`\``;
    }

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutes

    await sendNotification({
      source: {
        type: 'im' as const,
        adapter: remoteAdapter as any, // Type will be validated by sendNotification
        origin: 'remote-control',
        threadId: remoteThreadId,
      },
      payload: {
        type: 'decision',
        taskId: sessionId,
        decisionId,
        title: `Authorize: ${toolName}`,
        body,
        command: toolName,
        score: 50,
        reason: riskReason,
        options: ['pass_once', 'reject_once'] as const,
        expiresAt,
      },
      userId,
    });
  } catch (_error) {
    // If notification fails, reject by default for safety
    return 'rejected';
  }

  // Wait for user decision via KV polling
  const result = await waitForL2Decision(decisionId, {
    timeoutMs: 5 * 60 * 1000, // 5 minutes
    escalationMs: 3 * 60 * 1000, // 3 minutes escalation
  });

  return result;
}

/**
 * Poll KV for L2 approval decision.
 * Reuses the same KV key pattern as agentd L2 decisions.
 */
async function waitForL2Decision(
  decisionId: string,
  options: { timeoutMs: number; escalationMs: number },
): Promise<'approved' | 'rejected' | 'timeout'> {
  const kvModule = await import('@/lib/core/kv');
  const startTime = Date.now();
  const pollInterval = 1000; // 1 second

  while (Date.now() - startTime < options.timeoutMs) {
    // Check KV for decision
    const decision = await kvModule.get(`l2-decision:${decisionId}`);

    if (decision) {
      const parsed =
        typeof decision === 'string' ? JSON.parse(decision) : decision;

      if (parsed.approved === true) {
        await kvModule.del(`l2-decision:${decisionId}`);
        return 'approved';
      }
      if (parsed.approved === false) {
        await kvModule.del(`l2-decision:${decisionId}`);
        return 'rejected';
      }
    }

    // Escalation reminder after 3 minutes
    const elapsed = Date.now() - startTime;
    if (
      elapsed >= options.escalationMs &&
      elapsed < options.escalationMs + pollInterval
    ) {
      // Could send an escalation notification here
      // For now, just continue waiting
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // Timeout - clean up and return
  await kvModule.del(`l2-decision:${decisionId}`);
  return 'timeout';
}
