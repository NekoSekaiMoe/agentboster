// Workflow-bundle safety: this file is transitively reachable from the
// workflow body (lib/workflow/agent/dispatch.ts -> agentd-tools-client.ts
// -> here). The workflow DevKit esbuild plugin rejects ANY reference to
// node:* modules — even `import type` — so we avoid importing node:http /
// node:https entirely at module scope. The http.request options shape is
// inlined as a local structural type, and the actual modules are loaded
// dynamically inside requestAgentd (which only runs on the host via
// 'use step' callers).

export interface AgentdHttpConfig {
  baseUrl: string;
  apiKey: string;
  cert?: string | Buffer;
  key?: string | Buffer;
  ca?: string | Buffer;
}

export interface AgentdHttpResponse {
  ok: boolean;
  status: number;
  text: string;
}

// Structural mirror of http.request's options — kept local to avoid any
// top-level reference to node:* modules. Matches the subset of fields we
// actually populate below.
interface NodeRequestOptions {
  protocol?: string;
  hostname?: string;
  port?: string | number;
  path?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  timeout?: number;
  // TLS (https only)
  cert?: string | Buffer;
  key?: string | Buffer;
  ca?: string | Buffer;
  rejectUnauthorized?: boolean;
}

function getTlsOptions(config: AgentdHttpConfig): NodeRequestOptions {
  const options: NodeRequestOptions = {};

  if (config.cert && config.key) {
    options.cert = config.cert;
    options.key = config.key;
  }

  if (config.ca) {
    options.ca = config.ca;
    options.rejectUnauthorized = true;
  }

  return options;
}

export async function requestAgentd(
  config: AgentdHttpConfig,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<AgentdHttpResponse> {
  const { request: httpRequest } = await import('node:http');
  const { request: httpsRequest } = await import('node:https');

  const url = new URL(path, config.baseUrl);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  if (config.apiKey) {
    headers['X-API-Key'] = config.apiKey;
  }

  if (payload !== undefined) {
    headers['Content-Length'] = Buffer.byteLength(payload).toString();
  }

  const isHttps = url.protocol === 'https:';
  const requestOptions: NodeRequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method,
    headers,
    timeout: timeoutMs,
    ...(isHttps ? getTlsOptions(config) : {}),
  };

  const requestFn = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = requestFn(requestOptions, (res) => {
      const chunks: Buffer[] = [];

      res.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(
        new Error(`AgentDaemon request timed out after ${timeoutMs}ms`),
      );
    });
    req.on('error', reject);

    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}
