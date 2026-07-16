export type RiskLevel = 'low' | 'medium' | 'high' | 'block';

export interface RiskAssessment {
  level: RiskLevel;
  reason: string;
  ruleId: string;
}

const DANGEROUS_COMMANDS =
  /\b(rm\s+(-[rfRF]+\s+)+|mkfs\.|dd\s+.*of=\/dev\/|fdisk|format\s+[a-z]:|shutdown|reboot|init\s+[06]|systemctl\s+(halt|poweroff|reboot)|halt\b)/;

const ADMIN_COMMANDS =
  /\b(sudo\s|su\s|doas\s|pkexec\s|runas\s|gsudo\s|chmod\s+(777|666|u\+s|4[0-7]{3})|chown\s)/;

const NETWORK_COMMANDS =
  /\b(curl|wget|nc\s|ncat\s|nmap\s|telnet\s|ssh\s|scp\s|rsync\s.*:)/;

const PACKAGE_INSTALL =
  /\b(npm\s+install|yarn\s+add|pip\s+install|apt\s+install|apt-get\s+install|brew\s+install|pacman\s+-S|dnf\s+install|yum\s+install|gem\s+install|cargo\s+install)/;

const SENSITIVE_PATHS =
  /\/(etc\/(passwd|shadow|sudoers|ssh|ssl)|\.ssh\/|\.gnupg\/|\.aws\/|\.config\/)/;

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
  if (DANGEROUS_COMMANDS.test(command)) {
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
