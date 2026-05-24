import type { SecurityRule } from './types';

export const DEFAULT_SECURITY_RULES: SecurityRule[] = [
  {
    id: 'sec-001',
    name: '阻止危险命令',
    toolPattern: 'sandbox.exec',
    paramCondition: (input) => {
      const cmd = String(input.command || '');
      return (
        /rm\s+(-[rfRF]+\s+)+/.test(cmd) ||
        /mkfs\./.test(cmd) ||
        /dd\s+.*of=\/dev\//.test(cmd) ||
        /\/etc\/shadow/.test(cmd)
      );
    },
    action: 'block',
    priority: 1000,
    enabled: true,
  },
  {
    id: 'sec-002',
    name: '拦截路径遍历',
    toolPattern: 'sandbox.*',
    paramCondition: (input) => {
      const path = String(input.path || input.cwd || '');
      return /\.\.\//.test(path) || /^\/(etc|sys|proc|root)\b/.test(path);
    },
    action: 'block',
    priority: 950,
    enabled: true,
  },
  {
    id: 'sec-003',
    name: '标记危险权限操作',
    toolPattern: 'sandbox.exec',
    paramCondition: (input) => {
      const cmd = String(input.command || '');
      return /chmod\s+(777|666|a+rwx)/.test(cmd);
    },
    action: 'escalate',
    priority: 900,
    enabled: true,
  },
  {
    id: 'sec-004',
    name: '标记网络操作',
    toolPattern: 'sandbox.exec',
    paramCondition: (input) => {
      const cmd = String(input.command || '');
      return /(curl|wget|nc |nmap|telnet)\s+/.test(cmd);
    },
    action: 'escalate',
    priority: 850,
    enabled: true,
  },
  {
    id: 'sec-005',
    name: '标记包安装',
    toolPattern: 'sandbox.exec',
    paramCondition: (input) => {
      const cmd = String(input.command || '');
      return /(npm install|pip install|apt install|yum install|brew install)\s+/.test(
        cmd,
      );
    },
    action: 'escalate',
    priority: 800,
    enabled: true,
  },
  {
    id: 'sec-006',
    name: '允许安全读取',
    toolPattern: 'sandbox.*',
    paramCondition: (input) => {
      const cmd = String(input.command || '');
      return /^(ls|cat|head|tail|less|more|find|grep|wc|du|df)\s+/.test(cmd);
    },
    action: 'allow',
    priority: 500,
    enabled: true,
  },
  {
    id: 'sec-007',
    name: '允许安全 git 读',
    toolPattern: 'sandbox.exec',
    paramCondition: (input) => {
      const cmd = String(input.command || '');
      return /git\s+(status|log|diff|show|branch|remote|stash\s+list)\s*/.test(
        cmd,
      );
    },
    action: 'allow',
    priority: 400,
    enabled: true,
  },
];
