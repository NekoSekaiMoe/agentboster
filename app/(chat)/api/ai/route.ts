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

const logger = createLogger('api.ai');

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
  const messages = await validateRequestMessages(body.messages);
  const input = getInputPayload(body, messages);

  const result = await chatMain(
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
