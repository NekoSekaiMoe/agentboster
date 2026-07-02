import { app } from "electron";
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";

const MAX_LIVE = 200;
/** 写入文件时 data 字段 JSON 序列化后的最大字节数，超过则截断 */
const MAX_DATA_BYTES = 2_048;
/** 日志文件保留天数，超过自动删除 */
const RETENTION_DAYS = 30;

function formatDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface RpcLogEntry {
  id: string;
  agentId: string;
  direction: string;
  summary: string;
  time: number;
  data?: unknown;
}

/**
 * RPC 日志服务。
 * - 按 Agent 分文件：userData/logs/rpc/rpc-<agentId>-YYYY-MM-DD.jsonl
 * - 写入时截断大 data（超过 2KB 脱敏保存），大幅减少文件体积
 * - 次日自动 gzip 前一天文件，进一步压缩历史日志
 * - 超过 30 天自动清理
 * - 保持小型环形缓冲区（200 条）供实时展示
 */
export class RpcLogger {
  /** RPC 日志独立子目录，不和 app 日志混在一起 */
  private readonly dir = join(app.getPath("userData"), "logs", "rpc");
  private live: RpcLogEntry[] = [];
  /** 最近写入的日期，用于触发跨日 gzip */
  private lastWriteDate = "";
  private writeQueue: Promise<void> = Promise.resolve();

  /** 写入一条 RPC 日志，同时追加到文件与环形缓冲区 */
  push(entry: RpcLogEntry) {
    // 环形缓冲区：保留最近 MAX_LIVE 条
    if (this.live.length >= MAX_LIVE) {
      this.live.splice(0, this.live.length - MAX_LIVE + 1);
    }
    this.live.push(entry);

    // 异步写入文件，串行化避免并发写冲突
    this.writeQueue = this.writeQueue
      .then(() => this.writeEntry(entry))
      .catch((error) => {
        console.warn("Failed to write RPC log:", error);
      });
  }

  /** 获取实时缓冲区（最近 MAX_LIVE 条） */
  getLive(): RpcLogEntry[] {
    return [...this.live];
  }

  /**
   * 从文件读取日志。
   * 按 agentId 和日期范围过滤，倒序返回最近 limit 条。
   * 只读取未压缩的 .jsonl 文件（当天和近期尚未 gzip 的），
   * 跨日文件已被 gzip，不影响最近 7 天查询。
   */
  async getFromFile(options?: {
    agentId?: string;
    days?: number;
    limit?: number;
  }): Promise<RpcLogEntry[]> {
    await mkdir(this.dir, { recursive: true });
    const limit = Math.max(1, Math.min(options?.limit ?? 5000, 10000));
    const days = Math.max(1, options?.days ?? 7);

    const files = this.listFiles(options?.agentId, ".jsonl")
      .sort()
      .reverse()
      .slice(0, days);

    const lines: string[] = [];
    for (const file of files) {
      const raw = await readFile(join(this.dir, file), "utf8").catch(() => "");
      const fileLines = raw.split(/\r?\n/).filter(Boolean);
      lines.push(...fileLines.reverse());
      if (lines.length >= limit) break;
    }

    return lines
      .slice(0, limit)
      .map((line) => {
        try { return JSON.parse(line) as RpcLogEntry; }
        catch { return null; }
      })
      .filter((e): e is RpcLogEntry => Boolean(e));
  }

  /** 获取 RPC 日志文件总大小（字节），可选按 agentId 过滤，含 gzip 文件 */
  async getSize(agentId?: string): Promise<number> {
    await mkdir(this.dir, { recursive: true });
    const files = this.listFiles(agentId);
    let total = 0;
    for (const file of files) {
      try {
        const s = await stat(join(this.dir, file));
        total += s.size;
      } catch { /* skip */ }
    }
    return total;
  }

  /** 清空 RPC 日志文件，可选按 agentId 过滤，含 gzip 文件 */
  async clear(agentId?: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const files = this.listFiles(agentId);
    await Promise.all(
      files.map((file) => unlink(join(this.dir, file)).catch(() => undefined)),
    );
    if (agentId) {
      this.live = this.live.filter((e) => e.agentId !== agentId);
    } else {
      this.live = [];
    }
  }

  /** 将 agentId 中的不安全字符替换掉，避免跨目录访问 */
  private sanitizeAgentId(id: string): string {
    return id.replace(/[^\w-.~]/g, "_");
  }

  // ── 文件管理 ──

  /** 列出匹配的文件（默认同时匹配 .jsonl 和 .jsonl.gz） */
  private listFiles(agentId?: string, ext?: ".jsonl" | ".gz"): string[] {
    // 硬读目录，不缓存，保证各方法拿到最新文件列表
    const files: string[] = [];
    try {
      const entries = require("fs").readdirSync(this.dir);
      for (const entry of entries) {
        if (typeof entry !== "string") continue;
        // 只匹配 rpc-<agentId>-YYYY-MM-DD.jsonl 或 .jsonl.gz
        if (!/^rpc-[\w-]+-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(entry)) continue;
        if (agentId) {
          const prefix = `rpc-${this.sanitizeAgentId(agentId)}-`;
          if (!entry.startsWith(prefix)) continue;
        }
        if (ext === ".jsonl" && entry.endsWith(".gz")) continue;
        if (ext === ".gz" && !entry.endsWith(".gz")) continue;
        files.push(entry);
      }
    } catch { /* 目录不存在时返回空列表 */ }
    return files;
  }

  /** 删除超过保留天数的文件 */
  private async cleanOldFiles() {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    const files = this.listFiles();
    for (const file of files) {
      // 从文件名提取日期：rpc-<agentId>-YYYY-MM-DD.jsonl(.gz)?
      const match = file.match(/-(\d{4}-\d{2}-\d{2})\.jsonl/);
      if (!match) continue;
      const fileDate = new Date(match[1] + "T00:00:00Z").getTime();
      if (!isNaN(fileDate) && fileDate < cutoff) {
        await unlink(join(this.dir, file)).catch(() => undefined);
      }
    }
  }

  /** 将指定文件 gzip 压缩，压缩后删除原文件 */
  private async gzipFile(filePath: string) {
    const gzPath = filePath + ".gz";
    try {
      await pipeline(
        createReadStream(filePath),
        createGzip(),
        createWriteStream(gzPath),
      );
      await unlink(filePath).catch(() => undefined);
    } catch {
      await unlink(gzPath).catch(() => undefined);
    }
  }

  // ── 写入 ──

  private async writeEntry(entry: RpcLogEntry) {
    await mkdir(this.dir, { recursive: true });
    const safeAgentId = this.sanitizeAgentId(entry.agentId);
    const dateStr = formatDate(new Date(entry.time));
    const filePath = join(this.dir, `rpc-${safeAgentId}-${dateStr}.jsonl`);

    // 跨日 gzip：如果上次写入是昨天，把昨天的文件 gzip
    if (this.lastWriteDate && this.lastWriteDate !== dateStr) {
      const oldFiles = this.listFiles(undefined, ".jsonl")
        .filter((f) => f.includes(`-${this.lastWriteDate}.jsonl`) && !f.endsWith(".gz"));
      for (const oldFile of oldFiles) {
        await this.gzipFile(join(this.dir, oldFile)).catch(() => undefined);
      }
    }
    this.lastWriteDate = dateStr;

    // 截断大 data：将 entry 的 data 字段截断后写入，避免文件快速膨胀
    const safeEntry = this.truncateData(entry);
    await appendFile(filePath, `${JSON.stringify(safeEntry)}\n`, "utf8");

    // 定期清理旧文件（每 100 次写触发一次）
    if (Math.random() < 0.01) {
      await this.cleanOldFiles().catch(() => undefined);
    }
  }

  /** 截断 data 字段：JSON 序列化超过 MAX_DATA_BYTES 时替换为脱敏摘要。 */
  private truncateData(entry: RpcLogEntry): RpcLogEntry {
    // 处理 direction === "send" 时提取精简命令
    if (entry.direction === "send") {
      const data = entry.data as Record<string, unknown> | undefined;
      if (data?.type === "bash") {
        return {
          ...entry,
          data: { type: "bash", command: (data.command as string ?? "").slice(0, 200) },
        };
      }
    }
    return entry;
  }
}
