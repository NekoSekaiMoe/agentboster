import type {
  ChatMessageMetadata,
  RuntimeEventPayload,
  WorkflowMessageData,
  WorkflowStatusData,
  WorkflowUIMessageChunk,
} from '@/types/workflow';
import { getWritable } from 'workflow';
import type { TokenUsage } from '../types';

type WritableScope = {
  agentName?: string;
};

let writeQueue: Promise<void> = Promise.resolve();

function enqueueWrite(task: () => Promise<void>): Promise<void> {
  const next = writeQueue.then(task, task);
  writeQueue = next.catch(() => undefined);
  return next;
}

function _applyWritableScope(
  chunk: WorkflowUIMessageChunk,
  scope?: WritableScope,
): WorkflowUIMessageChunk {
  const agentName = scope?.agentName?.trim();
  if (!agentName) {
    return chunk;
  }

  if (chunk.type === 'data-workflow') {
    return {
      ...chunk,
      data: {
        ...chunk.data,
        agentName: chunk.data.agentName ?? agentName,
      },
    };
  }

  if (chunk.type === 'message-metadata') {
    return {
      ...chunk,
      messageMetadata: {
        ...chunk.messageMetadata,
        agentName: chunk.messageMetadata.agentName ?? agentName,
      },
    };
  }

  return chunk;
}

async function _writeChunkToWritable(
  writable: WritableStream<WorkflowUIMessageChunk>,
  chunk: WorkflowUIMessageChunk,
): Promise<void> {
  const writer = writable.getWriter();
  try {
    await writer.write(chunk);
  } finally {
    writer.releaseLock();
  }
}

function getWriter() {
  return getWritable<WorkflowUIMessageChunk>().getWriter();
}

function createWorkflowMessageChunk(input: {
  data: WorkflowMessageData;
  id?: string;
}): WorkflowUIMessageChunk {
  return {
    type: 'data-workflow',
    ...(input.id ? { id: input.id } : {}),
    data: input.data,
  };
}

function createWorkflowStatusChunk(input: {
  data: WorkflowStatusData;
  id?: string;
}): WorkflowUIMessageChunk {
  return {
    type: 'data-workflow',
    ...(input.id ? { id: input.id } : {}),
    data: input.data,
    transient: true,
  };
}

const startedTextParts = new Set<string>();
const startedReasoningParts = new Set<string>();

async function writeChunk(chunk: WorkflowUIMessageChunk): Promise<void> {
  await enqueueWrite(async () => {
    const writer = getWriter();
    try {
      // Ensure text-start before text-delta
      if (chunk.type === 'text-start' && chunk.id) {
        startedTextParts.add(chunk.id);
      } else if (chunk.type === 'text-delta' && chunk.id) {
        if (!startedTextParts.has(chunk.id)) {
          startedTextParts.add(chunk.id);
          await writer.write({ type: 'text-start', id: chunk.id });
        }
      } else if (chunk.type === 'reasoning-start' && chunk.id) {
        startedReasoningParts.add(chunk.id);
      } else if (chunk.type === 'reasoning-delta' && chunk.id) {
        if (!startedReasoningParts.has(chunk.id)) {
          startedReasoningParts.add(chunk.id);
          await writer.write({ type: 'reasoning-start', id: chunk.id });
        }
      }

      await writer.write(chunk);
    } finally {
      writer.releaseLock();
    }
  });
}

export function withWritableScope<T>(
  _scope: WritableScope,
  callback: () => Promise<T> | T,
): Promise<T> {
  return Promise.resolve(callback());
}

export function createWritable(): WritableStream<WorkflowUIMessageChunk> {
  return getWritable<WorkflowUIMessageChunk>();
}

export async function writeUserMessageMarker(
  content: string,
  clientMessageId?: string,
): Promise<void> {
  'use step';

  await writeChunk(
    createWorkflowStatusChunk({
      id: clientMessageId,
      data: {
        kind: 'status',
        type: 'user-message',
        content,
        uiMessageId: clientMessageId ?? null,
        internal: true,
      },
    }),
  );
}

export async function writeTokenUsage(usage: TokenUsage): Promise<void> {
  'use step';

  await writeChunk(
    createWorkflowStatusChunk({
      data: {
        kind: 'status',
        type: 'token-usage',
        usage,
      },
    }),
  );
}

export async function writeSystemEvent(
  eventType: string,
  message: string,
): Promise<void> {
  'use step';

  await writeChunk(
    createWorkflowMessageChunk({
      data: {
        kind: 'message',
        type: 'system-event',
        eventType,
        message,
      },
    }),
  );
}

export async function writeRuntimeEvent(
  payload: RuntimeEventPayload,
): Promise<void> {
  'use step';

  await writeChunk(
    createWorkflowStatusChunk({
      data: {
        kind: 'status',
        type: 'runtime-event',
        payload,
      },
    }),
  );
}

export async function writeToolApprovalRequest(input: {
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  approvalId?: string;
}): Promise<void> {
  'use step';

  // Ensure the tool invocation exists before sending approval request.
  await writeChunk({
    type: 'tool-input-available',
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    input: input.toolInput,
    dynamic: true,
  });

  await writeChunk({
    type: 'tool-approval-request',
    toolCallId: input.toolCallId,
    approvalId: input.approvalId ?? input.toolCallId,
  });
}

export async function writeToolOutputDenied(input: {
  toolCallId: string;
}): Promise<void> {
  'use step';

  await writeChunk({
    type: 'tool-output-denied',
    toolCallId: input.toolCallId,
  });
}

/**
 * Emit a request chunk asking the CLI client to execute a `local_*` tool
 * against its own filesystem. The tool's execute body is blocked on
 * localToolResultHookBuilder at this point; the CLI POSTs the result to
 * /api/ai/[runId]/tool-result, which resumes the hook and unblocks the
 * workflow loop. The chunk is a transient data-workflow status event so
 * it passes through guardWorkflowChunks and AI SDK streaming untouched.
 */
export async function writeLocalToolRequest(input: {
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
}): Promise<void> {
  'use step';

  await writeChunk({
    type: 'data-workflow',
    data: {
      kind: 'status',
      type: 'local-tool-request',
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      toolInput: input.toolInput,
    },
    transient: true,
  });
}

export async function writeSubagentEvent(input: {
  subagentId: string;
  subagentName: string;
  event: 'started' | 'completed' | 'failed';
  task: string;
  summary?: string;
  error?: string;
  steps?: number;
  modelId?: string;
}): Promise<void> {
  'use step';

  await writeChunk({
    type: 'data-workflow',
    data: {
      kind: 'status',
      type: 'subagent-event',
      ...input,
    },
    transient: true,
  });
}

export async function writeSubagentBatchEvent(input: {
  batchId: string;
  event: 'spawned' | 'completed' | 'cancelled';
  concurrencyLimit: number;
  total: number;
  succeeded?: number;
  failed?: number;
  cancelled?: number;
  summary?: string;
}): Promise<void> {
  'use step';

  await writeChunk({
    type: 'data-workflow',
    data: {
      kind: 'status',
      type: 'subagent-batch-event',
      ...input,
    },
    transient: true,
  });
}

export async function writeMessageMetadata(
  metadata: ChatMessageMetadata,
): Promise<void> {
  'use step';

  await writeChunk({
    type: 'message-metadata',
    messageMetadata: metadata,
  });
}

export async function writeStepEvent(input: {
  stepNumber: number;
  finishReason: string;
  totalTokens: number;
  inputTokens?: TokenUsage['inputTokens'];
  outputTokens?: TokenUsage['outputTokens'];
  messageIds: string[];
}): Promise<void> {
  'use step';

  await writeChunk(
    createWorkflowStatusChunk({
      data: {
        kind: 'status',
        type: 'step-finish',
        ...input,
      },
    }),
  );
}

export async function writeStreamError(errorText: string): Promise<void> {
  'use step';

  await writeChunk({ type: 'error', errorText });
}

export async function writeStreamClose(): Promise<void> {
  'use step';

  const writer = getWriter();
  try {
    await writer.write({ type: 'finish', finishReason: 'stop' });
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}
