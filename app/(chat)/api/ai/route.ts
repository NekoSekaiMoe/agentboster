console.log('[api/ai] Module loading...');

import { readAuthSessionFromCookies } from '@/lib/auth';
import { chatMain, SessionWorkspaceError } from '@/lib/chat';
import { CrossChannelReadonlyError } from '@/lib/chat/access';
import { createStaticAssistantStream } from '@/lib/chat/stream';
import { createLogger } from '@/lib/utils/logger';
import {
  type UserMessagePart,
  type WorkflowUIMessage,
  chatMessageMetadataSchema,
  workflowDataSchema,
} from '@/types/workflow';
import { createUIMessageStreamResponse, validateUIMessages } from 'ai';
import { cookies } from 'next/headers';
import { z } from 'zod';

console.log('[api/ai] Module loaded successfully');

// The web chat entry. POST is fire-and-forget: it enqueues the workflow
// and returns 202 { runId, sessionId } immediately — the client then
// subscribes to GET /api/ai/[runId]/stream for the actual SSE stream.
// This frees the POST function slot within ~milliseconds (just long
// enough for startWorkflow to register the run with the Vercel Queue)
// instead of holding it for the entire agent run. startWorkflow has its
// own 30s startup timeout, so 60s is a safe ceiling with margin.
export const maxDuration = 60;

const logger = createLogger('api.ai');

export async function GET() {
  console.log('[api/ai] GET request received');
  logger.info('get:test');
  return Response.json({ status: 'ok', timestamp: Date.now() });
}

const requestSchema = z.object({
  id: z.string(),
  trigger: z.enum(['submit-message', 'regenerate-message', 'route-message']),
  messageId: z.string().optional(),
  // Per-message model override from the chat-box picker. Optional; when
  // absent the server falls back to the user preference / global default.
  model: z.string().optional(),
  // Per-message agent/persona name from the chat-box preset picker.
  // Optional; when absent the server uses MAIN_AGENT_NAME ('main').
  // Validated against config.agents keys in chatWorkflow — unknown names
  // fall back to main rather than throwing, so stale UI state is safe.
  agent: z.string().optional(),
  // Active workspace from the web workspace switcher. Optional; when
  // absent the server scopes new sessions to the user's default
  // workspace. Ownership + active status are validated server-side in
  // chatMain before a new session is created (SessionWorkspaceError).
  workspaceId: z.string().optional(),
  input: z
    .object({
      text: z.string().optional(),
      parts: z.array(z.custom<WorkflowUIMessage['parts'][number]>()).optional(),
      metadata: chatMessageMetadataSchema.optional(),
    })
    .optional(),
  messages: z.array(z.unknown()).optional(),
});

function getInputPayload(
  body: z.infer<typeof requestSchema>,
  validatedMessages?: WorkflowUIMessage[],
) {
  if (body.input) {
    const parts = (body.input.parts ?? []).filter(
      (part): part is UserMessagePart =>
        part.type === 'text' || part.type === 'file',
    );

    return {
      parts,
      text:
        body.input.text ??
        parts
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join(''),
      metadata: body.input.metadata,
    };
  }

  const lastMessage = validatedMessages?.at(-1);
  const parts =
    lastMessage?.role === 'user'
      ? lastMessage.parts.filter(
          (part): part is UserMessagePart =>
            part.type === 'text' || part.type === 'file',
        )
      : [];

  return {
    parts,
    text:
      parts
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('') ?? '',
    metadata: lastMessage?.metadata,
  };
}

async function validateRequestMessages(
  messages: z.infer<typeof requestSchema>['messages'],
): Promise<WorkflowUIMessage[] | undefined> {
  if (!messages) {
    return undefined;
  }

  return validateUIMessages<WorkflowUIMessage>({
    messages,
    metadataSchema: chatMessageMetadataSchema,
    dataSchemas: {
      workflow: workflowDataSchema,
    },
  });
}

export async function POST(request: Request) {
  console.log('[api/ai] POST handler called at', new Date().toISOString());
  logger.info('post:start');

  let body: z.infer<typeof requestSchema>;
  try {
    logger.info('post:parse_body');
    body = requestSchema.parse(await request.json());
    logger.info('post:body_parsed', {
      sessionId: body.id,
      trigger: body.trigger,
      hasInput: !!body.input,
      inputKeys: body.input ? Object.keys(body.input) : [],
      hasInputMetadata: !!body.input?.metadata,
      inputMetadataKeys: body.input?.metadata
        ? Object.keys(body.input.metadata)
        : [],
    });
  } catch (error) {
    logger.error('post:parse_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof z.ZodError) {
      return Response.json(
        { success: false, error: 'Invalid request', details: error.issues },
        { status: 400 },
      );
    }
    return Response.json(
      { success: false, error: 'Invalid request body' },
      { status: 400 },
    );
  }

  let messages: WorkflowUIMessage[] | undefined;
  try {
    logger.info('post:validate_messages');
    messages = await validateRequestMessages(body.messages);
    logger.info('post:messages_validated', { messageCount: messages?.length });
  } catch (error) {
    logger.error('post:validate_messages_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: 'Invalid messages format' },
      { status: 400 },
    );
  }

  const input = getInputPayload(body, messages);
  logger.info('post:input_ready', { textLength: input.text.length });

  const cookieStore = await cookies();
  const authSession = await readAuthSessionFromCookies(cookieStore);
  if (!authSession) {
    return Response.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 },
    );
  }

  let result: Awaited<ReturnType<typeof chatMain>>;
  try {
    logger.info('post:calling_chatMain');

    // 添加 60 秒超时保护
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error('chatMain 执行超时（60秒）'));
      }, 60000);
    });

    const chatMainPromise = chatMain(
      {
        trigger: body.trigger,
        sessionId: body.id,
        uiMessageId: body.messageId,
        requestModel: body.model,
        requestAgent: body.agent,
        workspaceId: body.workspaceId,
        input,
        messages,
      },
      {
        source: { type: 'web', userId: authSession.userId },
        idempotencyKey: request.headers.get('X-Idempotency-Key') ?? undefined,
      },
    );

    result = await Promise.race([chatMainPromise, timeoutPromise]);
    logger.info('post:chat_main_success', { kind: result.kind });
  } catch (error) {
    if (error instanceof CrossChannelReadonlyError) {
      logger.info('post:cross_channel_readonly', {
        sessionId: error.sessionId,
        sessionChannel: error.sessionChannel,
        currentChannel: error.currentChannel,
      });
      return Response.json(
        {
          success: false,
          error: 'cross_channel_readonly',
          message: error.message,
          sessionChannel: error.sessionChannel,
          currentChannel: error.currentChannel,
        },
        { status: 403 },
      );
    }
    if (error instanceof SessionWorkspaceError) {
      logger.info('post:workspace_rejected', {
        sessionId: body.id,
        code: error.code,
      });
      return Response.json(
        { success: false, error: error.message, code: error.code },
        { status: error.code === 'not_found' ? 404 : 409 },
      );
    }
    logger.error('post:chat_main_failed', {
      sessionId: body.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : 'Failed to process message',
      },
      { status: 500 },
    );
  }

  if (result.kind === 'message' || result.kind === 'resume-run-message') {
    // Fire-and-forget: the workflow has been enqueued (startWorkflow
    // handed it off to the Vercel Queue Service). Return immediately
    // with the runId; the client subscribes to the run's SSE stream
    // via GET /api/ai/[runId]/stream (handled by the reconnect
    // endpoint, which reads getWorkflowRun(runId).readable from
    // storage — default startIndex replays every chunk written so far,
    // so nothing produced between this 202 and the client's GET is
    // lost). This drops the POST function slot within milliseconds
    // instead of holding it for the whole agent run.
    if (result.kind === 'resume-run-message') {
      logger.info('post:resume_existing_run', {
        sessionId: result.result.sessionId,
        runId: result.result.runId,
      });
    }
    return Response.json(
      {
        success: true,
        kind: result.kind,
        sessionId: result.result.sessionId,
        runId: result.result.runId,
      },
      {
        status: 202,
        headers: {
          'x-session-id': result.result.sessionId,
          'x-workflow-run-id': result.result.runId,
        },
      },
    );
  }

  return createUIMessageStreamResponse({
    stream: createStaticAssistantStream(result.result.text),
    headers: {
      'x-session-id': result.result.sessionId,
    },
  });
}
