import type { JSONValue } from '@ai-sdk/provider';

export type BuiltinMcpToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type BuiltinMcpToolResult = {
  content: Array<
    | {
        type: 'text';
        text: string;
      }
    | {
        type: 'resource_link';
        uri: string;
        name: string;
        description?: string;
        mimeType?: string;
      }
    | {
        type: 'image';
        data: string;
        mimeType: string;
      }
  >;
  structuredContent?: JSONValue;
  isError?: boolean;
};

export type BuiltinMcpServerContext = {
  sessionId?: string;
  agentName?: string;
};
