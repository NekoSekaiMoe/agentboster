import { html, nothing, render, type TemplateResult } from 'lit';
import {
  readAgentbosterDesktopAuth,
  type AgentbosterDesktopAuth,
} from '../agentboster-auth.js';

interface AgentdVncNode {
  nodeId: string;
  label: string;
  version: string | null;
  sandboxes: string[];
  activeTasks: number;
  activeSandboxes: number;
  lastHeartbeat: string | null;
  viewerUrl: string | null;
  proxyUrl: string | null;
  proxyStatus: string;
  directUrlAvailable: boolean;
  nodeUrlSource: string;
}

interface AgentdVncResponse {
  ok: boolean;
  enabled?: boolean;
  nodes?: unknown[];
  viewerPath?: string;
  proxyStatus?: string;
  message?: string;
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function normalizeNode(value: unknown): AgentdVncNode | null {
  const node = asRecord(value);
  const nodeId = asString(node.nodeId);
  if (!nodeId) return null;

  return {
    nodeId,
    label: asString(node.label) ?? nodeId,
    version: asString(node.version),
    sandboxes: asStringArray(node.sandboxes),
    activeTasks: asNumber(node.activeTasks),
    activeSandboxes: asNumber(node.activeSandboxes),
    lastHeartbeat: asString(node.lastHeartbeat),
    viewerUrl: asString(node.viewerUrl),
    proxyUrl: asString(node.proxyUrl),
    proxyStatus: asString(node.proxyStatus) ?? 'unknown',
    directUrlAvailable: node.directUrlAvailable === true,
    nodeUrlSource: asString(node.nodeUrlSource) ?? 'unknown',
  };
}

function formatHeartbeat(value: string | null): string {
  if (!value) return 'unknown heartbeat';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'unknown heartbeat';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export class AgentdVncView {
  private container: HTMLElement;
  private onBack: (() => void) | null = null;
  private auth: AgentbosterDesktopAuth | null = null;
  private loading = false;
  private error: string | null = null;
  private enabled = true;
  private nodes: AgentdVncNode[] = [];
  private selectedNodeId: string | null = null;
  private message = '';
  private viewerPath = '/vnc.html';
  private proxyStatus = 'unknown';
  private frameRevision = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  setOnBack(callback: () => void): void {
    this.onBack = callback;
  }

  async open(): Promise<void> {
    await this.refresh();
  }

  private getSelectedNode(): AgentdVncNode | null {
    return (
      this.nodes.find((node) => node.nodeId === this.selectedNodeId) ??
      this.nodes[0] ??
      null
    );
  }

  private getViewerUrl(node: AgentdVncNode | null): string | null {
    const raw = node?.proxyUrl ?? node?.viewerUrl ?? null;
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) return raw;
    if (!this.auth?.url) return raw;
    return new URL(raw, `${this.auth.url.replace(/\/+$/, '')}/`).toString();
  }

  private getFrameUrl(viewerUrl: string): string {
    try {
      const frameUrl = new URL(viewerUrl);
      frameUrl.searchParams.set(
        '_agentbosterFrame',
        String(this.frameRevision),
      );
      return frameUrl.toString();
    } catch {
      return viewerUrl;
    }
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.render();

    try {
      const auth = await readAgentbosterDesktopAuth();
      this.auth = auth;
      if (!auth) {
        this.enabled = false;
        this.nodes = [];
        this.message = 'Not logged in. Run agentboster login first.';
        return;
      }

      const root = auth.url.replace(/\/+$/, '');
      const response = await fetch(`${root}/api/cli/agentd/vnc`, {
        headers: {
          authorization: `Bearer ${auth.token}`,
        },
      });

      const body = (await response.json().catch(() => null)) as
        | AgentdVncResponse
        | null;
      if (!response.ok || !body?.ok) {
        throw new Error(
          body?.error || `Failed to load AgentD VNC state: HTTP ${response.status}`,
        );
      }

      this.enabled = body.enabled !== false;
      this.nodes = (body.nodes ?? [])
        .map((entry) => normalizeNode(entry))
        .filter((entry): entry is AgentdVncNode => Boolean(entry));
      this.viewerPath = asString(body.viewerPath) ?? '/vnc.html';
      this.proxyStatus = asString(body.proxyStatus) ?? 'unknown';
      this.message = asString(body.message) ?? '';

      if (
        !this.selectedNodeId ||
        !this.nodes.some((node) => node.nodeId === this.selectedNodeId)
      ) {
        this.selectedNodeId = this.nodes[0]?.nodeId ?? null;
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private selectNode(nodeId: string): void {
    this.selectedNodeId = nodeId;
    this.frameRevision += 1;
    this.render();
  }

  private reloadFrame(): void {
    this.frameRevision += 1;
    this.render();
  }

  private async openExternal(url: string | null): Promise<void> {
    if (!url) return;
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  private renderNodeSelect(selected: AgentdVncNode | null): TemplateResult {
    if (this.nodes.length <= 1) {
      return html`<span class="agentd-vnc-node-name"
        >${selected?.label ?? 'AgentD'}</span
      >`;
    }

    return html`
      <select
        class="agentd-vnc-node-select"
        .value=${selected?.nodeId ?? ''}
        @change=${(event: Event) => {
          const value = (event.currentTarget as HTMLSelectElement).value;
          this.selectNode(value);
        }}
      >
        ${this.nodes.map(
          (node) => html`<option value=${node.nodeId}>${node.label}</option>`,
        )}
      </select>
    `;
  }

  private renderToolbar(
    selected: AgentdVncNode | null,
    viewerUrl: string | null,
  ): TemplateResult {
    const online = this.enabled && !this.error && this.nodes.length > 0;
    const statusText = this.loading
      ? 'Refreshing'
      : this.error
        ? 'Error'
        : online
          ? 'Online'
          : 'Unavailable';

    return html`
      <div class="agentd-vnc-topbar">
        <div class="agentd-vnc-topbar-left">
          <button
            class="agentd-vnc-icon-btn"
            title="Back"
            aria-label="Back"
            @click=${() => this.onBack?.()}
          >
            Back
          </button>
          <span class="agentd-vnc-title">AgentD VNC</span>
        </div>
        <div class="agentd-vnc-topbar-center">
          ${this.renderNodeSelect(selected)}
        </div>
        <div class="agentd-vnc-topbar-right">
          <span
            class="agentd-vnc-status-dot ${this.error
              ? 'error'
              : online
                ? 'online'
                : ''}"
          ></span>
          <span class="agentd-vnc-status-text">${statusText}</span>
          <button
            class="agentd-vnc-icon-btn"
            title="Refresh"
            aria-label="Refresh"
            ?disabled=${this.loading}
            @click=${() => void this.refresh()}
          >
            Refresh
          </button>
          <button
            class="agentd-vnc-icon-btn"
            title="Reload viewer"
            aria-label="Reload viewer"
            ?disabled=${!viewerUrl}
            @click=${() => this.reloadFrame()}
          >
            Reload
          </button>
          <button
            class="agentd-vnc-icon-btn"
            title="Open external"
            aria-label="Open external"
            ?disabled=${!viewerUrl}
            @click=${() => void this.openExternal(viewerUrl)}
          >
            Open
          </button>
        </div>
      </div>
    `;
  }

  private renderNodeMeta(selected: AgentdVncNode): TemplateResult {
    return html`
      <div class="agentd-vnc-node-strip">
        <div class="agentd-vnc-meta-item">
          <span class="agentd-vnc-meta-label">Node</span>
          <span class="agentd-vnc-meta-value">${selected.nodeId}</span>
        </div>
        <div class="agentd-vnc-meta-item">
          <span class="agentd-vnc-meta-label">AgentD</span>
          <span class="agentd-vnc-meta-value"
            >${selected.version ?? 'unknown'}</span
          >
        </div>
        <div class="agentd-vnc-meta-item">
          <span class="agentd-vnc-meta-label">Sandbox</span>
          <span class="agentd-vnc-meta-value"
            >${selected.activeSandboxes} active ·
            ${selected.sandboxes.join(', ') || 'none'}</span
          >
        </div>
        <div class="agentd-vnc-meta-item">
          <span class="agentd-vnc-meta-label">Tasks</span>
          <span class="agentd-vnc-meta-value">${selected.activeTasks}</span>
        </div>
        <div class="agentd-vnc-meta-item">
          <span class="agentd-vnc-meta-label">Heartbeat</span>
          <span class="agentd-vnc-meta-value"
            >${formatHeartbeat(selected.lastHeartbeat)}</span
          >
        </div>
      </div>
    `;
  }

  private renderEmpty(selected: AgentdVncNode | null): TemplateResult {
    const title = this.error
      ? 'AgentD VNC state could not be loaded'
      : !this.auth
        ? 'AgentBoster login required'
        : !this.enabled
          ? 'AgentD is disabled'
          : this.nodes.length === 0
            ? 'No online AgentD nodes'
            : 'AgentD VNC proxy is not available yet';
    const detail =
      this.error ??
      (this.message ||
        (selected
          ? `Node ${selected.label} is online, but no VNC proxy URL was returned.`
          : ''));

    return html`
      <div class="agentd-vnc-empty">
        <div class="agentd-vnc-empty-title">${title}</div>
        ${detail
          ? html`<div class="agentd-vnc-empty-detail">${detail}</div>`
          : nothing}
        <div class="agentd-vnc-empty-actions">
          <button
            class="agentd-vnc-action-btn"
            ?disabled=${this.loading}
            @click=${() => void this.refresh()}
          >
            Refresh
          </button>
        </div>
      </div>
    `;
  }

  private renderViewport(
    selected: AgentdVncNode | null,
    viewerUrl: string | null,
  ): TemplateResult {
    if (viewerUrl) {
      return html`
        <iframe
          class="agentd-vnc-frame"
          src=${this.getFrameUrl(viewerUrl)}
          title="AgentD VNC"
          allow="clipboard-read; clipboard-write; fullscreen"
        ></iframe>
      `;
    }

    return this.renderEmpty(selected);
  }

  private render(): void {
    const selected = this.getSelectedNode();
    const viewerUrl = this.getViewerUrl(selected);

    render(
      html`
        <div class="agentd-vnc-root">
          ${this.renderToolbar(selected, viewerUrl)}
          <div class="agentd-vnc-viewport">
            ${this.renderViewport(selected, viewerUrl)}
            ${selected ? this.renderNodeMeta(selected) : nothing}
            ${this.loading
              ? html`<div class="agentd-vnc-loading">Refreshing…</div>`
              : nothing}
          </div>
          <div class="agentd-vnc-footnote">
            Proxy: ${this.proxyStatus} · Viewer path: ${this.viewerPath}
          </div>
        </div>
      `,
      this.container,
    );
  }
}
