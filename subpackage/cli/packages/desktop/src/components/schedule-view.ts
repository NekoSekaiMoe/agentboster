import { html, nothing, render, type TemplateResult } from 'lit';
import {
  readAgentbosterDesktopAuth,
  type AgentbosterDesktopAuth,
} from '../agentboster-auth.js';
import {
  deleteLocalScheduleTask,
  loadLocalScheduleTasks,
  upsertLocalScheduleTask,
  type LocalScheduleTask,
} from '../schedule/schedule-storage.js';

type TaskSource = 'web' | 'local';

interface UnifiedTask {
  source: TaskSource;
  // Web task fields are passed through from the API response.
  // Local tasks use LocalScheduleTask shape directly.
  raw: WebScheduleTask | LocalScheduleTask;
}

interface WebScheduleTask {
  id: string;
  sessionId: string | null;
  type: 'delay' | 'daily';
  title: string | null;
  prompt: string;
  timezone: string | null;
  dailyTime: string | null;
  nextRunAt: string | null;
  lastTriggeredAt: string | null;
  lastFiredFor: string | null;
  scheduleWorkflowRunId: string | null;
  lastChatRunId: string | null;
  active: boolean;
  archived: boolean;
  displayStatus: string | null;
  createdAt: string;
  updatedAt: string;
  notifyChannel: string | null;
  remoteControl: boolean;
}

interface ImChannel {
  id: string;
  label: string;
  adapter: string;
}

type FilterKind = 'all' | 'web' | 'local' | 'active' | 'archived';

interface FormState {
  type: 'delay' | 'daily';
  title: string;
  prompt: string;
  timezone: string;
  dailyTime: string;
  runAt: string;
  notifyChannel: string;
  remoteControl: boolean;
  source: TaskSource;
}

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_CHANNEL_STORAGE_KEY = 'desktop-schedule-default-channel.v1';

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

function normalizeWebTask(value: unknown): WebScheduleTask | null {
  const task = asRecord(value);
  const id = asString(task.id);
  if (!id) return null;
  return {
    id,
    sessionId: asString(task.sessionId),
    type: task.type === 'daily' ? 'daily' : 'delay',
    title: asString(task.title),
    prompt: typeof task.prompt === 'string' ? task.prompt : '',
    timezone: asString(task.timezone),
    dailyTime: asString(task.dailyTime),
    nextRunAt: asString(task.nextRunAt),
    lastTriggeredAt: asString(task.lastTriggeredAt),
    lastFiredFor: asString(task.lastFiredFor),
    scheduleWorkflowRunId: asString(task.scheduleWorkflowRunId),
    lastChatRunId: asString(task.lastChatRunId),
    active: task.active !== false,
    archived: task.archived === true,
    displayStatus: asString(task.displayStatus),
    createdAt:
      typeof task.createdAt === 'string'
        ? task.createdAt
        : new Date().toISOString(),
    updatedAt:
      typeof task.updatedAt === 'string'
        ? task.updatedAt
        : new Date().toISOString(),
    notifyChannel: asString(task.notifyChannel),
    remoteControl: task.remoteControl === true,
  };
}

function normalizeImChannel(value: unknown): ImChannel | null {
  const channel = asRecord(value);
  const id = asString(channel.id);
  if (!id) return null;
  return {
    id,
    label:
      asString(channel.label) ??
      asString(channel.adapter) ??
      id,
    adapter: asString(channel.adapter) ?? 'unknown',
  };
}

export function getDefaultImChannel(): string {
  try {
    return localStorage.getItem(DEFAULT_CHANNEL_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setDefaultImChannel(value: string): void {
  try {
    localStorage.setItem(DEFAULT_CHANNEL_STORAGE_KEY, value);
  } catch {
    // ignore
  }
}

export async function fetchImChannels(): Promise<ImChannel[]> {
  const auth = await readAgentbosterDesktopAuth();
  if (!auth) return [];
  try {
    const root = auth.url.replace(/\/+$/, '');
    const response = await fetch(`${root}/api/cli/im-channels`, {
      headers: { authorization: `Bearer ${auth.token}` },
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) return [];
    const list = asRecord(body);
    const items = Array.isArray(list.channels)
      ? list.channels
      : Array.isArray(list.items)
        ? list.items
        : Array.isArray(list)
          ? list
          : [];
    return items
      .map((entry) => normalizeImChannel(entry))
      .filter((entry): entry is ImChannel => Boolean(entry));
  } catch {
    return [];
  }
}

function formatDate(value: string | null): string {
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

function newTaskId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function describeChannel(channel: string | null): string {
  if (!channel) return '系统通知';
  if (channel === 'desktop') return '系统通知';
  if (channel.startsWith('im:')) {
    const adapter = channel.slice(3);
    return `IM:${adapter}`;
  }
  return channel;
}

function emptyForm(): FormState {
  return {
    type: 'delay',
    title: '',
    prompt: '',
    timezone: DEFAULT_TIMEZONE,
    dailyTime: '09:00',
    runAt: '',
    notifyChannel: getDefaultImChannel(),
    remoteControl: false,
    source: 'local',
  };
}

function computeDelayNextRunAt(runAtLocal: string, timezone: string): string | null {
  if (!runAtLocal) return null;
  const date = new Date(runAtLocal);
  if (!Number.isFinite(date.getTime())) return null;
  void timezone;
  return date.toISOString();
}

function computeDailyNextRunAt(
  dailyTime: string,
  timezone: string,
): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(dailyTime.trim());
  if (!match) return null;
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const now = new Date();
  const candidate = new Date();
  candidate.setSeconds(0, 0);
  candidate.setHours(hour, minute, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  void timezone;
  return candidate.toISOString();
}

export class ScheduleView {
  private container: HTMLElement;
  private onBack: (() => void) | null = null;
  private onNotify:
    | ((message: string, kind: 'info' | 'success' | 'error') => void)
    | null = null;

  private auth: AgentbosterDesktopAuth | null = null;
  private tasks: UnifiedTask[] = [];
  private imChannels: ImChannel[] = [];
  private loading = false;
  private error: string | null = null;

  private filter: FilterKind = 'all';
  private showCreateForm = false;
  private editing: { source: TaskSource; id: string } | null = null;
  private form: FormState = emptyForm();
  private saving = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  setOnBack(callback: () => void): void {
    this.onBack = callback;
  }

  setOnNotify(
    callback: (message: string, kind: 'info' | 'success' | 'error') => void,
  ): void {
    this.onNotify = callback;
  }

  async open(): Promise<void> {
    await this.refresh();
  }

  dispose(): void {
    // nothing persistent to tear down
  }

  private notify(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
    this.onNotify?.(message, kind);
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.render();
    try {
      const auth = await readAgentbosterDesktopAuth();
      this.auth = auth;
      const [webTasks, channels, localTasks] = await Promise.all([
        auth ? this.fetchWebTasks(auth) : Promise.resolve([]),
        auth ? fetchImChannels() : Promise.resolve([]),
        Promise.resolve(loadLocalScheduleTasks()),
      ]);
      this.imChannels = channels;
      this.tasks = [
        ...webTasks.map((raw) => ({ source: 'web' as const, raw })),
        ...localTasks.map((raw) => ({ source: 'local' as const, raw })),
      ];
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async fetchWebTasks(
    auth: AgentbosterDesktopAuth,
  ): Promise<WebScheduleTask[]> {
    const root = auth.url.replace(/\/+$/, '');
    const response = await fetch(`${root}/api/cli/schedules`, {
      headers: { authorization: `Bearer ${auth.token}` },
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const record = asRecord(body);
      throw new Error(
        typeof record.error === 'string'
          ? record.error
          : `HTTP ${response.status}`,
      );
    }
    const list = asRecord(body);
    const items = Array.isArray(list.tasks)
      ? list.tasks
      : Array.isArray(list.items)
        ? list.items
        : Array.isArray(list)
          ? list
          : [];
    return items
      .map((entry) => normalizeWebTask(entry))
      .filter((entry): entry is WebScheduleTask => Boolean(entry));
  }

  private async apiRequest(
    path: string,
    method: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const auth = this.auth ?? (await readAgentbosterDesktopAuth());
    if (!auth) throw new Error('尚未登录 AgentBoster');
    const root = auth.url.replace(/\/+$/, '');
    const response = await fetch(`${root}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${auth.token}`,
        'content-type': 'application/json',
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as unknown;
      const record = asRecord(body);
      throw new Error(
        typeof record.error === 'string'
          ? record.error
          : `HTTP ${response.status}`,
      );
    }
  }

  private startCreate(): void {
    this.editing = null;
    this.form = emptyForm();
    this.showCreateForm = true;
    this.render();
  }

  private startEdit(source: TaskSource, id: string): void {
    const task = this.tasks.find(
      (entry) => entry.source === source && taskId(entry.raw) === id,
    );
    if (!task) return;
    const raw = task.raw;
    this.editing = { source, id };
    this.form = {
      type: raw.type,
      title: raw.title ?? '',
      prompt: raw.prompt,
      timezone: raw.timezone ?? DEFAULT_TIMEZONE,
      dailyTime: raw.dailyTime ?? '09:00',
      runAt: raw.nextRunAt ?? '',
      notifyChannel: raw.notifyChannel ?? getDefaultImChannel(),
      remoteControl: raw.remoteControl,
      source,
    };
    this.showCreateForm = true;
    this.render();
  }

  private cancelForm(): void {
    this.showCreateForm = false;
    this.editing = null;
    this.render();
  }

  private async saveForm(): Promise<void> {
    if (this.saving) return;
    const form = this.form;
    if (form.prompt.trim().length === 0) {
      this.notify('请输入任务提示词', 'error');
      return;
    }
    const isImRoute = form.remoteControl || form.notifyChannel.startsWith('im:');
    const targetSource: TaskSource = isImRoute ? 'web' : form.source;

    this.saving = true;
    this.render();
    try {
      if (targetSource === 'web') {
        await this.saveWebTask(form);
      } else {
        this.saveLocalTask(form);
      }
      this.showCreateForm = false;
      this.editing = null;
      this.notify('已保存任务', 'success');
      await this.refresh();
    } catch (err) {
      this.notify(
        err instanceof Error ? err.message : String(err),
        'error',
      );
    } finally {
      this.saving = false;
      this.render();
    }
  }

  private async saveWebTask(form: FormState): Promise<void> {
    const payload: Record<string, unknown> = {
      type: form.type,
      title: form.title.trim() || null,
      prompt: form.prompt,
      timezone: form.timezone.trim() || DEFAULT_TIMEZONE,
      notifyChannel: form.notifyChannel || null,
      remoteControl: form.remoteControl,
    };
    if (form.type === 'daily') {
      payload.dailyTime = form.dailyTime;
    } else {
      const next = computeDelayNextRunAt(form.runAt, form.timezone);
      if (!next) throw new Error('请输入有效的触发时间');
      payload.runAt = next;
    }
    const editingId =
      this.editing && this.editing.source === 'web' ? this.editing.id : null;
    if (editingId) {
      await this.apiRequest(
        `/api/cli/schedules/${editingId}`,
        'PATCH',
        payload,
      );
    } else {
      await this.apiRequest('/api/cli/schedules', 'POST', payload);
    }
  }

  private saveLocalTask(form: FormState): void {
    const now = new Date().toISOString();
    const editingId =
      this.editing && this.editing.source === 'local'
        ? this.editing.id
        : null;
    const id = editingId ?? newTaskId();
    const nextRunAt =
      form.type === 'daily'
        ? computeDailyNextRunAt(form.dailyTime, form.timezone)
        : computeDelayNextRunAt(form.runAt, form.timezone);
    const task: LocalScheduleTask = {
      id,
      type: form.type,
      title: form.title.trim() || null,
      prompt: form.prompt,
      timezone: form.timezone.trim() || null,
      dailyTime: form.type === 'daily' ? form.dailyTime : null,
      nextRunAt,
      lastTriggeredAt: null,
      active: true,
      notifyChannel: form.notifyChannel || null,
      remoteControl: false,
      createdAt: now,
      updatedAt: now,
    };
    upsertLocalScheduleTask(task);
  }

  private async deleteTask(source: TaskSource, id: string): Promise<void> {
    if (source === 'local') {
      deleteLocalScheduleTask(id);
      this.notify('已删除本地任务', 'success');
      await this.refresh();
      return;
    }
    try {
      await this.apiRequest(`/api/cli/schedules/${id}`, 'DELETE');
      this.notify('已删除任务', 'success');
      await this.refresh();
    } catch (err) {
      this.notify(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  private async toggleActive(
    source: TaskSource,
    id: string,
    active: boolean,
  ): Promise<void> {
    if (source === 'local') {
      const tasks = loadLocalScheduleTasks();
      const target = tasks.find((entry) => entry.id === id);
      if (target) {
        target.active = active;
        target.updatedAt = new Date().toISOString();
        upsertLocalScheduleTask(target);
      }
      await this.refresh();
      return;
    }
    try {
      await this.apiRequest(`/api/cli/schedules/${id}`, 'PATCH', { active });
      await this.refresh();
    } catch (err) {
      this.notify(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  private filterTasks(): UnifiedTask[] {
    return this.tasks.filter((entry) => {
      const raw = entry.raw;
      switch (this.filter) {
        case 'web':
          return entry.source === 'web';
        case 'local':
          return entry.source === 'local';
        case 'active':
          return raw.active && !isArchived(raw);
        case 'archived':
          return isArchived(raw) || !raw.active;
        default:
          return true;
      }
    });
  }

  private renderToolbar(): TemplateResult {
    return html`
      <div class="schedule-topbar">
        <div class="schedule-topbar-left">
          <button
            class="schedule-icon-btn"
            type="button"
            title="返回"
            aria-label="返回"
            @click=${() => this.onBack?.()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"
              width="16" height="16">
              <line x1="19" y1="12" x2="5" y2="12"></line>
              <polyline points="12 19 5 12 12 5"></polyline>
            </svg>
          </button>
          <span class="schedule-title">定时任务</span>
        </div>
        <div class="schedule-topbar-right">
          <button
            class="schedule-icon-btn"
            type="button"
            title="刷新"
            aria-label="刷新"
            ?disabled=${this.loading}
            @click=${() => void this.refresh()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"
              width="16" height="16">
              <polyline points="1 4 1 10 7 10"></polyline>
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
            </svg>
          </button>
          <button
            class="schedule-action-btn"
            type="button"
            @click=${() => this.startCreate()}
          >
            新建
          </button>
        </div>
      </div>
    `;
  }

  private renderFilters(): TemplateResult {
    const filters: Array<{ value: FilterKind; label: string }> = [
      { value: 'all', label: '全部' },
      { value: 'web', label: 'Web' },
      { value: 'local', label: '本地' },
      { value: 'active', label: '生效中' },
      { value: 'archived', label: '已停用' },
    ];
    return html`
      <div class="schedule-filters">
        ${filters.map(
          (item) => html`
            <button
              class="schedule-chip ${this.filter === item.value ? 'active' : ''}"
              type="button"
              @click=${() => {
                this.filter = item.value;
                this.render();
              }}
            >
              ${item.label}
            </button>
          `,
        )}
      </div>
    `;
  }

  private renderChannelOptions(): TemplateResult {
    const channels = this.imChannels;
    return html`
      <option value="">系统通知</option>
      <option value="desktop" ?selected=${this.form.notifyChannel === 'desktop'}>
        系统通知（Desktop）
      </option>
      <option value="im:auto" ?selected=${this.form.notifyChannel === 'im:auto'}>
        IM：自动选择
      </option>
      ${channels.map((channel) => {
        const value = `im:${channel.adapter}`;
        return html`
          <option
            value=${value}
            ?selected=${this.form.notifyChannel === value}
          >
            IM：${channel.label}
          </option>
        `;
      })}
    `;
  }

  private renderForm(): TemplateResult {
    if (!this.showCreateForm) return html``;
    const form = this.form;
    const editingWeb = this.editing?.source === 'web';
    const isImRoute = form.remoteControl || form.notifyChannel.startsWith('im:');
    return html`
      <div class="schedule-form-panel">
        <div class="schedule-form-header">
          <span>${this.editing ? '编辑任务' : '新建任务'}</span>
          <button
            class="schedule-icon-btn"
            type="button"
            aria-label="关闭"
            @click=${() => this.cancelForm()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"
              width="14" height="14">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <label class="schedule-field">
          <span class="schedule-field-label">来源</span>
          <select
            class="schedule-select"
            .value=${form.source}
            ?disabled=${editingWeb}
            @change=${(e: Event) => {
              const value = (e.currentTarget as HTMLSelectElement).value;
              this.form.source = value === 'web' ? 'web' : 'local';
              this.render();
            }}
          >
            <option value="local" ?selected=${form.source === 'local'}>
              本地（仅 Desktop 运行时触发）
            </option>
            <option value="web" ?selected=${form.source === 'web'}>
              Web 后端（服务器触发）
            </option>
          </select>
        </label>
        <label class="schedule-field">
          <span class="schedule-field-label">类型</span>
          <select
            class="schedule-select"
            .value=${form.type}
            @change=${(e: Event) => {
              const value = (e.currentTarget as HTMLSelectElement).value;
              this.form.type = value === 'daily' ? 'daily' : 'delay';
              this.render();
            }}
          >
            <option value="delay" ?selected=${form.type === 'delay'}>
              单次延时
            </option>
            <option value="daily" ?selected=${form.type === 'daily'}>
              每日重复
            </option>
          </select>
        </label>
        <label class="schedule-field">
          <span class="schedule-field-label">标题（可选）</span>
          <input
            class="schedule-input"
            type="text"
            .value=${form.title}
            @input=${(e: Event) => {
              this.form.title = (e.currentTarget as HTMLInputElement).value;
            }}
          />
        </label>
        <label class="schedule-field">
          <span class="schedule-field-label">提示词</span>
          <textarea
            class="schedule-textarea"
            rows="4"
            .value=${form.prompt}
            @input=${(e: Event) => {
              this.form.prompt = (e.currentTarget as HTMLTextAreaElement).value;
            }}
          ></textarea>
        </label>
        <label class="schedule-field">
          <span class="schedule-field-label">时区</span>
          <input
            class="schedule-input"
            type="text"
            .value=${form.timezone}
            @input=${(e: Event) => {
              this.form.timezone = (e.currentTarget as HTMLInputElement).value;
            }}
          />
        </label>
        ${form.type === 'daily'
          ? html`
              <label class="schedule-field">
                <span class="schedule-field-label">每日时间（HH:mm）</span>
                <input
                  class="schedule-input"
                  type="time"
                  .value=${form.dailyTime}
                  @input=${(e: Event) => {
                    this.form.dailyTime = (e.currentTarget as HTMLInputElement).value;
                  }}
                />
              </label>
            `
          : html`
              <label class="schedule-field">
                <span class="schedule-field-label">触发时间</span>
                <input
                  class="schedule-input"
                  type="datetime-local"
                  .value=${form.runAt}
                  @input=${(e: Event) => {
                    this.form.runAt = (e.currentTarget as HTMLInputElement).value;
                  }}
                />
              </label>
            `}
        <label class="schedule-field">
          <span class="schedule-field-label">通知渠道</span>
          <select
            class="schedule-select"
            .value=${form.notifyChannel}
            @change=${(e: Event) => {
              this.form.notifyChannel = (e.currentTarget as HTMLSelectElement).value;
              this.render();
            }}
          >
            ${this.renderChannelOptions()}
          </select>
        </label>
        <label class="schedule-checkbox">
          <input
            type="checkbox"
            .checked=${form.remoteControl}
            @change=${(e: Event) => {
              this.form.remoteControl = (e.currentTarget as HTMLInputElement).checked;
              this.render();
            }}
          />
          <span>远程操控（将通过 IM 渠道反向控制）</span>
        </label>
        ${isImRoute && form.source === 'local'
          ? html`<div class="schedule-hint">
              远程操控任务将创建在 Web 后端。
            </div>`
          : nothing}
        <div class="schedule-form-actions">
          <button
            class="schedule-action-btn"
            type="button"
            ?disabled=${this.saving}
            @click=${() => this.cancelForm()}
          >
            取消
          </button>
          <button
            class="schedule-action-btn primary"
            type="button"
            ?disabled=${this.saving}
            @click=${() => void this.saveForm()}
          >
            ${this.saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    `;
  }

  private renderTaskCard(entry: UnifiedTask): TemplateResult {
    const raw = entry.raw;
    const id = taskId(raw);
    const archived = isArchived(raw) || !raw.active;
    return html`
      <div class="schedule-card ${archived ? 'archived' : ''}">
        <div class="schedule-card-head">
          <span class="schedule-badge source-${entry.source}">
            ${entry.source === 'web' ? 'Web' : '本地'}
          </span>
          <span class="schedule-badge type-${raw.type}">
            ${raw.type === 'daily' ? '每日' : '延时'}
          </span>
          <span class="schedule-badge channel">
            ${describeChannel(raw.notifyChannel)}
          </span>
          ${raw.remoteControl
            ? html`<span class="schedule-badge remote">远程</span>`
            : nothing}
          ${archived
            ? html`<span class="schedule-badge inactive">已停用</span>`
            : nothing}
          <span class="schedule-card-spacer"></span>
          <button
            class="schedule-icon-btn"
            type="button"
            title="编辑"
            aria-label="编辑"
            @click=${() => this.startEdit(entry.source, id)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
              width="14" height="14">
              <path d="M12 20h9"></path>
              <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"></path>
            </svg>
          </button>
          <button
            class="schedule-icon-btn"
            type="button"
            title="删除"
            aria-label="删除"
            @click=${() => void this.deleteTask(entry.source, id)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
              width="14" height="14">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
            </svg>
          </button>
        </div>
        <div class="schedule-card-title">${raw.title ?? '（无标题）'}</div>
        <div class="schedule-card-prompt">${raw.prompt}</div>
        <div class="schedule-card-meta">
          <span>下次触发：${formatDate(raw.nextRunAt)}</span>
          <span>上次触发：${formatDate(raw.lastTriggeredAt)}</span>
        </div>
        <div class="schedule-card-actions">
          <button
            class="schedule-action-btn"
            type="button"
            @click=${() => void this.toggleActive(entry.source, id, !raw.active)}
          >
            ${raw.active ? '停用' : '启用'}
          </button>
        </div>
      </div>
    `;
  }

  private renderBody(): TemplateResult {
    if (this.loading && this.tasks.length === 0) {
      return html`<div class="schedule-empty">载入中…</div>`;
    }
    if (this.error) {
      return html`<div class="schedule-empty error">${this.error}</div>`;
    }
    const filtered = this.filterTasks();
    if (filtered.length === 0) {
      return html`<div class="schedule-empty">暂无任务</div>`;
    }
    return html`
      <div class="schedule-list">
        ${filtered.map((entry) => this.renderTaskCard(entry))}
      </div>
    `;
  }

  private render(): void {
    render(
      html`
        <div class="schedule-root">
          ${this.renderToolbar()}
          ${this.renderFilters()}
          ${this.renderBody()}
          ${this.renderForm()}
        </div>
      `,
      this.container,
    );
  }
}

function taskId(raw: WebScheduleTask | LocalScheduleTask): string {
  return raw.id;
}

function isArchived(raw: WebScheduleTask | LocalScheduleTask): boolean {
  if ('archived' in raw && raw.archived === true) return true;
  return false;
}
