import { describe, expect, it } from 'vitest';

import type { WorkflowUIMessage } from '@/types/workflow';
import { buildChatSendRequestBody } from './transport-request';

function userMessage(
  id: string,
  parts: WorkflowUIMessage['parts'],
): WorkflowUIMessage {
  return {
    id,
    role: 'user',
    parts,
  } as WorkflowUIMessage;
}

describe('buildChatSendRequestBody', () => {
  it('forwards the trimmed per-message model override', () => {
    const result = buildChatSendRequestBody({
      id: 'chat-1',
      trigger: 'submit-message',
      messages: [userMessage('user-1', [{ type: 'text', text: 'hello' }])],
      body: { model: '  free-chat/gemini-3.1-pro  ' },
    });

    expect(result.body.model).toBe('free-chat/gemini-3.1-pro');
    expect(result.body.input.text).toBe('hello');
  });

  it('falls through when the model override is blank', () => {
    const result = buildChatSendRequestBody({
      id: 'chat-1',
      trigger: 'submit-message',
      messages: [userMessage('user-1', [{ type: 'text', text: 'hello' }])],
      body: { model: '   ' },
    });

    expect(result.body.model).toBeUndefined();
  });

  it('uses edited parts from request body for regeneration', () => {
    const editedParts: WorkflowUIMessage['parts'] = [
      { type: 'text', text: 'edited prompt' },
    ];

    const result = buildChatSendRequestBody({
      id: 'chat-1',
      trigger: 'regenerate-message',
      messageId: 'user-1',
      messages: [
        userMessage('user-1', [{ type: 'text', text: 'original prompt' }]),
      ],
      body: {
        input: { parts: editedParts },
        model: 'free-chat/gemini-3.1-pro',
      },
    });

    expect(result.body.model).toBe('free-chat/gemini-3.1-pro');
    expect(result.body.input.parts).toEqual(editedParts);
    expect(result.body.input.text).toBe('edited prompt');
  });
});
