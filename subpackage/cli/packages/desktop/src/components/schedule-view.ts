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
import { normalizeImChannel, type ImChannelEntry } from './im-channels.js';

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
  preferredNodeId: string | null;
  allowedNodes: string[] | null;
  autoFallbackNode: boolean;
  failureCount: number;
  disabledByFailure: boolean;
}

interface ImChannel extends ImChannelEntry {}

interface AgentdNodeOption {
  id: string;
  label: string;
  status: 'online' | 'offline';
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
  // Web-task agentd node routing. Only meaningful when source='web'
  // and remoteControl=false; ignored for local tasks.
  preferredNodeId: string; // '' = auto
  autoFallbackNode: boolean;
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
    preferredNodeId: asString(task.preferredNodeId),
    allowedNodes:
      Array.isArray(task.allowedNodes) &&
      task.allowedNodes.every((v) => typeof v === 'string')
        ? (task.allowedNodes as string[])
        : null,
    autoFallbackNode: task.autoFallbackNode === true,
    failureCount:
      typeof task.failureCount === 'number' && task.failureCount >= 0
        ? task.failureCount
        : 0,
    disabledByFailure: task.disabledByFailure === true,
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

export async function fetchAgentdNodes(): Promise<AgentdNodeOption[]> {
  const auth = await readAgentbosterDesktopAuth();
  if (!auth) return [];
  try {
    const root = auth.url.replace(/\/+$/, '');
    const response = await fetch(`${root}/api/cli/agentd-nodes`, {
      headers: { authorization: `Bearer ${auth.token}` },
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) return [];
    const list = asRecord(body);
    const items = Array.isArray(list.nodes) ? list.nodes : [];
    const nodes: AgentdNodeOption[] = [];
    for (const entry of items) {
      const node = asRecord(entry);
      const id = asString(node.id);
      if (!id) continue;
      nodes.push({
        id,
        label: asString(node.label) ?? asString(node.ip) ?? id,
        status: node.status === 'online' ? 'online' : 'offline',
      });
    }
    return nodes;
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
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
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
    preferredNodeId: '',
    autoFallbackNode: false,
    source: 'local',
  };
}

/**
 * Format an ISO timestamp into the value expected by
 * `<input type="datetime-local">` (`YYYY-MM-DDTHH:mm`, no timezone suffix),
 * interpreted in the given IANA timezone. Returns empty string when the
 * input is not parseable so the input clears instead of silently falling
 * back to the browser's local zone.
 */
function isoToDatetimeLocal(iso: string | null, timezone: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (type: string): string =>
      parts.find((p) => p.type === type)?.value ?? '';
    const year = get('year');
    const month = get('month');
    const day = get('day');
    const hour = get('hour') === '24' ? '00' : get('hour');
    const minute = get('minute');
    if (!year || !month || !day || !hour || !minute) return '';
    return `${year}-${month}-${day}T${hour}:${minute}`;
  } catch {
    // Invalid timezone — fall back to local interpretation.
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
      date.getDate(),
    )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

/**
 * Parse a `datetime-local` string (interpreted in the given IANA timezone)
 * into an ISO string. Returns null when the input is empty or invalid.
 *
 * `datetime-local` inputs yield a wall-clock string with no zone; to turn
 * that into an absolute instant we have to tell the runtime which zone the
 * wall clock is in. We do that with the long-form "wall-time → UTC"
 * algorithm: pin the wall-clock fields, walk to the next midnight in the
 * target zone, and compare the wall-time delta. This avoids pulling in a
 * heavy tz data dependency at runtime.
 */
function datetimeLocalToIso(local: string, timezone: string): string | null {
  if (!local) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  const year = Number.parseInt(y, 10);
  const month = Number.parseInt(mo, 10);
  const day = Number.parseInt(d, 10);
  const hour = Number.parseInt(h, 10);
  const minute = Number.parseInt(mi, 10);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return null;
  }

  // Build the same wall-clock instant in UTC and in the target zone, then
  // diff. The diff is the offset we need to subtract from the UTC instant
  // to get the actual moment the user meant.
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  try {
    // Intl can throw on invalid timezone — guard with try/catch.
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || undefined,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = formatter.formatToParts(new Date(wallUtc));
    const get = (type: string): number => {
      const v = parts.find((p) => p.type === type)?.value ?? '';
      return Number.parseInt(v, 10);
    };
    const zYear = get('year');
    const zMonth = get('month');
    const zDay = get('day');
    const zHour = get('hour') === 24 ? 0 : get('hour');
    const zMinute = get('minute');
    const zSecond = get('second');
    const wallInZone = Date.UTC(
      zYear,
      zMonth - 1,
      zDay,
      zHour,
      zMinute,
      zSecond,
      0,
    );
    const offsetMs = wallInZone - wallUtc;
    const absolute = wallUtc - offsetMs;
    return new Date(absolute).toISOString();
  } catch {
    // Invalid timezone — treat as browser local.
    const localDate = new Date(year, month - 1, day, hour, minute, 0, 0);
    return localDate.toISOString();
  }
}

function computeDelayNextRunAt(
  runAtLocal: string,
  timezone: string,
): string | null {
  return datetimeLocalToIso(runAtLocal, timezone);
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

  // Find the next wall-clock occurrence of `hour:minute` in `timezone`
  // that is strictly after now. Walk day-by-day (max 2 days to skip
  // a same-day slot that already passed).
  const now = new Date();
  for (let offsetDays = 0; offsetDays < 3; offsetDays++) {
    const candidate = new Date(now);
    candidate.setUTCDate(candidate.getUTCDate() + offsetDays);
    const year = candidate.getUTCFullYear();
    const month = candidate.getUTCMonth();
    const day = candidate.getUTCDate();
    // Construct a datetime-local-style string and reuse the local→ISO
    // conversion so DST and timezone offsets are handled consistently.
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = `${year}-${pad(month + 1)}-${pad(day)}T${pad(hour)}:${pad(
      minute,
    )}`;
    const iso = datetimeLocalToIso(local, timezone);
    if (!iso) continue;
    const instant = new Date(iso).getTime();
    if (instant > now.getTime()) {
      return iso;
    }
  }
  return null;
}

export class ScheduleView {
  private container: HTMLElement;
  private onBack: (() => void) | null = null;
  private onNotify:
    | ((message: string, kind: 'info' | 'success' | 'error') => void)
    | null = null;
  private sessionIdProvider: (() => string | null) | null = null;

  private auth: AgentbosterDesktopAuth | null = null;
  private tasks: UnifiedTask[] = [];
  private imChannels: ImChannel[] = [];
  // agentd nodes fetched lazily when the user opens the Web-task form.
  // Empty list = either not yet loaded or single-node install; the form
  // gracefully renders just "自动" in that case.
  private agentdNodes: AgentdNodeOption[] = [];
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

  /**
   * Inject a provider returning the currently active backend session UUID,
   * if any. Scheduled tasks must reference an existing backend session, so
   * the Web-task creation flow reads this value (or, when null, falls back
   * to the user's most recent session on the backend). When neither is
   * available, creating or migrating to a Web task is blocked with an
   * actionable error.
   */
  setSessionIdProvider(provider: () => string | null): void {
    this.sessionIdProvider = provider;
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

  private notify(
    message: string,
    kind: 'info' | 'success' | 'error' = 'info',
  ): void {
    this.onNotify?.(message, kind);
  }

  /**
   * Resolve a backend session id for the Web-task payload. Prefer the
   * injected provider (the currently active chat session). When that is
   * missing, fall back to the user's most recently updated backend
   * session. Returns null when neither is available (e.g. the user has
   * never opened a backend session from this account).
   */
  private async resolveWebSessionId(): Promise<string | null> {
    const direct = this.sessionIdProvider?.() ?? null;
    if (direct) return direct;

    if (!this.auth) return null;
    try {
      const root = this.auth.url.replace(/\/+$/, '');
      const response = await fetch(`${root}/api/cli/sessions?limit=1`, {
        headers: { authorization: `Bearer ${this.auth.token}` },
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) return null;
      const list = asRecord(body);
      const sessions = Array.isArray(list.sessions) ? list.sessions : [];
      const first = asRecord(sessions[0]);
      return asString(first.id);
    } catch {
      return null;
    }
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.render();
    try {
      const auth = await readAgentbosterDesktopAuth();
      this.auth = auth;
      // Use allSettled so a Web-side failure (offline backend, expired
      // token, agentd-node list 500) doesn't prevent local tasks from
      // rendering. Local tasks live entirely in localStorage and must
      // stay manageable even when the backend is unreachable — that's
      // the whole point of having a separate local task source. The
      // previous Promise.all form propagated the first rejection and
      // left this.tasks empty, locking the user out of local task
      // management during any backend outage.
      const [webTasks, channels, localTasks, nodes] = await Promise.all([
        auth
          ? this.fetchWebTasks(auth).catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              // Surface via the desktop notification toast (wired in
              // main.ts) so the user understands why Web tasks are
              // missing without blocking local task management.
              this.notify(`Web 任务加载失败：${msg}`, 'error');
              return [] as WebScheduleTask[];
            })
          : Promise.resolve([]),
        auth ? fetchImChannels().catch(() => []) : Promise.resolve([]),
        Promise.resolve(loadLocalScheduleTasks()),
        auth ? fetchAgentdNodes().catch(() => []) : Promise.resolve([]),
      ]);
      this.imChannels = channels;
      this.agentdNodes = nodes;
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
    const timezone = raw.timezone ?? DEFAULT_TIMEZONE;
    // Convert the ISO nextRunAt back into the wall-clock value the
    // `<input type="datetime-local">` expects, interpreted in the
    // task's own timezone. Feeding the raw ISO string directly clears
    // the input in most browsers.
    const delayLocal =
      raw.type === 'delay'
        ? isoToDatetimeLocal(raw.nextRunAt ?? '', timezone)
        : '';
    this.editing = { source, id };
    this.form = {
      type: raw.type,
      title: raw.title ?? '',
      prompt: raw.prompt,
      timezone,
      dailyTime: raw.dailyTime ?? '09:00',
      runAt: delayLocal,
      notifyChannel: raw.notifyChannel ?? getDefaultImChannel(),
      remoteControl: raw.remoteControl,
      // Node routing only exists on Web tasks; for local tasks leave
      // the form fields at their defaults — they're hidden in the UI.
      preferredNodeId:
        source === 'web'
          ? ((raw as WebScheduleTask).preferredNodeId ?? '')
          : '',
      autoFallbackNode:
        source === 'web'
          ? ((raw as WebScheduleTask).autoFallbackNode ?? false)
          : false,
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
    const isImRoute =
      form.remoteControl || form.notifyChannel.startsWith('im:');
    // When editing an existing local task we MUST NOT silently migrate it
    // to a Web task: the user picked "local" when they created it, and a
    // PATCH/POST against the Web API would orphan the local row. Block the
    // implicit migration and ask the user to delete + recreate instead.
    const editingLocal =
      this.editing !== null && this.editing.source === 'local';
    if (editingLocal && isImRoute) {
      this.notify(
        '当前为本地任务，无法切换到 IM/远程控制路由。请删除后新建 Web 任务。',
        'error',
      );
      return;
    }
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
      this.notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      this.saving = false;
      this.render();
    }
  }

  private async saveWebTask(form: FormState): Promise<void> {
    const editingId =
      this.editing && this.editing.source === 'web' ? this.editing.id : null;

    // For PATCH we need to send the full task body (the server recomputes
    // times and rebuilds the workflow run from the payload). For POST we
    // also need sessionId — the backend rejects the request without it.
    const payload: Record<string, unknown> = {
      type: form.type,
      title: form.title.trim() || null,
      prompt: form.prompt,
      timezone: form.timezone.trim() || DEFAULT_TIMEZONE,
      notifyChannel: form.notifyChannel || null,
      remoteControl: form.remoteControl,
      // Node routing — sent even for local-target tasks because the
      // server ignores it when remoteControl is true; the values stay
      // in the DB so the user can flip remoteControl later without
      // losing their node preference. An empty preferredNodeId means
      // "auto" (server stores null).
      preferredNodeId: form.preferredNodeId.trim() || null,
      autoFallbackNode: form.autoFallbackNode,
    };
    if (form.type === 'daily') {
      payload.dailyTime = form.dailyTime;
    } else {
      const next = computeDelayNextRunAt(form.runAt, form.timezone);
      if (!next) throw new Error('请输入有效的触发时间');
      payload.runAt = next;
    }

    if (editingId) {
      // Carry over `active` from the existing task so PATCH doesn't
      // accidentally re-enable a disabled task (or disable an active one).
      const existing = this.tasks.find(
        (entry) => entry.source === 'web' && taskId(entry.raw) === editingId,
      );
      payload.active = existing ? Boolean(existing.raw.active) : true;
      // allowedNodes has no form field (the UI only exposes
      // preferredNodeId + autoFallbackNode). Transparently carry over
      // the existing value so PATCH doesn't wipe a fallback list the
      // user previously configured through the API.
      const existingRaw = existing?.raw as WebScheduleTask | undefined;
      payload.allowedNodes = existingRaw?.allowedNodes ?? null;
      await this.apiRequest(
        `/api/cli/schedules/${editingId}`,
        'PATCH',
        payload,
      );
      return;
    }

    const sessionId = await this.resolveWebSessionId();
    if (!sessionId) {
      throw new Error(
        '未找到可关联的后端会话。请先在 Web 端创建会话，或在桌面端打开一个聊天会话后再试。',
      );
    }
    payload.sessionId = sessionId;
    await this.apiRequest('/api/cli/schedules', 'POST', payload);
  }
  private saveLocalTask(form: FormState): void {
    const now = new Date().toISOString();
    const editingId =
      this.editing && this.editing.source === 'local' ? this.editing.id : null;

    // When editing, preserve the existing active / lastTriggeredAt /
    // createdAt so we don't reset task history or silently re-enable a
    // disabled task. Only the form-editable fields are overwritten.
    const existing = editingId
      ? loadLocalScheduleTasks().find((entry) => entry.id === editingId)
      : null;

    const id = editingId ?? newTaskId();
    const nextRunAt =
      form.type === 'daily'
        ? computeDailyNextRunAt(form.dailyTime, form.timezone)
        : computeDelayNextRunAt(form.runAt, form.timezone);

    // Reject saving an active task with no valid next fire time. This
    // happens when the form carried invalid dailyTime/runAt —
    // computeDailyNextRunAt returns null on bad input, and
    // computeDelayNextRunAt returns null on empty/invalid datetime-local.
    // Persisting such a task with active=true would put it in a zombie
    // state: the UI shows "active" but the scheduler skips it every
    // tick (it does `if (!task.nextRunAt) continue;`).
    const incomingActive = existing ? existing.active : true;
    if (incomingActive && !nextRunAt) {
      throw new Error(
        form.type === 'delay'
          ? '请输入有效的触发时间'
          : '请输入有效的每日时间（HH:mm）',
      );
    }

    const task: LocalScheduleTask = {
      id,
      type: form.type,
      title: form.title.trim() || null,
      prompt: form.prompt,
      timezone: form.timezone.trim() || null,
      dailyTime: form.type === 'daily' ? form.dailyTime : null,
      nextRunAt,
      // Preserve execution state when editing; fresh defaults for new tasks.
      lastTriggeredAt: existing?.lastTriggeredAt ?? null,
      active: existing ? existing.active : true,
      notifyChannel: form.notifyChannel || null,
      remoteControl: false,
      // Preserve failure history when editing existing tasks. Reset
      // only happens on explicit re-enable via toggleActive.
      failureCount: existing?.failureCount ?? 0,
      disabledByFailure: existing?.disabledByFailure ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    upsertLocalScheduleTask(task);
  }
  private async deleteTask(source: TaskSource, id: string): Promise<void> {
    if (source === 'local') {
      try {
        deleteLocalScheduleTask(id);
        this.notify('已删除本地任务', 'success');
        await this.refresh();
      } catch (err) {
        this.notify(err instanceof Error ? err.message : String(err), 'error');
      }
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
      try {
        const tasks = loadLocalScheduleTasks();
        const target = tasks.find((entry) => entry.id === id);
        if (target) {
          // Don't re-enable a task that has no valid next fire time.
          // Delay tasks clear nextRunAt after firing; re-enabling them
          // without setting a new time would put them in a zombie
          // state (UI shows active, scheduler skips every tick). Ask
          // the user to edit the task with a fresh time first.
          if (active && !target.nextRunAt) {
            this.notify(
              target.type === 'delay'
                ? '请编辑任务设置新的触发时间后再启用'
                : '请编辑任务设置有效的每日时间后再启用',
              'error',
            );
            return;
          }
          target.active = active;
          target.updatedAt = new Date().toISOString();
          // Re-enabling a task gives it a fresh start — clear the
          // failure counter and the auto-disable flag. Disabling
          // leaves the counter intact so the next enable still starts
          // from zero (failureCount is only meaningfully read on the
          // auto-disable path, where it has just been bumped to the
          // threshold).
          if (active) {
            target.failureCount = 0;
            target.disabledByFailure = false;
          }
          upsertLocalScheduleTask(target);
        }
        await this.refresh();
      } catch (err) {
        this.notify(err instanceof Error ? err.message : String(err), 'error');
      }
      return;
    }
    // Web PATCH expects a full task body (the server recomputes times and
    // rebuilds the workflow from the payload). Sending only `{ active }`
    // would 400 because prompt / type / etc. are required. Re-fetch the
    // task from the cached list and send the full body.
    const existing = this.tasks.find(
      (entry) => entry.source === 'web' && taskId(entry.raw) === id,
    );
    if (!existing) {
      this.notify('找不到任务，无法切换状态', 'error');
      return;
    }
    const raw = existing.raw as WebScheduleTask;
    const payload: Record<string, unknown> = {
      type: raw.type,
      title: raw.title ?? null,
      prompt: raw.prompt,
      timezone: raw.timezone ?? DEFAULT_TIMEZONE,
      notifyChannel: raw.notifyChannel ?? null,
      remoteControl: raw.remoteControl,
      // Carry over node routing fields — the server's PATCH handler
      // treats missing fields as null/false, so omitting them here
      // would silently clear the user's preferredNodeId / fallback
      // config every time the user toggles the task on or off.
      preferredNodeId: raw.preferredNodeId ?? null,
      allowedNodes: raw.allowedNodes ?? null,
      autoFallbackNode: raw.autoFallbackNode ?? false,
      active,
    };
    if (raw.type === 'daily') {
      payload.dailyTime = raw.dailyTime ?? '09:00';
    } else {
      // For delay tasks, fall back to nextRunAt when the task hasn't
      // fired yet; if it has, the server still needs a valid future
      // instant to schedule. Use the original nextRunAt if it's still
      // in the future, otherwise push it out by a day.
      const fallback =
        raw.nextRunAt && new Date(raw.nextRunAt).getTime() > Date.now()
          ? raw.nextRunAt
          : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      payload.runAt = fallback;
    }
    try {
      await this.apiRequest(`/api/cli/schedules/${id}`, 'PATCH', payload);
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
    const isImRoute =
      form.remoteControl || form.notifyChannel.startsWith('im:');
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
        ${
          form.type === 'daily'
            ? html`
              <label class="schedule-field">
                <span class="schedule-field-label">每日时间（HH:mm）</span>
                <input
                  class="schedule-input"
                  type="time"
                  .value=${form.dailyTime}
                  @input=${(e: Event) => {
                    this.form.dailyTime = (
                      e.currentTarget as HTMLInputElement
                    ).value;
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
                    this.form.runAt = (
                      e.currentTarget as HTMLInputElement
                    ).value;
                  }}
                />
              </label>
            `
        }
        <label class="schedule-field">
          <span class="schedule-field-label">通知渠道</span>
          <select
            class="schedule-select"
            .value=${form.notifyChannel}
            @change=${(e: Event) => {
              this.form.notifyChannel = (
                e.currentTarget as HTMLSelectElement
              ).value;
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
              this.form.remoteControl = (
                e.currentTarget as HTMLInputElement
              ).checked;
              this.render();
            }}
          />
          <span>远程操控（将通过 IM 渠道反向控制）</span>
        </label>
        ${
          // Node routing only applies to backend-dispatched Web tasks
          // that are NOT remote-controlling a CLI session. Hidden for
          // local tasks and remote-control tasks — in both cases the
          // execution target is a CLI process, not an agentd node.
          form.source === 'web' && !form.remoteControl
            ? html`
              <label class="schedule-field">
                <span class="schedule-field-label">运行节点</span>
                <select
                  class="schedule-select"
                  .value=${form.preferredNodeId}
                  @change=${(e: Event) => {
                    this.form.preferredNodeId = (
                      e.currentTarget as HTMLSelectElement
                    ).value;
                    this.render();
                  }}
                >
                  <option value="" ?selected=${!form.preferredNodeId}>
                    自动（由后端选择）
                  </option>
                  ${this.agentdNodes.map(
                    (node) => html`
                      <option
                        value=${node.id}
                        ?selected=${form.preferredNodeId === node.id}
                      >
                        ${node.label}${
                          node.status === 'offline' ? '（离线）' : ''
                        }
                      </option>
                    `,
                  )}
                </select>
              </label>
              <label class="schedule-checkbox">
                <input
                  type="checkbox"
                  .checked=${form.autoFallbackNode}
                  ?disabled=${!form.preferredNodeId}
                  @change=${(e: Event) => {
                    this.form.autoFallbackNode = (
                      e.currentTarget as HTMLInputElement
                    ).checked;
                  }}
                />
                <span>
                  节点离线时自动切换（默认关闭，失败计入连续失败计数）
                </span>
              </label>
            `
            : nothing
        }
        ${
          isImRoute && form.source === 'local'
            ? html`<div class="schedule-hint">
              远程操控任务将创建在 Web 后端。
            </div>`
            : nothing
        }
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
    // Web and local tasks both carry disabledByFailure (Web via API,
    // local via localStorage); distinguish "auto-disabled by repeated
    // failure" from "user manually disabled" so the user understands
    // why the task stopped and knows to re-enable it.
    const disabledByFailure =
      (raw as { disabledByFailure?: boolean }).disabledByFailure === true;
    const failureCount =
      typeof (raw as { failureCount?: number }).failureCount === 'number'
        ? ((raw as { failureCount?: number }).failureCount as number)
        : 0;
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
          ${
            raw.remoteControl
              ? html`<span class="schedule-badge remote">远程</span>`
              : nothing
          }
          ${
            // Show "失败 N/3" badge on any non-zero failure count, even
            // when the task is still active — gives the user early
            // warning before auto-disable trips.
            !disabledByFailure && failureCount > 0
              ? html`<span class="schedule-badge warn">
                  失败 ${failureCount}/3
                </span>`
              : nothing
          }
          ${
            disabledByFailure
              ? html`<span class="schedule-badge inactive">
                  已自动停用（连续失败 ${failureCount} 次）
                </span>`
              : nothing
          }
          ${
            archived && !disabledByFailure
              ? html`<span class="schedule-badge inactive">已停用</span>`
              : nothing
          }
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
