import { app } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { SessionSummary } from "../../shared/types";
import { getCodexSessionThreadInfo } from "../../shared/codexSessionMeta";

export class SessionScanner {
  private readonly root = join(app.getPath("home"), ".pi", "agent", "sessions");
  private readonly codexRoot = join(app.getPath("home"), ".codex", "sessions");

  async list(projectPath?: string): Promise<SessionSummary[]> {
    const files = await this.collectJsonl(this.root).catch(() => [] as string[]);
    const summaries = await Promise.all(files.map(file => this.readSummary(file).catch(() => null)));

    return summaries
      .filter((summary): summary is SessionSummary => Boolean(summary))
      .filter(summary => !projectPath || this.isSameProject(summary, projectPath))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 重命名会话：在 JSONL 文件头部插入一条 sessionName 元数据。
   * pi 读取时会取第一个遇到的 sessionName 字段，所以插在最前面即可覆盖旧名。
   */
  async rename(filePath: string, newName: string): Promise<void> {
    const raw = await readFile(filePath, "utf8");
    const meta = JSON.stringify({ sessionName: newName, ts: Date.now() });
    await writeFile(filePath, `${meta}\n${raw}`, "utf8");
  }

  async delete(filePath: string): Promise<void> {
    await unlink(filePath);
  }

  /**
   * 复制会话文件并写入新的 sessionName 元数据。
   * 这不是 CLI 的 fork：不裁剪会话树，只生成一个可独立打开/继续的新历史会话文件。
   */
  async copy(filePath: string): Promise<SessionSummary> {
    const raw = await readFile(filePath, "utf8");
    const current = await this.readSummary(filePath).catch(() => null);
    const copyName = `${current?.name || "Untitled"} copy`;
    const targetPath = this.nextCopyPath(filePath);
    const meta = JSON.stringify({ sessionName: copyName, copiedFrom: filePath, ts: Date.now() });
    await writeFile(targetPath, `${meta}\n${raw}`, "utf8");
    const summary = await this.readSummary(targetPath);
    if (!summary) throw new Error("复制后的会话文件无法读取");
    return summary;
  }

  /** 将历史 JSONL 会话直接导出为基础 HTML，避免为了导出历史记录而启动 Agent。 */
  async exportHtml(filePath: string): Promise<{ path: string }> {
    const summary = await this.readSummary(filePath);
    if (!summary) throw new Error("会话文件无法读取");
    const raw = await readFile(filePath, "utf8");
    const rows = raw.split(/\r?\n/).filter(Boolean).map((line) => {
      try {
        const entry = JSON.parse(line) as any;
        const message = entry.message ?? entry.data?.message ?? entry;
        if (!message?.role) return "";
        const text = this.extractText(message.content).trim();
        if (!text) return "";
        return `<section class=\"msg ${this.escapeHtml(message.role)}\"><h2>${this.escapeHtml(message.role)}</h2><pre>${this.escapeHtml(text)}</pre></section>`;
      } catch {
        return "";
      }
    }).filter(Boolean).join("\n");
    const title = summary.name || "Untitled";
    const html = `<!doctype html><html><head><meta charset=\"utf-8\"><title>${this.escapeHtml(title)}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:920px;margin:32px auto;padding:0 20px;color:#1f2937}.msg{border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin:12px 0;background:#fff}.msg h2{margin:0 0 8px;font-size:13px;color:#64748b}.msg pre{white-space:pre-wrap;margin:0;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}</style></head><body><h1>${this.escapeHtml(title)}</h1><p>${new Date(summary.updatedAt).toLocaleString()} · ${summary.messageCount} messages</p>${rows}</body></html>`;
    const safeName = title.replace(/[\\/:*?\"<>|]/g, "_").slice(0, 80) || "session";
    const targetPath = join(app.getPath("downloads"), `${safeName}-${Date.now()}.html`);
    await writeFile(targetPath, html, "utf8");
    return { path: targetPath };
  }

  private nextCopyPath(filePath: string) {
    const dir = dirname(filePath);
    const ext = extname(filePath) || ".jsonl";
    const base = basename(filePath, ext);
    for (let index = 1; index < 1000; index += 1) {
      const suffix = index === 1 ? "copy" : `copy-${index}`;
      const candidate = join(dir, `${base}-${suffix}${ext}`);
      if (!existsSync(candidate)) return candidate;
    }
    throw new Error("无法生成唯一的复制会话文件名");
  }

  private escapeHtml(value: string) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
  }

  private async collectJsonl(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...await this.collectJsonl(path));
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }

    return files;
  }

  private async readSummary(filePath: string): Promise<SessionSummary | null> {
    const [raw, info] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return null;

    let name: string | undefined;
    let projectPath: string | undefined;
    let preview = "空会话";
    let firstUserText = "";
    let firstAssistantText = "";
    let messageCount = 0;
    /** 会话来源：扫描前几行检测导入标记 */
    let source: SessionSummary["source"] = "pi";
    let codexSessionId: string | undefined;
    let codexThreadSource: SessionSummary["codexThreadSource"];
    let codexParentThreadId: string | undefined;
    let codexAgentRole: string | undefined;
    let codexAgentNickname: string | undefined;
    let codexSourcePath: string | undefined;

    for (const line of lines) {
      const entry = JSON.parse(line) as any;
      // 扫描前几行的非消息条目，检测导入来源标记
      if (source === "pi") {
        if (entry.type === "codex_import") {
          source = "codex";
          codexSessionId = this.optionalString(entry.codexSessionId);
          codexSourcePath = this.optionalString(entry.sourcePath);
          codexThreadSource = entry.threadSource === "subagent" ? "subagent" : "user";
          codexParentThreadId = this.optionalString(entry.parentThreadId);
          codexAgentRole = this.optionalString(entry.agentRole);
          codexAgentNickname = this.optionalString(entry.agentNickname);
        }
        else if (entry.type === "claude_import") source = "claude";
        else if (entry.type === "opencode_import") source = "opencode";
      }

      name ||= entry.sessionName || entry.name || entry.data?.name || entry.header?.name || entry.session?.name;
      projectPath ||= entry.cwd || entry.projectPath || entry.header?.cwd || entry.data?.cwd || entry.session?.cwd || entry.data?.session?.cwd;

      const message = entry.message ?? entry.data?.message ?? entry;
      if (message?.role) {
        messageCount += 1;
        const text = this.extractText(message.content).trim();
        if (text && preview === "空会话") preview = text;
        if (text && message.role === "user" && !firstUserText) firstUserText = text;
        if (text && message.role === "assistant" && !firstAssistantText) firstAssistantText = text;
      }
    }

    if (source === "codex" && codexSourcePath && !codexParentThreadId) {
      const fallbackInfo = this.readCodexThreadInfo(codexSourcePath);
      if (fallbackInfo) {
        codexThreadSource = fallbackInfo.threadSource;
        codexParentThreadId = fallbackInfo.parentThreadId;
        codexAgentRole = fallbackInfo.agentRole;
        codexAgentNickname = fallbackInfo.agentNickname;
      }
    }

    const inferredName = this.cleanTitle(name) || this.cleanTitle(firstUserText) || this.cleanTitle(firstAssistantText) || "Untitled";

    return {
      id: filePath,
      filePath,
      projectPath: projectPath ? this.normalize(projectPath) : this.inferProjectPathFromFile(filePath),
      name: inferredName,
      preview: preview.slice(0, 160),
      updatedAt: info.mtimeMs,
      messageCount,
      source,
      codexSessionId,
      codexThreadSource,
      codexParentThreadId,
      codexAgentRole,
      codexAgentNickname,
    };
  }

  private optionalString(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private readCodexThreadInfo(sourcePath: string) {
    try {
      const root = this.normalize(this.codexRoot);
      const target = this.normalize(sourcePath);
      if (target !== root && !target.startsWith(`${root}/`)) return undefined;
      for (const line of readFileSync(sourcePath, "utf8").split(/\r?\n/).filter(Boolean).slice(0, 16)) {
        const entry = JSON.parse(line) as any;
        if (entry.type === "session_meta" && entry.payload) {
          return getCodexSessionThreadInfo(entry.payload);
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map(item => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") return String((item as any).text ?? (item as any).thinking ?? "");
        return "";
      }).filter(Boolean).join(" ");
    }
    return "";
  }

  private cleanTitle(value?: string) {
    const text = value?.replace(/\s+/g, " ").trim();
    if (!text || /^untitled$/i.test(text)) return undefined;
    return text.length > 32 ? `${text.slice(0, 32)}…` : text;
  }

  private inferProjectPathFromFile(filePath: string) {
    const normalized = filePath.replace(/\\/g, "/");
    const marker = "/.pi/agent/sessions/";
    const index = normalized.toLowerCase().indexOf(marker);
    if (index === -1) return undefined;
    const encoded = normalized.slice(index + marker.length).split("/")[0];
    return this.decodeSessionDir(encoded);
  }

  private decodeSessionDir(encoded: string) {
    // pi 会把 cwd 存成 --C--Users-name-project-- 这种目录名；这里只用于展示和匹配，不写回 session。
    const trimmed = encoded.replace(/^--|--$/g, "");
    const drive = trimmed.match(/^([A-Za-z])--(.+)$/);
    if (drive) return `${drive[1]}:/${drive[2].replace(/-/g, "/")}`.replace(/\//g, "\\");
    return trimmed.replace(/-/g, "\\");
  }

  private isSameProject(summary: SessionSummary, projectPath: string) {
    const normalizedProject = this.normalize(projectPath);
    const normalizedSessionProject = summary.projectPath ? this.normalize(summary.projectPath) : "";
    if (normalizedSessionProject === normalizedProject) return true;
    if (this.isParentSessionForProject(normalizedSessionProject, normalizedProject, summary.filePath)) return true;
    return this.normalize(summary.filePath).includes(this.safePathToken(projectPath));
  }

  private isParentSessionForProject(sessionProject: string, projectPath: string, filePath: string) {
    // 早期用户常在 home 目录启动 pi 再操作子项目；这类历史 session 的 cwd 是父目录，
    // 但文件内容可能明确提到当前项目。仅对父目录 session 做内容校验，避免把无关 home 会话全部展示到子项目下。
    if (!sessionProject || !projectPath.startsWith(`${sessionProject}/`)) return false;
    return this.readCachedText(filePath).includes(projectPath);
  }

  private readCachedText(filePath: string) {
    try {
      return readFileSync(filePath, "utf8").replace(/\\/g, "/").toLowerCase();
    } catch {
      return "";
    }
  }

  private normalize(path: string) {
    return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  private safePathToken(path: string) {
    const normalized = path.replace(/\\/g, "/");
    const win = normalized.match(/^([A-Za-z]):\/(.+)$/);
    if (win) return `--${win[1]}--${win[2].replace(/\//g, "-")}--`.toLowerCase();
    return `--${normalized.replace(/^\//, "").replace(/\//g, "-")}--`.toLowerCase();
  }
}
