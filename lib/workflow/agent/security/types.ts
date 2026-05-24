import type { AppConfig } from '@/types/config';

export interface SecurityContext {
  sessionId: string;
  runId: string;
  agentName: string;
  autonomyLevel: 'supervised' | 'full';
  userId?: string;
  appConfig: AppConfig;
}

export interface SecurityCheckRequest {
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
  context: SecurityContext;
}

export type SecurityDecision = 'allow' | 'block' | 'escalate';

export interface SecurityCheckResult {
  decision: SecurityDecision;
  level: 'L0' | 'L1' | 'L2';
  ruleId?: string;
  reason: string;
  details?: Record<string, unknown>;
}

export interface SecurityRule {
  id: string;
  name: string;
  toolPattern: string;
  paramCondition?: (input: Record<string, unknown>) => boolean;
  action: SecurityDecision;
  priority: number;
  enabled: boolean;
}
