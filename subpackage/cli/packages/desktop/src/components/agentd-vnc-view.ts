import { html, nothing, render, type TemplateResult } from 'lit';
import RFB from '@novnc/novnc';
import {
  readAgentbosterDesktopAuth,
  type AgentbosterDesktopAuth,
} from '../agentboster-auth.js';

export type VncScaleMode = 'native' | 'fit' | 'stretch';

export type VncConnectionState =
  | 'idle'
  | 'fetching'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unavailable';

interface AgentdVncNode {
  nodeId: string;
  label: string;
  version: string | null;
  sandboxes: string[];
  activeTasks: number;
  activeSandboxes: number;
  lastHeartbeat: string | null;
  wsProxyUrl: string | null;
  proxyStatus: string;
}

interface AgentdVncResponse {
  ok: boolean;
  enabled?: boolean;
  nodes?: unknown[];
  wsProxyUrl?: string;
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
    wsProxyUrl: asString(node.wsProxyUrl),
    proxyStatus: asString(node.proxyStatus) ?? 'unknown',
  };
}

const RECONNECT_WINDOW_MS = 15000;
const RECONNECT_DELAY_MS = 900;

export class AgentdVncView {
  private container: HTMLElement;
  private onBack: (() => void) | null = null;
  private auth: AgentbosterDesktopAuth | null = null;
  private connectionState: VncConnectionState = 'idle';
  private error: string | null = null;
  private enabled = true;
  private nodes: AgentdVncNode[] = [];
  private selectedNodeId: string | null = null;
  private scaleMode: VncScaleMode = 'fit';
  private message = '';

  private rfb: RFB | null = null;
  private mountEl: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private reconnectTimer: number | null = null;
  private reconnectStartedAt: number | null = null;
  private disposed = false;
  private infoOpen = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  setOnBack(callback: () => void): void {
    this.onBack = callback;
  }

  async open(): Promise<void> {
    this.disposed = false;
    await this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.disconnectRfb();
    this.clearReconnectTimer();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private getSelectedNode(): AgentdVncNode | null {
    return (
      this.nodes.find((n) => n.nodeId === this.selectedNodeId) ??
      this.nodes[0] ??
      null
    );
  }

  private getWsUrl(node: AgentdVncNode | null): string | null {
    if (!node?.wsProxyUrl || !this.auth?.url) return null;
    const raw = node.wsProxyUrl;
    if (/^wss?:\/\//i.test(raw)) return raw;
    const base = this.auth.url.replace(/\/+$/, '').replace(/^http/, 'ws');
    return `${base}${raw.startsWith('/') ? '' : '/'}${raw}`;
  }

  private async refresh(): Promise<void> {
    this.connectionState = 'fetching';
    this.error = null;
    this.render();

    try {
      const auth = await readAgentbosterDesktopAuth();
      this.auth = auth;
      if (!auth) {
        this.enabled = false;
        this.nodes = [];
        this.message = 'Not logged in. Run agentboster login first.';
        this.connectionState = 'unavailable';
        this.render();
        return;
      }

      const root = auth.url.replace(/\/+$/, '');
      const response = await fetch(`${root}/api/cli/agentd/vnc`, {
        headers: { authorization: `Bearer ${auth.token}` },
      });

      const body = (await response.json().catch(() => null)) as
        | AgentdVncResponse
        | null;
      if (!response.ok || !body?.ok) {
        throw new Error(
          body?.error ||
            `Failed to load AgentD VNC state: HTTP ${response.status}`,
        );
      }

      this.enabled = body.enabled !== false;
      this.nodes = (body.nodes ?? [])
        .map((entry) => normalizeNode(entry))
        .filter((entry): entry is AgentdVncNode => Boolean(entry));
      this.message = asString(body.message) ?? '';

      if (
        !this.selectedNodeId ||
        !this.nodes.some((n) => n.nodeId === this.selectedNodeId)
      ) {
        this.selectedNodeId = this.nodes[0]?.nodeId ?? null;
      }

      this.connectToSelectedNode();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.connectionState = 'unavailable';
      this.render();
    }
  }

  private connectToSelectedNode(): void {
    this.disconnectRfb();
    this.clearReconnectTimer();

    const node = this.getSelectedNode();
    const wsUrl = this.getWsUrl(node);

    if (!wsUrl) {
      this.connectionState = this.nodes.length > 0 ? 'unavailable' : 'idle';
      this.render();
      return;
    }

    this.connectionState = 'connecting';
    this.reconnectStartedAt = null;
    this.render();

    requestAnimationFrame(() => {
      this.initRfb(wsUrl);
    });
  }

  private initRfb(wsUrl: string): void {
    if (this.disposed) return;

    const mount = this.container.querySelector<HTMLDivElement>(
      '.agentd-vnc-mount',
    );
    if (!mount) return;

    this.mountEl = mount;
    mount.replaceChildren();

    let rfb: RFB;
    try {
      rfb = new RFB(mount, wsUrl, { shared: true });
    } catch {
      this.connectionState = 'unavailable';
      this.render();
      return;
    }

    rfb.viewOnly = false;
    rfb.scaleViewport = this.scaleMode === 'fit';
    rfb.resizeSession = false;
    rfb.clipViewport = false;
    rfb.qualityLevel = 6;
    rfb.compressionLevel = 2;
    rfb.background = '#0d0f12';
    this.rfb = rfb;

    rfb.addEventListener('connect', () => {
      if (this.disposed) return;
      this.reconnectStartedAt = null;
      this.connectionState = 'connected';
      this.applyScale();
      this.render();
    });

    rfb.addEventListener('disconnect', (event: Event) => {
      if (this.disposed) return;
      const detail = (event as CustomEvent<{ clean?: boolean }>).detail;
      this.scheduleReconnect(detail?.clean);
    });

    rfb.addEventListener('credentialsrequired', () => {
      if (this.disposed) return;
      this.connectionState = 'unavailable';
      this.error = 'VNC requires credentials (not supported).';
      this.render();
    });

    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.applyScale());
    this.resizeObserver.observe(mount);
  }

  private applyScale(): void {
    const rfb = this.rfb;
    if (!rfb) return;
    rfb.scaleViewport = this.scaleMode === 'fit';

    const mount = this.mountEl;
    if (!mount) return;
    const canvas = mount.querySelector('canvas');
    const screen = mount.firstElementChild as HTMLElement | null;

    if (this.scaleMode === 'fit') {
      if (screen) {
        screen.style.display = 'flex';
        screen.style.alignItems = 'center';
        screen.style.justifyContent = 'center';
        screen.style.overflow = 'hidden';
      }
      if (canvas) {
        canvas.style.width = '';
        canvas.style.height = '';
      }
    } else if (this.scaleMode === 'stretch') {
      rfb.scaleViewport = false;
      if (canvas) {
        canvas.style.width = '100%';
        canvas.style.height = '100%';
      }
      if (screen) {
        screen.style.display = 'flex';
        screen.style.alignItems = 'stretch';
        screen.style.justifyContent = 'stretch';
        screen.style.overflow = 'hidden';
      }
    } else {
      if (canvas) {
        canvas.style.width = '';
        canvas.style.height = '';
      }
      if (screen) {
        screen.style.display = 'flex';
        screen.style.alignItems = 'center';
        screen.style.justifyContent = 'center';
        screen.style.overflow = 'auto';
      }
    }
  }

  private scheduleReconnect(clean?: boolean): void {
    const now = Date.now();
    if (this.reconnectStartedAt == null) {
      this.reconnectStartedAt = now;
    }
    const elapsed = now - this.reconnectStartedAt;

    if (elapsed >= RECONNECT_WINDOW_MS) {
      this.connectionState = 'unavailable';
      this.render();
      return;
    }

    this.connectionState = 'reconnecting';
    this.render();

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      this.connectToSelectedNode();
    }, clean ? 500 : RECONNECT_DELAY_MS);
  }

  private disconnectRfb(): void {
    if (this.rfb) {
      try {
        this.rfb.disconnect();
      } catch {
        // ignore
      }
      this.rfb = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private selectNode(nodeId: string): void {
    this.selectedNodeId = nodeId;
    this.connectToSelectedNode();
  }

  private setScaleMode(mode: VncScaleMode): void {
    this.scaleMode = mode;
    this.applyScale();
    this.render();
  }

  private renderToolbar(): TemplateResult {
    const node = this.getSelectedNode();
    const online =
      this.enabled && !this.error && this.connectionState === 'connected';
    const statusText =
      this.connectionState === 'fetching'
        ? 'Loading'
        : this.connectionState === 'connecting'
          ? 'Connecting'
          : this.connectionState === 'reconnecting'
            ? 'Reconnecting'
            : this.connectionState === 'connected'
              ? '运行中'
              : this.error
                ? 'Error'
                : '离线';

    const scaleOptions: Array<{ value: VncScaleMode; label: string }> = [
      { value: 'native', label: '100%' },
      { value: 'fit', label: '适应窗口' },
      { value: 'stretch', label: '拉伸' },
    ];

    return html`
      <div class="agentd-vnc-topbar">
        <div class="agentd-vnc-topbar-left">
          <button
            class="agentd-vnc-icon-btn"
            title="Back"
            aria-label="Back"
            @click=${() => this.onBack?.()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
              <line x1="19" y1="12" x2="5" y2="12"></line>
              <polyline points="12 19 5 12 12 5"></polyline>
            </svg>
          </button>
          ${this.nodes.length <= 1
            ? html`<span class="agentd-vnc-title">${node?.label ?? 'AgentD'}</span>`
            : html`
                <select
                  class="agentd-vnc-node-select"
                  .value=${node?.nodeId ?? ''}
                  @change=${(e: Event) =>
                    this.selectNode(
                      (e.currentTarget as HTMLSelectElement).value,
                    )}
                >
                  ${this.nodes.map(
                    (n) =>
                      html`<option value=${n.nodeId}>${n.label}</option>`,
                  )}
                </select>
              `}
        </div>

        <div class="agentd-vnc-topbar-center">
          <span class="agentd-vnc-status-dot ${online ? 'online' : this.error ? 'error' : ''}"></span>
          <span class="agentd-vnc-status-text">${statusText}</span>
        </div>

        <div class="agentd-vnc-topbar-right">
          <div class="agentd-vnc-scale-group">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" class="agentd-vnc-scale-icon">
              <rect x="3" y="3" width="18" height="18" rx="2"></rect>
              <path d="M8 3v18M16 3v18M3 8h18M3 16h18"></path>
            </svg>
            ${scaleOptions.map(
              (opt) => html`
                <button
                  class="agentd-vnc-scale-chip ${opt.value === this.scaleMode ? 'active' : ''}"
                  @click=${() => this.setScaleMode(opt.value)}
                  title=${opt.label}
                >
                  ${opt.label}
                </button>
              `,
            )}
          </div>
          <button
            class="agentd-vnc-icon-btn"
            title="Info"
            aria-label="Info"
            @click=${() => { this.infoOpen = !this.infoOpen; this.render(); }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
          </button>
          <button
            class="agentd-vnc-icon-btn"
            title="Refresh"
            aria-label="Refresh"
            ?disabled=${this.connectionState === 'fetching'}
            @click=${() => void this.refresh()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
              <polyline points="1 4 1 10 7 10"></polyline>
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
            </svg>
          </button>
        </div>
      </div>
    `;
  }

  private formatHeartbeat(value: string | null): string {
    if (!value) return '—';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  private renderInfoDrawer(): TemplateResult {
    if (!this.infoOpen) return html``;

    const node = this.getSelectedNode();

    return html`
      <div class="agentd-vnc-info-backdrop" @click=${() => { this.infoOpen = false; this.render(); }}>
        <aside class="agentd-vnc-info-drawer" @click=${(e: Event) => e.stopPropagation()}>
          <div class="agentd-vnc-info-header">
            <span class="agentd-vnc-info-title">Connection Info</span>
            <button class="agentd-vnc-icon-btn" @click=${() => { this.infoOpen = false; this.render(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <div class="agentd-vnc-info-body">
            ${node ? html`
              <div class="agentd-vnc-info-row">
                <span class="agentd-vnc-info-label">Node</span>
                <span class="agentd-vnc-info-value">${node.nodeId}</span>
              </div>
              <div class="agentd-vnc-info-row">
                <span class="agentd-vnc-info-label">Label</span>
                <span class="agentd-vnc-info-value">${node.label}</span>
              </div>
              <div class="agentd-vnc-info-row">
                <span class="agentd-vnc-info-label">AgentD Version</span>
                <span class="agentd-vnc-info-value">${node.version ?? '—'}</span>
              </div>
              <div class="agentd-vnc-info-row">
                <span class="agentd-vnc-info-label">Active Sandboxes</span>
                <span class="agentd-vnc-info-value">${node.activeSandboxes}</span>
              </div>
              <div class="agentd-vnc-info-row">
                <span class="agentd-vnc-info-label">Active Tasks</span>
                <span class="agentd-vnc-info-value">${node.activeTasks}</span>
              </div>
              <div class="agentd-vnc-info-row">
                <span class="agentd-vnc-info-label">Sandboxes</span>
                <span class="agentd-vnc-info-value">${node.sandboxes.join(', ') || '—'}</span>
              </div>
              <div class="agentd-vnc-info-row">
                <span class="agentd-vnc-info-label">Last Heartbeat</span>
                <span class="agentd-vnc-info-value">${this.formatHeartbeat(node.lastHeartbeat)}</span>
              </div>
              <div class="agentd-vnc-info-row">
                <span class="agentd-vnc-info-label">Proxy Status</span>
                <span class="agentd-vnc-info-value">${node.proxyStatus}</span>
              </div>
              <div class="agentd-vnc-info-row">
                <span class="agentd-vnc-info-label">Connection</span>
                <span class="agentd-vnc-info-value">${this.connectionState}</span>
              </div>
              <div class="agentd-vnc-info-row">
                <span class="agentd-vnc-info-label">Scale Mode</span>
                <span class="agentd-vnc-info-value">${this.scaleMode}</span>
              </div>
            ` : html`<div class="agentd-vnc-info-row"><span class="agentd-vnc-info-label">No node selected</span></div>`}
          </div>
        </aside>
      </div>
    `;
  }

  private renderViewport(): TemplateResult {
    if (
      this.connectionState === 'connected' ||
      this.connectionState === 'connecting' ||
      this.connectionState === 'reconnecting'
    ) {
      return html`
        <div class="agentd-vnc-viewport">
          <div class="agentd-vnc-mount"></div>
          ${this.connectionState !== 'connected'
            ? html`
                <div class="agentd-vnc-overlay" data-state=${this.connectionState}>
                  <div class="agentd-vnc-overlay-spinner"></div>
                  <span class="agentd-vnc-overlay-text">
                    ${this.connectionState === 'connecting'
                      ? 'Connecting to desktop…'
                      : 'Reconnecting…'}
                  </span>
                </div>
              `
            : nothing}
        </div>
      `;
    }

    const title = this.error
      ? 'Connection failed'
      : !this.auth
        ? 'AgentBoster login required'
        : !this.enabled
          ? 'AgentD is disabled'
          : this.nodes.length === 0
            ? 'No online AgentD nodes'
            : 'Desktop not available';

    return html`
      <div class="agentd-vnc-viewport">
        <div class="agentd-vnc-empty">
          <div class="agentd-vnc-empty-title">${title}</div>
          ${this.error
            ? html`<div class="agentd-vnc-empty-detail">${this.error}</div>`
            : this.message
              ? html`<div class="agentd-vnc-empty-detail">${this.message}</div>`
              : nothing}
          <div class="agentd-vnc-empty-actions">
            <button
              class="agentd-vnc-action-btn"
              ?disabled=${this.connectionState === 'fetching'}
              @click=${() => void this.refresh()}
            >
              Refresh
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private render(): void {
    const wasConnected =
      this.rfb && this.connectionState === 'connected';

    render(
      html`
        <div class="agentd-vnc-root">
          ${this.renderToolbar()}
          ${this.renderViewport()}
          ${this.renderInfoDrawer()}
        </div>
      `,
      this.container,
    );

    if (wasConnected) {
      const mount = this.container.querySelector<HTMLDivElement>(
        '.agentd-vnc-mount',
      );
      if (mount && this.mountEl && mount !== this.mountEl) {
        // RFB is already attached to the old mount, move it
        while (this.mountEl.firstChild) {
          mount.appendChild(this.mountEl.firstChild);
        }
        this.mountEl = mount;
        this.resizeObserver?.disconnect();
        this.resizeObserver = new ResizeObserver(() => this.applyScale());
        this.resizeObserver.observe(mount);
      }
    }
  }
}
