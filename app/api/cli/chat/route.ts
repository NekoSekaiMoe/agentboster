import { readAuthSessionFromRequest } from '@/lib/auth';
import { chatMain } from '@/lib/chat';
import { CrossChannelReadonlyError } from '@/lib/chat/access';
import { createStaticAssistantStream } from '@/lib/chat/stream';
import { guardWorkflowChunks } from '@/lib/chat/stream-guard';
import { createLogger } from '@/lib/utils/logger';
import { getWorkflowRun } from '@/lib/workflow/agent/dispatch';
import {
  type UserMessagePart,
  type WorkflowUIMessage,
  chatMessageMetadataSchema,
  workflowDataSchema,
} from '@/types/workflow';
import { createUIMessageStreamResponse, validateUIMessages } from 'ai';
import { z } from 'zod';

const logger = createLogger('api.cli.chat');

/**
 * CLI chat entry. Mirrors /api/ai but declares source.type === 'cli'
 * with the caller's clientId + label, so the workflow registers local_*
 * tools (see lib/workflow/agent/tools/local) and writes
 * session.channel = 'cli:<clientId>' on first message.
 *
 * Auth: Bearer token in Authorization header (cookie also accepted as
 * fallback). The token format is identical to the clawless-auth cookie
 * value; both resolve via readAuthSessionFromRequest.
 *
 * Body: same shape as /api/ai plus required `clientId` and optional
 * `label` fields used for the CLIChatSource.
 */
const requestSchema = z.object({
  id: z.string(),
  trigger: z.enum(['submit-message', 'regenerate-message', 'route-message']),
  messageId: z.string().optional(),
  model: z.string().optional(),
  input: z
    .object({
      text: z.string().optional(),
      parts: z.array(z.custom<WorkflowUIMessage['parts'][number]>()).optional(),
      metadata: chatMessageMetadataSchema.optional(),
    })
    .optional(),
  messages: z.array(z.unknown()).optional(),
  // CLI source fields:
  clientId: z.string().min(1),
  label: z.string().optional(),
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
    dataSchemas: { workflow: workflowDataSchema },
  });
}

export async function POST(request: Request) {
  logger.info('post:start');

  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
  } catch (error) {
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
    messages = await validateRequestMessages(body.messages);
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

  const authSession = await readAuthSessionFromRequest(request);
  if (!authSession) {
    return Response.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 },
    );
  }

  let result: Awaited<ReturnType<typeof chatMain>>;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('chatMain timeout (60s)'));
      }, 60_000);
      timer.unref?.();
    });

    const chatMainPromise = chatMain(
      {
        trigger: body.trigger,
        sessionId: body.id,
        uiMessageId: body.messageId,
        requestModel: body.model,
        input,
        messages,
      },
      {
        source: {
          type: 'cli',
          userId: authSession.userId,
          clientId: body.clientId,
          label: body.label,
        },
        idempotencyKey: request.headers.get('X-Idempotency-Key') ?? undefined,
      },
    );

    result = await Promise.race([chatMainPromise, timeoutPromise]);
  } catch (error) {
    if (error instanceof CrossChannelReadonlyError) {
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
    logger.error('post:chat_main_failed', {
      sessionId: body.id,
      error: error instanceof Error ? error.message : String(error),
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

  if (result.kind === 'message') {
    return createUIMessageStreamResponse({
      stream: guardWorkflowChunks(result.result.readable),
      headers: {
        'x-session-id': result.result.sessionId,
        'x-workflow-run-id': result.result.runId,
      },
    });
  }

  if (result.kind === 'resume-run-message') {
    return createUIMessageStreamResponse({
      stream: guardWorkflowChunks(getWorkflowRun(result.result.runId).readable),
      headers: {
        'x-session-id': result.result.sessionId,
        'x-workflow-run-id': result.result.runId,
      },
    });
  }

  return createUIMessageStreamResponse({
    stream: createStaticAssistantStream(result.result.text),
    headers: { 'x-session-id': result.result.sessionId },
  });
}
