/**
 * Exec stream passthrough (daemon SSE → browser SSE).
 *
 * P2.1: Forwards the daemon's /api/v1/tools/exec/stream SSE response
 * directly to the browser. The web app doesn't generate the stream —
 * it just proxies bytes through so the connection lives in the
 * browser↔web hop (cookie-auth) and the web↔daemon hop (mTLS+API key).
 *
 * Used by the chat UI tool timeline to show live build/install output
 * for long-running exec calls. The workflow step itself remains atomic
 * (returns { taskId, streamUrl } metadata); the browser subscribes
 * out-of-band via this route.
 */

import {
  type AgentdHttpConfig,
  requestAgentd,
} from '@/lib/extra/agent/agentd-http';
import { getAgentdClientConfig } from '@/lib/extra/agent/agentd-tools-client';
import { createLogger } from '@/lib/utils/logger';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('api.agentd.exec-stream');

const bodySchema = z.object({
  session_id: z.string().min(1),
  tool_name: z.string().default('exec'),
  tool_input: z.record(z.string(), z.unknown()).default({}),
  task_id: z.string().optional(),
  user_id: z.string().optional(),
  roles: z.array(z.string()).optional(),
});

export async function POST(request: Request) {
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (err) {
    return Response.json(
      { success: false, error: 'Invalid body', details: err },
      { status: 400 },
    );
  }

  let config: AgentdHttpConfig;
  try {
    config = await getAgentdClientConfig();
  } catch (err) {
    logger.warn('agentd config unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      { success: false, error: 'Agent daemon not configured' },
      { status: 503 },
    );
  }

  // Forward the request to the daemon. requestAgentd returns the raw
  // response text — for an SSE stream we need streaming, so we use a
  // lower-level approach here: open a POST with response stream and
  // pipe bytes back.
  const controller = new ReadableStream<Uint8Array>({
    async start(stream) {
      try {
        const https = await import('node:https');
        const http = await import('node:http');

        const url = new URL(config.baseUrl + '/api/v1/tools/exec/stream');
        const lib = url.protocol === 'https:' ? https : http;

        const reqBody = JSON.stringify({
          session_id: parsed.session_id,
          task_id: parsed.task_id,
          tool_name: parsed.tool_name,
          tool_input: parsed.tool_input,
          user_id: parsed.user_id,
          roles: parsed.roles,
        });

        await new Promise<void>((resolve, reject) => {
          const req = lib.request(
            url,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-API-Key': config.apiKey,
                Accept: 'text/event-stream',
              },
              // TLS options for mTLS
              ...(config.cert
                ? {
                    cert: config.cert,
                    key: config.key,
                    ca: config.ca,
                  }
                : {}),
            },
            (res) => {
              if (res.statusCode && res.statusCode >= 400) {
                let errBody = '';
                res.on('data', (chunk) => (errBody += chunk));
                res.on('end', () => {
                  stream.enqueue(
                    new TextEncoder().encode(
                      `event: error\ndata: ${JSON.stringify({ type: 'error', error: errBody })}\n\n`,
                    ),
                  );
                  stream.close();
                  resolve();
                });
                return;
              }
              res.on('data', (chunk) => stream.enqueue(new Uint8Array(chunk)));
              res.on('end', () => {
                stream.close();
                resolve();
              });
              res.on('error', (err) => {
                logger.warn('upstream stream error', { error: err.message });
                stream.close();
                resolve();
              });
            },
          );
          req.on('error', (err) => {
            logger.warn('request setup error', { error: err.message });
            stream.enqueue(
              new TextEncoder().encode(
                `event: error\ndata: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`,
              ),
            );
            stream.close();
            reject(err);
          });
          req.write(reqBody);
          req.end();
        });
      } catch (err) {
        logger.error('exec-stream proxy failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          stream.enqueue(
            new TextEncoder().encode(
              `event: error\ndata: ${JSON.stringify({ type: 'error', error: 'proxy failure' })}\n\n`,
            ),
          );
          stream.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(controller, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// silence unused — requestAgentd kept for future use if we add a
// non-streaming /stream-status endpoint
void requestAgentd;
