/**
 * Public API of @agentboster/adapter.
 *
 * This package adapts pi-coding-agent's StreamFn contract to the
 * Agentboster web backend (POST /api/cli/chat → SSE → pi events).
 */

export {
  type AdvisorStoredConfig,
  type AgentbosterAuth,
  type AgentbosterStoredConfig,
  clearStoredAuth,
  getAgentbosterHome,
  getConfigPath,
  getStoredAuth,
  readStoredConfig,
  writeStoredConfig,
} from './auth.ts';

export {
  type CreateStreamFnOptions,
  createAgentbosterStreamFn,
} from './stream-fn.ts';
export {
  type LocalToolRequestHandler,
  type SubagentBatchEventHandler,
  type SubagentEventHandler,
  openAgentbosterStream,
  type WebStreamChunk,
  type WebStreamOptions,
} from './web-stream.ts';

export {
  fetchRemoteModels,
  remoteModelsToPiModels,
  type RemoteModel,
  type RemoteModelsResponse,
} from './models.ts';

export {
  fetchUserPreferences,
  patchUserPreferences,
  type PreferencesResponse,
  type ThinkingLevel as AdapterThinkingLevel,
  type UserPreferences,
} from './preferences.ts';

export {
  fetchRemoteMcpServers,
  type RemoteMcpServer,
  type McpServersResponse,
} from './mcp-servers.ts';

export {
  evaluateLocalCommand,
  formatToolRequest,
  type SecurityDecision,
  type SecurityLevel,
} from './security.ts';

export {
  fetchTaskSummary,
  patchTaskSummary,
  type TaskProgressDelta,
  type TaskSummary,
  type TaskSummaryResponse,
} from './task-summary.ts';

export {
  fetchSubagentBatch,
  fetchSubagentInfo,
  fetchSubagentMessages,
  streamSubagentMessages,
  type SubagentBatchInfo,
  type SubagentInfo,
  type SubagentMessage,
} from './subagent.ts';

export {
  addRemotePlanItem,
  archiveRemotePlan,
  createRemotePlan,
  getRemotePlan,
  listRemotePlans,
  patchRemotePlan,
  patchRemotePlanItem,
  removeRemotePlanItem,
  submitRemotePlan,
  type RemotePlan,
  type RemotePlanItem,
} from './orchestration.ts';
