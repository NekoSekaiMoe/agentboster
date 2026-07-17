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
  activeSessionId: string | null;
  sessionCount: number;
  sessions: AgentdVncSession[];
  message: string;
}

interface AgentdVncSession {
  compactionCount: number | null;
  sandboxId: string | null;
  sandboxPath: string | null;
  sandboxType: string | null;
  sessionId: string;
  status: string;
  title: string;
  updatedAt: string | null;
  userId: string | null;
  wsProxyUrl: string | null;
}

interface AgentdVncSelection {
  key: string;
  node: AgentdVncNode;
  session: AgentdVncSession;
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

function normalizeSession(value: unknown): AgentdVncSession | null {
  const session = asRecord(value);
  const sessionId = asString(session.sessionId);
  if (!sessionId) return null;

  return {
    compactionCount:
      typeof session.compactionCount === 'number' &&
      Number.isFinite(session.compactionCount)
        ? session.compactionCount
        : null,
    sandboxId: asString(session.sandboxId),
    sandboxPath: asString(session.sandboxPath),
    sandboxType: asString(session.sandboxType),
    sessionId,
    status: asString(session.status) ?? 'unknown',
    title: asString(session.title) ?? `Session ${sessionId.slice(0, 8)}`,
    updatedAt: asString(session.updatedAt),
    userId: asString(session.userId),
    wsProxyUrl: asString(session.wsProxyUrl),
  };
}

function normalizeNode(value: unknown): AgentdVncNode | null {
  const node = asRecord(value);
  const nodeId = asString(node.nodeId);
  if (!nodeId) return null;
  const label = asString(node.label) ?? nodeId;
  const wsProxyUrl = asString(node.wsProxyUrl);
  const activeSessionId = asString(node.activeSessionId);
  const sessions = (Array.isArray(node.sessions) ? node.sessions : [])
    .map((entry) => normalizeSession(entry))
    .filter((entry): entry is AgentdVncSession => Boolean(entry));

  if (sessions.length === 0 && wsProxyUrl) {
    sessions.push({
      compactionCount: null,
      sandboxId: null,
      sandboxPath: null,
      sandboxType: null,
      sessionId: activeSessionId ?? `node:${nodeId}`,
      status: 'running',
      title: label,
      updatedAt: asString(node.lastHeartbeat),
      userId: null,
      wsProxyUrl,
    });
  }

  return {
    nodeId,
    label,
    version: asString(node.version),
    sandboxes: asStringArray(node.sandboxes),
    activeTasks: asNumber(node.activeTasks),
    activeSandboxes: asNumber(node.activeSandboxes),
    lastHeartbeat: asString(node.lastHeartbeat),
    wsProxyUrl,
    proxyStatus: asString(node.proxyStatus) ?? 'unknown',
    activeSessionId: activeSessionId ?? sessions[0]?.sessionId ?? null,
    sessionCount: Math.max(asNumber(node.sessionCount), sessions.length),
    sessions,
    message: asString(node.message) ?? '',
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
  private selectedSessionKey: string | null = null;
  private scaleMode: VncScaleMode = 'fit';
  private message = '';

  private rfb: RFB | null = null;
  private mountEl: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private reconnectTimer: number | null = null;
  private reconnectStartedAt: number | null = null;
  private originalAbs: {
    x?: (x: number) => number;
    y?: (y: number) => number;
  } = {};
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

  private getSessionKey(
    node: AgentdVncNode,
    session: AgentdVncSession,
  ): string {
    return `${node.nodeId}::${session.sessionId}`;
  }

  private getSessionOptions(): AgentdVncSelection[] {
    return this.nodes.flatMap((node) =>
      node.sessions.map((session) => ({
        key: this.getSessionKey(node, session),
        node,
        session,
      })),
    );
  }

  private syncSelectedSession(): void {
    const options = this.getSessionOptions();
    if (options.length === 0) {
      this.selectedSessionKey = null;
      return;
    }
    if (!options.some((option) => option.key === this.selectedSessionKey)) {
      const active =
        options.find(
          (option) => option.session.sessionId === option.node.activeSessionId,
        ) ?? options[0];
      this.selectedSessionKey = active.key;
    }
  }

  private getSelectedSession(): AgentdVncSelection | null {
    const options = this.getSessionOptions();
    if (options.length === 0) return null;
    return (
      options.find((option) => option.key === this.selectedSessionKey) ??
      options[0]
    );
  }

  private getSelectedNode(): AgentdVncNode | null {
    return this.getSelectedSession()?.node ?? this.nodes[0] ?? null;
  }

  private getWsUrl(selection: AgentdVncSelection | null): string | null {
    const raw = selection?.session.wsProxyUrl ?? selection?.node.wsProxyUrl;
    if (!raw || !this.auth?.url) return null;
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
        this.message = 'Not logged in. Run agentboster-cli login first.';
        this.connectionState = 'unavailable';
        this.render();
        return;
      }

      const root = auth.url.replace(/\/+$/, '');
      const response = await fetch(`${root}/api/cli/agentd/vnc`, {
        headers: { authorization: `Bearer ${auth.token}` },
      });

      const body = (await response
        .json()
        .catch(() => null)) as AgentdVncResponse | null;
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

      this.syncSelectedSession();

      this.connectToSelectedSession();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.connectionState = 'unavailable';
      this.render();
    }
  }

  private connectToSelectedSession(): void {
    this.disconnectRfb();
    this.clearReconnectTimer();

    const selection = this.getSelectedSession();
    const wsUrl = this.getWsUrl(selection);

    if (!wsUrl) {
      this.connectionState =
        this.getSessionOptions().length > 0 ? 'unavailable' : 'idle';
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

    const mount =
      this.container.querySelector<HTMLDivElement>('.agentd-vnc-mount');
    if (!mount) return;

    this.mountEl = mount;
    mount.replaceChildren();
    this.originalAbs = {};

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
    rfb.background = '#1c1724';
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
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.applyScale());
      this.resizeObserver.observe(mount);
    } else {
      this.resizeObserver = null;
    }
  }

  private applyScale(): void {
    const rfb = this.rfb;
    if (!rfb) return;

    const mount = this.mountEl;
    if (!mount) return;

    const display = (
      rfb as RFB & {
        _display?: {
          _viewportLoc?: { w: number; h: number; x: number; y: number };
          scale?: number;
          absX?: (x: number) => number;
          absY?: (y: number) => number;
        };
        _screen?: HTMLDivElement;
      }
    )._display;
    const screen =
      (rfb as RFB & { _screen?: HTMLDivElement })._screen ??
      (mount.firstElementChild as HTMLElement | null);
    const canvas = mount.querySelector('canvas') as HTMLCanvasElement | null;

    rfb.scaleViewport = this.scaleMode === 'fit';
    rfb.resizeSession = false;

    if (this.scaleMode === 'fit') {
      if (display) {
        if (this.originalAbs.x) display.absX = this.originalAbs.x;
        if (this.originalAbs.y) display.absY = this.originalAbs.y;
      }
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
      return;
    }

    rfb.scaleViewport = false;

    if (!canvas) return;

    const viewport = display?._viewportLoc;
    if (!display || !viewport) {
      if (this.scaleMode === 'stretch') {
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        if (screen) {
          screen.style.display = 'flex';
          screen.style.alignItems = 'stretch';
          screen.style.justifyContent = 'stretch';
          screen.style.overflow = 'hidden';
        }
      } else {
        canvas.style.width = '';
        canvas.style.height = '';
        if (screen) {
          screen.style.display = 'flex';
          screen.style.alignItems = 'center';
          screen.style.justifyContent = 'center';
          screen.style.overflow = 'auto';
        }
      }
      return;
    }

    this.originalAbs.x ??= display.absX;
    this.originalAbs.y ??= display.absY;

    const rect = mount.getBoundingClientRect();
    const viewportWidth = viewport.w || canvas.width || 0;
    const viewportHeight = viewport.h || canvas.height || 0;

    if (
      viewportWidth <= 0 ||
      viewportHeight <= 0 ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return;
    }

    if (this.scaleMode === 'stretch') {
      const scaleX = rect.width / viewportWidth;
      const scaleY = rect.height / viewportHeight;
      display.scale = scaleX;
      display.absX = (x: number) =>
        Math.trunc(x / scaleX + (display._viewportLoc?.x ?? 0));
      display.absY = (y: number) =>
        Math.trunc(y / scaleY + (display._viewportLoc?.y ?? 0));
      if (canvas) {
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
      }
      if (screen) {
        screen.style.display = 'flex';
        screen.style.alignItems = 'stretch';
        screen.style.justifyContent = 'stretch';
        screen.style.overflow = 'hidden';
      }
      return;
    }

    if (this.originalAbs.x) display.absX = this.originalAbs.x;
    if (this.originalAbs.y) display.absY = this.originalAbs.y;
    display.scale = 1;
    canvas.style.width = `${viewportWidth}px`;
    canvas.style.height = `${viewportHeight}px`;
    if (screen) {
      screen.style.display = 'flex';
      screen.style.alignItems = 'center';
      screen.style.justifyContent = 'center';
      screen.style.overflow = 'auto';
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

    this.reconnectTimer = window.setTimeout(
      () => {
        this.reconnectTimer = null;
        if (this.disposed) return;
        this.connectToSelectedSession();
      },
      clean ? 500 : RECONNECT_DELAY_MS,
    );
  }

  private disconnectRfb(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.rfb) {
      try {
        this.rfb.disconnect();
      } catch {
        // ignore
      }
      this.rfb = null;
    }
    this.mountEl = null;
    this.originalAbs = {};
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private selectSession(key: string): void {
    this.selectedSessionKey = key;
    this.connectToSelectedSession();
  }

  private setScaleMode(mode: VncScaleMode): void {
    this.scaleMode = mode;
    this.applyScale();
    this.render();
  }

  private renderToolbar(): TemplateResult {
    const selection = this.getSelectedSession();
    const node = this.getSelectedNode();
    const sessionOptions = this.getSessionOptions();
    const online =
      this.enabled && !this.error && this.connectionState === 'connected';
    const pending =
      this.connectionState === 'fetching' ||
      this.connectionState === 'connecting' ||
      this.connectionState === 'reconnecting';
    const statusClass = online
      ? 'online'
      : this.error
        ? 'error'
        : pending
          ? 'pending'
          : '';
    const statusText =
      this.connectionState === 'fetching'
        ? '载入中'
        : this.connectionState === 'connecting'
          ? '连接中'
          : this.connectionState === 'reconnecting'
            ? '重连中'
            : this.connectionState === 'connected'
              ? '运行中'
              : this.error
                ? '错误'
                : '离线';
    const title = selection?.session.title ?? node?.label ?? 'AgentD Desktop';

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
            type="button"
            title="Back"
            aria-label="Back"
            @click=${() => this.onBack?.()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
              <line x1="19" y1="12" x2="5" y2="12"></line>
              <polyline points="12 19 5 12 12 5"></polyline>
            </svg>
          </button>
          ${
            sessionOptions.length <= 1
              ? html`<span class="agentd-vnc-title" title=${title}>${title}</span>`
              : html`
                <select
                  class="agentd-vnc-session-select"
                  aria-label="选择远程 AgentD 桌面"
                  .value=${selection?.key ?? ''}
                  @change=${(e: Event) =>
                    this.selectSession(
                      (e.currentTarget as HTMLSelectElement).value,
                    )}
                >
                  ${sessionOptions.map(
                    (option) =>
                      html`<option value=${option.key}>
                        ${option.session.title} · ${option.node.label}
                      </option>`,
                  )}
                </select>
              `
          }
        </div>

        <div class="agentd-vnc-topbar-center">
          <span class="agentd-vnc-status-dot ${statusClass}"></span>
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
                  type="button"
                  @click=${() => this.setScaleMode(opt.value)}
                  title=${opt.label}
                  aria-label=${opt.label}
                  aria-pressed=${opt.value === this.scaleMode ? 'true' : 'false'}
                >
                  ${opt.label}
                </button>
              `,
            )}
          </div>
          <button
            class="agentd-vnc-icon-btn"
            type="button"
            title="Info"
            aria-label="Info"
            @click=${() => {
              this.infoOpen = !this.infoOpen;
              this.render();
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
          </button>
          <button
            class="agentd-vnc-icon-btn"
            type="button"
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

    const selection = this.getSelectedSession();
    const node = this.getSelectedNode();
    const session = selection?.session ?? null;

    return html`
      <div class="agentd-vnc-info-backdrop" @click=${() => {
        this.infoOpen = false;
        this.render();
      }}>
        <aside class="agentd-vnc-info-drawer" @click=${(e: Event) => e.stopPropagation()}>
          <div class="agentd-vnc-info-header">
            <span class="agentd-vnc-info-title">连接信息</span>
            <button
              class="agentd-vnc-icon-btn"
              type="button"
              aria-label="Close"
              @click=${() => {
                this.infoOpen = false;
                this.render();
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <div class="agentd-vnc-info-body">
            ${
              node
                ? html`
              ${
                session
                  ? html`
                <div class="agentd-vnc-info-row">
                  <span class="agentd-vnc-info-label">Session</span>
                  <span class="agentd-vnc-info-value">${session.title}</span>
                </div>
                <div class="agentd-vnc-info-row">
                  <span class="agentd-vnc-info-label">Session ID</span>
                  <span class="agentd-vnc-info-value">${session.sessionId}</span>
                </div>
                <div class="agentd-vnc-info-row">
                  <span class="agentd-vnc-info-label">Session Status</span>
                  <span class="agentd-vnc-info-value">${session.status}</span>
                </div>
                <div class="agentd-vnc-info-row">
                  <span class="agentd-vnc-info-label">Sandbox</span>
                  <span class="agentd-vnc-info-value">${session.sandboxId ?? '—'}</span>
                </div>
                <div class="agentd-vnc-info-row">
                  <span class="agentd-vnc-info-label">Sandbox Type</span>
                  <span class="agentd-vnc-info-value">${session.sandboxType ?? '—'}</span>
                </div>
                <div class="agentd-vnc-info-row">
                  <span class="agentd-vnc-info-label">Sandbox Path</span>
                  <span class="agentd-vnc-info-value">${session.sandboxPath ?? '—'}</span>
                </div>
                <div class="agentd-vnc-info-row">
                  <span class="agentd-vnc-info-label">Updated</span>
                  <span class="agentd-vnc-info-value">${this.formatHeartbeat(session.updatedAt)}</span>
                </div>
              `
                  : nothing
              }
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
              ${
                node.message
                  ? html`
                <div class="agentd-vnc-info-row">
                  <span class="agentd-vnc-info-label">Message</span>
                  <span class="agentd-vnc-info-value">${node.message}</span>
                </div>
              `
                  : nothing
              }
              <div class="agentd-vnc-info-row">
                <span class="agentd-vnc-info-label">Connection</span>
                <span class="agentd-vnc-info-value">${this.connectionState}</span>
              </div>
              <div class="agentd-vnc-info-row">
                <span class="agentd-vnc-info-label">Scale Mode</span>
                <span class="agentd-vnc-info-value">${this.scaleMode}</span>
              </div>
            `
                : html`<div class="agentd-vnc-info-row"><span class="agentd-vnc-info-label">No node selected</span></div>`
            }
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
          ${
            this.connectionState !== 'connected'
              ? html`
                <div class="agentd-vnc-overlay" data-state=${this.connectionState}>
                  <div class="agentd-vnc-overlay-spinner"></div>
                  <span class="agentd-vnc-overlay-text">
                    ${
                      this.connectionState === 'connecting'
                        ? 'Connecting to desktop…'
                        : 'Reconnecting…'
                    }
                  </span>
                </div>
              `
              : nothing
          }
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
          ${
            this.error
              ? html`<div class="agentd-vnc-empty-detail">${this.error}</div>`
              : this.message
                ? html`<div class="agentd-vnc-empty-detail">${this.message}</div>`
                : nothing
          }
          <div class="agentd-vnc-empty-actions">
            <button
              class="agentd-vnc-action-btn"
              type="button"
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
    const wasConnected = this.rfb && this.connectionState === 'connected';

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
      const mount =
        this.container.querySelector<HTMLDivElement>('.agentd-vnc-mount');
      if (mount && this.mountEl && mount !== this.mountEl) {
        // RFB is already attached to the old mount, move it
        while (this.mountEl.firstChild) {
          mount.appendChild(this.mountEl.firstChild);
        }
        this.mountEl = mount;
        this.resizeObserver?.disconnect();
        if (typeof ResizeObserver !== 'undefined') {
          this.resizeObserver = new ResizeObserver(() => this.applyScale());
          this.resizeObserver.observe(mount);
        } else {
          this.resizeObserver = null;
        }
        this.applyScale();
      }
    }
  }
}
