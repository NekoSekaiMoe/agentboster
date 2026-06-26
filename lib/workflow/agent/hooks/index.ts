// Legacy hooks (instruction + approval + local tool result)
export { approvalHookBuilder } from './approvalHook';
export { instructionHookBuilder } from './instructionHook';
export { localToolResultHookBuilder } from './localToolHook';

// New lifecycle hook system
export { hookRegistry, registerHook } from './registry';
export type {
  AfterStepFinishPayload,
  AfterToolCallPayload,
  AfterWorkflowEndPayload,
  BeforeMessagePersistPayload,
  BeforeToolCallPayload,
  BeforeWorkflowStartPayload,
  HookContext,
  HookHandler,
  HookNode,
  HookPayloads,
  HookRegistration,
  OnErrorPayload,
} from './types';
