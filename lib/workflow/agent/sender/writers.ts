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

function applyWritableScope(
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

async function writeChunkToWritable(
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

async function writeChunk(chunk: WorkflowUIMessageChunk): Promise<void> {
  await enqueueWrite(async () => {
    const writer = getWriter();
    try {
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

/**
 * Creates a WritableStream wrapper that ensures text-start chunks are sent
 * before text-delta chunks, even during workflow replay.
 *
 * This fixes a common issue where Vercel Workflow's replay mechanism causes
 * text-delta chunks to be written before their corresponding text-start chunks,
 * leading to "Received text-delta for missing text part with ID" errors.
 */
function createOrderedWritable(
  inner: WritableStream<WorkflowUIMessageChunk>
): WritableStream<WorkflowUIMessageChunk> {
  const startedTextParts = new Set<string>();
  const pendingTextDeltas = new Map<string, WorkflowUIMessageChunk[]>();

  return new WritableStream<WorkflowUIMessageChunk>({
    async write(chunk) {
      if (chunk.type === 'text-start' && chunk.id) {
        startedTextParts.add(chunk.id);
        await writeChunkToWritable(inner, chunk);

        // Flush any pending deltas for this part
        const pending = pendingTextDeltas.get(chunk.id);
        if (pending) {
          for (const delta of pending) {
            await writeChunkToWritable(inner, delta);
          }
          pendingTextDeltas.delete(chunk.id);
        }
      } else if (chunk.type === 'text-delta' && chunk.id) {
        if (startedTextParts.has(chunk.id)) {
          // text-start already sent, write delta immediately
          await writeChunkToWritable(inner, chunk);
        } else {
          // text-start not yet sent, queue this delta
          if (!pendingTextDeltas.has(chunk.id)) {
            pendingTextDeltas.set(chunk.id, []);
          }
          pendingTextDeltas.get(chunk.id)!.push(chunk);
        }
      } else if (chunk.type === 'text-end' && chunk.id) {
        // If we have pending deltas, flush them before the end
        const pending = pendingTextDeltas.get(chunk.id);
        if (pending) {
          for (const delta of pending) {
            await writeChunkToWritable(inner, delta);
          }
          pendingTextDeltas.delete(chunk.id);
        }
        await writeChunkToWritable(inner, chunk);
      } else {
        // All other chunks pass through unchanged
        await writeChunkToWritable(inner, chunk);
      }
    },
    close() {
      return Promise.resolve();
    },
    abort() {
      return Promise.resolve();
    },
  });
}

export function createScopedWritable(input: {
  writable: WritableStream<WorkflowUIMessageChunk>;
  agentName: string;
}): WritableStream<WorkflowUIMessageChunk> {
  const scopedWritable = new WritableStream<WorkflowUIMessageChunk>({
    write(chunk) {
      const scopedChunk = applyWritableScope(chunk, {
        agentName: input.agentName,
      });
      return enqueueWrite(async () => {
        await writeChunkToWritable(input.writable, scopedChunk);
      });
    },
    close() {
      return Promise.resolve();
    },
    abort() {
      return Promise.resolve();
    },
  });

  // Wrap with ordering guarantees
  return createOrderedWritable(scopedWritable);
}

export function createWritable(): WritableStream<WorkflowUIMessageChunk> {
  const writable = getWritable<WorkflowUIMessageChunk>();
  return createOrderedWritable(writable);
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
