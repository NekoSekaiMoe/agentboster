export type AuthLoginResponse = {
  ok: boolean;
  token?: string;
  error?: string;
  user?: { id: string; username: string };
};

export type CliModel = {
  id: string;
  contextLimit?: number;
  maxOutputTokens?: number;
  temperature?: number;
};

export type CliSession = {
  id: string;
  title: string | null;
  channel: string;
  model: string | null;
  totalTokens: number;
  createdAt: string;
  updatedAt: string;
};

export type CliMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
};

export type UiMessageChunk = {
  type: string;
  [key: string]: unknown;
};

export type CliSessionDetail = {
  ok: boolean;
  session: CliSession;
  messages: CliMessage[];
};

export type LocalToolResultPayload = {
  ok: boolean;
  output?: unknown;
  error?: string;
};

export function createApiClient(baseUrl: string, token?: string) {
  const root = baseUrl.replace(/\/$/, '');

  function buildAuthHeaders(init?: RequestInit): HeadersInit {
    const headers = new Headers(init?.headers ?? {});
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
      headers.set('cookie', `clawless-auth=${token}`);
    }
    return headers;
  }

  async function request(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${root}${path}`, {
      ...init,
      headers: buildAuthHeaders(init),
    });
  }

  return {
    async login(
      username: string,
      password: string,
    ): Promise<AuthLoginResponse> {
      const response = await request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      return (await response.json()) as AuthLoginResponse;
    },

    async listModels(): Promise<{
      ok: boolean;
      defaultModel: string | null;
      models: CliModel[];
    }> {
      const response = await request('/api/cli/models');
      return (await response.json()) as {
        ok: boolean;
        defaultModel: string | null;
        models: CliModel[];
      };
    },

    async listSessions(): Promise<{ ok: boolean; sessions: CliSession[] }> {
      const response = await request('/api/cli/sessions');
      return (await response.json()) as { ok: boolean; sessions: CliSession[] };
    },

    async getSessionMessages(sessionId: string): Promise<CliSessionDetail> {
      const response = await request(
        `/api/cli/sessions/${encodeURIComponent(sessionId)}/messages`,
      );
      return (await response.json()) as CliSessionDetail;
    },

    async updateSessionModel(
      sessionId: string,
      model: string | null,
    ): Promise<{ ok: boolean }> {
      const response = await request(
        `/api/cli/sessions/${encodeURIComponent(sessionId)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model }),
        },
      );
      return (await response.json()) as { ok: boolean };
    },

    async sendMessage(input: {
      sessionId: string;
      message: string;
      model?: string | null;
    }): Promise<Response> {
      return request('/api/cli/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: input.sessionId,
          trigger: 'submit-message',
          input: { text: input.message },
          clientId: 'local-cli',
          label: 'agentboster-cli',
          model: input.model ?? undefined,
        }),
      });
    },

    async postLocalToolResult(input: {
      runId: string;
      toolCallId: string;
      result: LocalToolResultPayload;
    }): Promise<{ ok: boolean }> {
      const response = await request(
        `/api/ai/${encodeURIComponent(input.runId)}/tool-result`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            toolCallId: input.toolCallId,
            ok: input.result.ok,
            output: input.result.output,
            error: input.result.error,
          }),
        },
      );
      return (await response.json()) as { ok: boolean };
    },

    async generatePairCode(adapter: string): Promise<{
      code: string;
      expiresIn: number;
    }> {
      const response = await request('/api/pair/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ adapter }),
      });
      return (await response.json()) as { code: string; expiresIn: number };
    },
  };
}

export async function* readUiMessageStream(
  response: Response,
): AsyncGenerator<UiMessageChunk> {
  if (!response.body) {
    throw new Error('Response has no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let frameEnd = buffer.indexOf('\n\n');
      while (frameEnd !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        const chunk = parseSseFrame(frame);
        if (chunk) {
          yield chunk;
        }
        frameEnd = buffer.indexOf('\n\n');
      }
    }

    const remaining = buffer.trim();
    if (remaining) {
      const chunk = parseSseFrame(remaining);
      if (chunk) yield chunk;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(frame: string): UiMessageChunk | null {
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      dataLines.push(trimmed.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const raw = dataLines.join('\n');
  if (raw === '[DONE]') {
    return { type: 'done' };
  }

  try {
    return JSON.parse(raw) as UiMessageChunk;
  } catch {
    return null;
  }
}
