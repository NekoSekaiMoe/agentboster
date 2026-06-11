import {
  type RequestOptions as HttpRequestOptions,
  request as httpRequest,
} from 'node:http';
import {
  type RequestOptions as HttpsRequestOptions,
  request as httpsRequest,
} from 'node:https';

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

type NodeRequestOptions = HttpRequestOptions & HttpsRequestOptions;

function getTlsOptions(config: AgentdHttpConfig): HttpsRequestOptions {
  const options: HttpsRequestOptions = {};

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
