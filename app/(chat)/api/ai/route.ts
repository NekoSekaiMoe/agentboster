console.log('[api/ai] Module loading...');

import { chatMain } from '@/lib/chat';
import { createStaticAssistantStream } from '@/lib/chat/stream';
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

console.log('[api/ai] Module loaded successfully');

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
  input: z
    .object({
      text: z.string().optional(),
      parts: z.array(z.custom<WorkflowUIMessage['parts'][number]>()).optional(),
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
    logger.info('post:body_parsed', { sessionId: body.id, trigger: body.trigger });
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
        input,
        messages,
      },
      {
        source: { type: 'web' },
      },
    );

    result = await Promise.race([chatMainPromise, timeoutPromise]);
    logger.info('post:chat_main_success', { kind: result.kind });
  } catch (error) {
    logger.error('post:chat_main_failed', {
      sessionId: body.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to process message',
      },
      { status: 500 },
    );
  }

  if (result.kind === 'message') {
    return createUIMessageStreamResponse({
      stream: result.result.readable,
      headers: {
        'x-session-id': result.result.sessionId,
        'x-workflow-run-id': result.result.runId,
      },
    });
  }

  if (result.kind === 'resume-run-message') {
    logger.info('post:resume_existing_run', {
      sessionId: result.result.sessionId,
      runId: result.result.runId,
    });

    return createUIMessageStreamResponse({
      stream: getWorkflowRun(result.result.runId).readable,
      headers: {
        'x-session-id': result.result.sessionId,
        'x-workflow-run-id': result.result.runId,
      },
    });
  }

  return createUIMessageStreamResponse({
    stream: createStaticAssistantStream(result.result.text),
    headers: {
      'x-session-id': result.result.sessionId,
    },
  });
}
