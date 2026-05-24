import type { SerializedMessageForDB } from '@/lib/chat/message-utils';
import type { AppConfig } from '@/types/config';
import type { StepResult, ToolSet } from 'ai';
import type { TokenUsage } from '../types';

export type HookNode =
  | 'beforeWorkflowStart'
  | 'afterWorkflowEnd'
  | 'beforeToolCall'
  | 'afterToolCall'
  | 'beforeMessagePersist'
  | 'afterStepFinish'
  | 'onError';

export interface HookContext {
  sessionId: string;
  runId: string;
  agentName: string;
  appConfig: AppConfig;
}

export interface BeforeToolCallPayload {
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
}

export interface AfterToolCallPayload extends BeforeToolCallPayload {
  result: unknown;
  error?: Error;
  elapsedMs: number;
}

export interface BeforeMessagePersistPayload {
  message: SerializedMessageForDB;
}

export interface AfterStepFinishPayload {
  step: StepResult<ToolSet>;
  usage: TokenUsage;
}

export interface BeforeWorkflowStartPayload {
  sessionId: string;
  source: unknown;
  initialMessages: unknown[];
}

export interface AfterWorkflowEndPayload {
  sessionId: string;
  status: 'completed' | 'error' | 'cancelled';
  error?: string;
  totalTokens: number;
}

export interface OnErrorPayload {
  error: Error;
  phase: 'tool' | 'workflow' | 'message';
  context: Record<string, unknown>;
}

export type HookPayloads = {
  beforeWorkflowStart: BeforeWorkflowStartPayload;
  afterWorkflowEnd: AfterWorkflowEndPayload;
  beforeToolCall: BeforeToolCallPayload;
  afterToolCall: AfterToolCallPayload;
  beforeMessagePersist: BeforeMessagePersistPayload;
  afterStepFinish: AfterStepFinishPayload;
  onError: OnErrorPayload;
};

export type HookHandler<T> = (
  payload: T,
  context: HookContext,
) => T | undefined | Promise<T | undefined>;

export interface HookRegistration<T = unknown> {
  node: HookNode;
  handler: HookHandler<T>;
  priority: number;
  id: string;
}
