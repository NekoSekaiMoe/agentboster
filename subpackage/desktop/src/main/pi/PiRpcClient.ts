import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export type RpcResponse = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

type PendingRequest = {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class PiRpcClient extends EventEmitter {
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly stdin: NodeJS.WritableStream,
    stdout: NodeJS.ReadableStream,
  ) {
    super();
    stdout.on("data", chunk => this.consumeChunk(chunk));
    stdout.on("end", () => this.consumeEnd());
  }

  request(command: Record<string, unknown>, timeoutMs = 30_000): Promise<RpcResponse> {
    const id = String(command.id ?? randomUUID());
    const payload = { ...command, id };

    const promise = new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC command timed out: ${String(command.type)}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
    });

    this.write(payload);
    return promise;
  }

  notify(command: Record<string, unknown>) {
    this.write(command);
  }

  /** 直接向 pi 的 stdin 写入原始 JSONL，不经过 pending 跟踪（用于 extension_ui_response 等消息） */
  sendRaw(payload: Record<string, unknown>) {
    this.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  close(error?: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error(`RPC client closed before response: ${id}`));
    }
    this.pending.clear();
  }

  private write(payload: Record<string, unknown>) {
    // 记录发出的 RPC 命令，方便调试
    this.emit("log", { direction: "send", data: payload });
    // pi RPC 使用严格 JSONL 协议；每条命令必须以 LF 结尾，不能依赖 readline 之类的宽松分行。
    this.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private consumeChunk(chunk: Buffer | string) {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.drainLines();
  }

  private consumeEnd() {
    this.buffer += this.decoder.end();
    if (this.buffer.length > 0) {
      this.handleLine(this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer);
      this.buffer = "";
    }
  }

  private drainLines() {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) return;

      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string) {
    if (!line.trim()) return;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // stdout 被非 JSON 内容污染时保留原文，方便用户排查 PATH、pi 版本或启动脚本问题。
      this.emit("protocol-error", line);
      return;
    }

    // 记录收到的 RPC 消息，方便调试
    this.emit("log", { direction: "recv", data: message });

    if (this.isResponse(message) && message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
      return;
    }

    this.emit("event", message);
  }

  private isResponse(value: unknown): value is RpcResponse {
    return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "response");
  }
}
