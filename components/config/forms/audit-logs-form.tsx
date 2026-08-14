'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity, ChevronDown, Download, Filter, Search } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/components/i18n-provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TraceExplorer } from './trace-explorer';

interface ReviewLog {
  id: string;
  taskId: string;
  traceId: string | null;
  sessionId: string | null;
  command: string;
  level: 'L0' | 'L1' | 'L2';
  score: number | null;
  decision: 'allowed' | 'blocked' | 'pending_confirm';
  reason: string | null;
  createdAt: string;
  agentId: string | null;
}

interface Filters {
  level?: string;
  decision?: string;
  search?: string;
  taskId?: string;
  agentId?: string;
  from?: string;
  to?: string;
}

interface ToolActivityLog {
  id: string;
  taskId: string | null;
  sessionId: string | null;
  traceId: string | null;
  agentId: string;
  userId: string | null;
  sandboxId: string | null;
  model: string | null;
  step: number | null;
  toolCallId: string | null;
  toolName: string;
  action: 'read' | 'write' | 'execute' | 'search' | 'network' | 'other';
  target: string | null;
  arguments: unknown;
  result: unknown;
  outputText: string | null;
  success: boolean;
  error: string | null;
  durationMs: number | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

interface ToolActivityFilters {
  action?: string;
  toolName?: string;
  success?: string;
  search?: string;
  taskId?: string;
  sessionId?: string;
  agentId?: string;
  from?: string;
  to?: string;
}

async function fetchReviewLogs(filters: Filters): Promise<ReviewLog[]> {
  const params = new URLSearchParams();
  if (filters.level) params.set('level', filters.level);
  if (filters.decision) params.set('decision', filters.decision);
  if (filters.search) params.set('search', filters.search);
  if (filters.taskId) params.set('taskId', filters.taskId);
  if (filters.agentId) params.set('agentId', filters.agentId);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);

  const res = await fetch(`/api/config/audit-logs?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to fetch audit logs');
  return res.json();
}

async function fetchToolActivityLogs(
  filters: ToolActivityFilters,
): Promise<ToolActivityLog[]> {
  const params = new URLSearchParams();
  if (filters.action) params.set('action', filters.action);
  if (filters.toolName) params.set('toolName', filters.toolName);
  if (filters.success) params.set('success', filters.success);
  if (filters.search) params.set('search', filters.search);
  if (filters.taskId) params.set('taskId', filters.taskId);
  if (filters.sessionId) params.set('sessionId', filters.sessionId);
  if (filters.agentId) params.set('agentId', filters.agentId);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);

  const res = await fetch(
    `/api/config/tool-activity-logs?${params.toString()}`,
  );
  if (!res.ok) throw new Error('Failed to fetch tool activity logs');
  return res.json();
}

function downloadLogs(filters: Filters) {
  const params = new URLSearchParams();
  if (filters.level) params.set('level', filters.level);
  if (filters.decision) params.set('decision', filters.decision);
  if (filters.search) params.set('search', filters.search);
  if (filters.taskId) params.set('taskId', filters.taskId);
  if (filters.agentId) params.set('agentId', filters.agentId);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);

  const a = document.createElement('a');
  a.href = `/api/config/audit-logs/download?${params.toString()}`;
  a.download = `audit-logs-${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

const levelBadgeClass: Record<string, string> = {
  L0: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  L1: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  L2: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
};

const decisionBadgeClass: Record<string, string> = {
  allowed: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  blocked: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  pending_confirm:
    'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
};

const levelLabels: Record<string, string> = {
  L0: 'L0 — Static Rules',
  L1: 'L1 — LLM Evaluation',
  L2: 'L2 — Human Approval',
};

const decisionLabels: Record<string, string> = {
  allowed: 'Allowed',
  blocked: 'Blocked',
  pending_confirm: 'Pending Confirm',
};

const actionBadgeClass: Record<string, string> = {
  read: 'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200',
  write:
    'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  execute: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  search: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200',
  network:
    'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200',
  other: 'bg-muted text-muted-foreground',
};

const successBadgeClass: Record<string, string> = {
  true: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  false: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
};

export function AuditLogsForm() {
  const { t } = useI18n();
  const [filters, setFilters] = useState<Filters>({});
  const [commandSearch, setCommandSearch] = useState('');
  const [taskIdSearch, setTaskIdSearch] = useState('');
  const [agentIdSearch, setAgentIdSearch] = useState('');
  const [selectedLog, setSelectedLog] = useState<ReviewLog | null>(null);

  const { data: logs, isLoading } = useQuery({
    queryKey: ['audit-logs', filters],
    queryFn: () => fetchReviewLogs(filters),
    refetchInterval: 10000,
  });

  const applyTextFilters = () => {
    setFilters((prev) => ({
      ...prev,
      search: commandSearch || undefined,
      taskId: taskIdSearch || undefined,
      agentId: agentIdSearch || undefined,
    }));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') applyTextFilters();
  };

  const clearFilters = () => {
    setFilters({});
    setCommandSearch('');
    setTaskIdSearch('');
    setAgentIdSearch('');
  };

  const hasActiveFilters =
    filters.level ||
    filters.decision ||
    filters.search ||
    filters.taskId ||
    filters.agentId ||
    filters.from ||
    filters.to;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-bold text-2xl tracking-tight">Audit Logs</h2>
        <p className="text-muted-foreground">
          Review security audit logs for all agent operations.
        </p>
      </div>

      <TraceExplorer />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 font-medium text-sm">
              <Filter className="h-4 w-4" />
              Filters
            </CardTitle>
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear all
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {/* Row 1: Dropdowns */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <Label className="mb-1.5 block text-xs">Level</Label>
                <Select
                  value={filters.level || 'all'}
                  onValueChange={(value) =>
                    setFilters((prev) => ({
                      ...prev,
                      level: value === 'all' ? undefined : value,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Levels</SelectItem>
                    <SelectItem value="L0">L0 (Static Rules)</SelectItem>
                    <SelectItem value="L1">L1 (LLM Evaluation)</SelectItem>
                    <SelectItem value="L2">L2 (Human Approval)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="mb-1.5 block text-xs">Decision</Label>
                <Select
                  value={filters.decision || 'all'}
                  onValueChange={(value) =>
                    setFilters((prev) => ({
                      ...prev,
                      decision: value === 'all' ? undefined : value,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Decisions</SelectItem>
                    <SelectItem value="allowed">Allowed</SelectItem>
                    <SelectItem value="blocked">Blocked</SelectItem>
                    <SelectItem value="pending_confirm">
                      Pending Confirm
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="mb-1.5 block text-xs">Agent ID</Label>
                <Input
                  placeholder="Filter by agent..."
                  value={agentIdSearch}
                  onChange={(e) => setAgentIdSearch(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onBlur={applyTextFilters}
                />
              </div>
            </div>

            {/* Row 2: Text searches */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label className="mb-1.5 block text-xs">Search Command</Label>
                <div className="flex gap-2">
                  <Input
                    placeholder="Search commands..."
                    value={commandSearch}
                    onChange={(e) => setCommandSearch(e.target.value)}
                    onKeyDown={handleKeyDown}
                  />
                  <Button
                    onClick={applyTextFilters}
                    size="icon"
                    variant="outline"
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div>
                <Label className="mb-1.5 block text-xs">Task ID</Label>
                <Input
                  placeholder="Filter by task ID..."
                  value={taskIdSearch}
                  onChange={(e) => setTaskIdSearch(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onBlur={applyTextFilters}
                />
              </div>
            </div>

            {/* Row 3: Date range + download */}
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <Label className="mb-1.5 block text-xs">From</Label>
                <Input
                  type="datetime-local"
                  value={filters.from?.slice(0, 16) || ''}
                  onChange={(e) =>
                    setFilters((prev) => ({
                      ...prev,
                      from: e.target.value
                        ? new Date(e.target.value).toISOString()
                        : undefined,
                    }))
                  }
                />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs">To</Label>
                <Input
                  type="datetime-local"
                  value={filters.to?.slice(0, 16) || ''}
                  onChange={(e) =>
                    setFilters((prev) => ({
                      ...prev,
                      to: e.target.value
                        ? new Date(e.target.value).toISOString()
                        : undefined,
                    }))
                  }
                />
              </div>
              <Button
                onClick={() => downloadLogs(filters)}
                variant="outline"
                className="gap-2"
              >
                <Download className="h-4 w-4" />
                Download CSV
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Logs Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center p-8 text-muted-foreground">
              Loading audit logs...
            </div>
          ) : !logs || logs.length === 0 ? (
            <div className="flex items-center justify-center p-8 text-muted-foreground">
              No audit logs found
            </div>
          ) : (
            <>
              <div className="border-b px-4 py-2 text-muted-foreground text-xs">
                {logs.length} record{logs.length !== 1 ? 's' : ''}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>{t('form.label.time')}</TableHead>
                    <TableHead>{t('form.label.level')}</TableHead>
                    <TableHead>{t('form.label.decision')}</TableHead>
                    <TableHead>Command</TableHead>
                    <TableHead className="text-right">
                      {t('form.label.score')}
                    </TableHead>
                    <TableHead>{t('form.label.agent')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => (
                    <TableRow
                      key={log.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => setSelectedLog(log)}
                    >
                      <TableCell className="w-8 text-muted-foreground">
                        <ChevronDown className="h-4 w-4" />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {new Date(log.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Badge className={levelBadgeClass[log.level] || ''}>
                          {log.level}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={decisionBadgeClass[log.decision] || ''}
                        >
                          {log.decision.replace('_', ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-md truncate font-mono text-xs">
                        {log.command}
                      </TableCell>
                      <TableCell className="text-right">
                        {log.score !== null ? log.score : '-'}
                      </TableCell>
                      <TableCell className="max-w-[120px] truncate text-muted-foreground text-xs">
                        {log.agentId || '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      <ToolActivitySection />

      {/* Detail Dialog */}
      <Dialog
        open={!!selectedLog}
        onOpenChange={(open) => !open && setSelectedLog(null)}
      >
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          {selectedLog && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  Review Log Detail
                  <Badge className={levelBadgeClass[selectedLog.level] || ''}>
                    {selectedLog.level}
                  </Badge>
                  <Badge
                    className={decisionBadgeClass[selectedLog.decision] || ''}
                  >
                    {selectedLog.decision.replace('_', ' ')}
                  </Badge>
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-4 pt-2">
                <DetailRow
                  label={t('form.label.time')}
                  value={new Date(selectedLog.createdAt).toLocaleString()}
                />
                <DetailRow
                  label={t('form.label.level')}
                  value={levelLabels[selectedLog.level] || selectedLog.level}
                />
                <DetailRow
                  label={t('form.label.decision')}
                  value={
                    decisionLabels[selectedLog.decision] || selectedLog.decision
                  }
                />
                {selectedLog.score !== null && (
                  <DetailRow
                    label={t('form.label.score')}
                    value={String(selectedLog.score)}
                  />
                )}
                <DetailRow
                  label={t('form.label.taskId')}
                  value={selectedLog.taskId}
                  mono
                />
                {selectedLog.traceId && (
                  <DetailRow
                    label="Trace ID"
                    value={selectedLog.traceId}
                    mono
                  />
                )}
                {selectedLog.agentId && (
                  <DetailRow
                    label={t('form.label.agent')}
                    value={selectedLog.agentId}
                    mono
                  />
                )}
                {selectedLog.sessionId && (
                  <DetailRow
                    label={t('form.label.session')}
                    value={selectedLog.sessionId}
                    mono
                  />
                )}
                <div>
                  <Label className="font-medium text-muted-foreground text-xs">
                    Command
                  </Label>
                  <pre className="mt-1 whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">
                    {selectedLog.command}
                  </pre>
                </div>

                {selectedLog.reason && (
                  <div>
                    <Label className="font-medium text-muted-foreground text-xs">
                      Reason
                    </Label>
                    <p className="mt-1 rounded-md bg-muted p-3 text-sm">
                      {selectedLog.reason}
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ToolActivitySection() {
  const { t } = useI18n();
  const [filters, setFilters] = useState<ToolActivityFilters>({});
  const [searchText, setSearchText] = useState('');
  const [toolNameSearch, setToolNameSearch] = useState('');
  const [taskIdSearch, setTaskIdSearch] = useState('');
  const [sessionIdSearch, setSessionIdSearch] = useState('');
  const [agentIdSearch, setAgentIdSearch] = useState('');
  const [selectedLog, setSelectedLog] = useState<ToolActivityLog | null>(null);

  const { data: logs, isLoading } = useQuery({
    queryKey: ['tool-activity-logs', filters],
    queryFn: () => fetchToolActivityLogs(filters),
    refetchInterval: 10000,
  });

  const applyTextFilters = () => {
    setFilters((prev) => ({
      ...prev,
      search: searchText || undefined,
      toolName: toolNameSearch || undefined,
      taskId: taskIdSearch || undefined,
      sessionId: sessionIdSearch || undefined,
      agentId: agentIdSearch || undefined,
    }));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') applyTextFilters();
  };

  const clearFilters = () => {
    setFilters({});
    setSearchText('');
    setToolNameSearch('');
    setTaskIdSearch('');
    setSessionIdSearch('');
    setAgentIdSearch('');
  };

  const hasActiveFilters =
    filters.action ||
    filters.toolName ||
    filters.success ||
    filters.search ||
    filters.taskId ||
    filters.sessionId ||
    filters.agentId ||
    filters.from ||
    filters.to;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="flex items-center gap-2 font-semibold text-lg">
          <Activity className="h-4 w-4" />
          Tool Activity Logs
        </h3>
        <p className="text-muted-foreground text-sm">
          Model-requested reads, writes, command executions, and full tool
          results.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 font-medium text-sm">
              <Filter className="h-4 w-4" />
              Tool Filters
            </CardTitle>
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear all
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <Label className="mb-1.5 block text-xs">Action</Label>
                <Select
                  value={filters.action || 'all'}
                  onValueChange={(value) =>
                    setFilters((prev) => ({
                      ...prev,
                      action: value === 'all' ? undefined : value,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Actions</SelectItem>
                    <SelectItem value="read">Read</SelectItem>
                    <SelectItem value="write">Write</SelectItem>
                    <SelectItem value="execute">Execute</SelectItem>
                    <SelectItem value="search">Search</SelectItem>
                    <SelectItem value="network">Network</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="mb-1.5 block text-xs">Status</Label>
                <Select
                  value={filters.success || 'all'}
                  onValueChange={(value) =>
                    setFilters((prev) => ({
                      ...prev,
                      success: value === 'all' ? undefined : value,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="true">Success</SelectItem>
                    <SelectItem value="false">Failed</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="mb-1.5 block text-xs">Tool Name</Label>
                <Input
                  placeholder="Filter by tool..."
                  value={toolNameSearch}
                  onChange={(e) => setToolNameSearch(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onBlur={applyTextFilters}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label className="mb-1.5 block text-xs">
                  Search Target or Result
                </Label>
                <div className="flex gap-2">
                  <Input
                    placeholder="Search targets, output, errors..."
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    onKeyDown={handleKeyDown}
                  />
                  <Button
                    onClick={applyTextFilters}
                    size="icon"
                    variant="outline"
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div>
                <Label className="mb-1.5 block text-xs">Task ID</Label>
                <Input
                  placeholder="Filter by task ID..."
                  value={taskIdSearch}
                  onChange={(e) => setTaskIdSearch(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onBlur={applyTextFilters}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label className="mb-1.5 block text-xs">Session ID</Label>
                <Input
                  placeholder="Filter by session ID..."
                  value={sessionIdSearch}
                  onChange={(e) => setSessionIdSearch(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onBlur={applyTextFilters}
                />
              </div>

              <div>
                <Label className="mb-1.5 block text-xs">Agent ID</Label>
                <Input
                  placeholder="Filter by agent..."
                  value={agentIdSearch}
                  onChange={(e) => setAgentIdSearch(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onBlur={applyTextFilters}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-4">
              <div>
                <Label className="mb-1.5 block text-xs">From</Label>
                <Input
                  type="datetime-local"
                  value={filters.from?.slice(0, 16) || ''}
                  onChange={(e) =>
                    setFilters((prev) => ({
                      ...prev,
                      from: e.target.value
                        ? new Date(e.target.value).toISOString()
                        : undefined,
                    }))
                  }
                />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs">To</Label>
                <Input
                  type="datetime-local"
                  value={filters.to?.slice(0, 16) || ''}
                  onChange={(e) =>
                    setFilters((prev) => ({
                      ...prev,
                      to: e.target.value
                        ? new Date(e.target.value).toISOString()
                        : undefined,
                    }))
                  }
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center p-8 text-muted-foreground">
              Loading tool activity logs...
            </div>
          ) : !logs || logs.length === 0 ? (
            <div className="flex items-center justify-center p-8 text-muted-foreground">
              No tool activity logs found
            </div>
          ) : (
            <>
              <div className="border-b px-4 py-2 text-muted-foreground text-xs">
                {logs.length} record{logs.length !== 1 ? 's' : ''}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>{t('form.label.time')}</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>{t('form.label.status')}</TableHead>
                    <TableHead>{t('form.label.tool')}</TableHead>
                    <TableHead>{t('form.label.target')}</TableHead>
                    <TableHead className="text-right">
                      {t('form.label.duration')}
                    </TableHead>
                    <TableHead>{t('form.label.agent')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => (
                    <TableRow
                      key={log.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => setSelectedLog(log)}
                    >
                      <TableCell className="w-8 text-muted-foreground">
                        <ChevronDown className="h-4 w-4" />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {new Date(log.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Badge className={actionBadgeClass[log.action] || ''}>
                          {log.action}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={successBadgeClass[String(log.success)]}
                        >
                          {log.success ? 'success' : 'failed'}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[180px] truncate font-mono text-xs">
                        {log.toolName}
                      </TableCell>
                      <TableCell className="max-w-md truncate font-mono text-xs">
                        {log.target || '-'}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {formatDuration(log.durationMs)}
                      </TableCell>
                      <TableCell className="max-w-[120px] truncate text-muted-foreground text-xs">
                        {log.agentId || '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={!!selectedLog}
        onOpenChange={(open) => !open && setSelectedLog(null)}
      >
        <DialogContent className="max-h-[82vh] max-w-4xl overflow-y-auto">
          {selectedLog && (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  Tool Activity Detail
                  <Badge className={actionBadgeClass[selectedLog.action] || ''}>
                    {selectedLog.action}
                  </Badge>
                  <Badge
                    className={successBadgeClass[String(selectedLog.success)]}
                  >
                    {selectedLog.success ? 'success' : 'failed'}
                  </Badge>
                </DialogTitle>
              </DialogHeader>

              <div className="grid gap-4 pt-2 sm:grid-cols-2">
                <DetailRow
                  label={t('form.label.started')}
                  value={new Date(selectedLog.startedAt).toLocaleString()}
                />
                <DetailRow
                  label={t('form.label.completed')}
                  value={
                    selectedLog.completedAt
                      ? new Date(selectedLog.completedAt).toLocaleString()
                      : '-'
                  }
                />
                <DetailRow
                  label={t('form.label.tool')}
                  value={selectedLog.toolName}
                  mono
                />
                <DetailRow
                  label={t('form.label.duration')}
                  value={formatDuration(selectedLog.durationMs)}
                />
                {selectedLog.target && (
                  <DetailRow
                    label={t('form.label.target')}
                    value={selectedLog.target}
                    mono
                  />
                )}
                {selectedLog.model && (
                  <DetailRow
                    label={t('form.label.model')}
                    value={selectedLog.model}
                    mono
                  />
                )}
                {selectedLog.step !== null && (
                  <DetailRow
                    label={t('form.label.step')}
                    value={String(selectedLog.step)}
                  />
                )}
                {selectedLog.toolCallId && (
                  <DetailRow
                    label={t('form.label.toolCallId')}
                    value={selectedLog.toolCallId}
                    mono
                  />
                )}
                {selectedLog.taskId && (
                  <DetailRow
                    label={t('form.label.taskId')}
                    value={selectedLog.taskId}
                    mono
                  />
                )}
                {selectedLog.sessionId && (
                  <DetailRow
                    label={t('form.label.session')}
                    value={selectedLog.sessionId}
                    mono
                  />
                )}
                {selectedLog.traceId && (
                  <DetailRow
                    label="Trace ID"
                    value={selectedLog.traceId}
                    mono
                  />
                )}
                <DetailRow
                  label={t('form.label.agent')}
                  value={selectedLog.agentId}
                  mono
                />
                {selectedLog.sandboxId && (
                  <DetailRow
                    label={t('form.label.sandbox')}
                    value={selectedLog.sandboxId}
                    mono
                  />
                )}
              </div>

              <div className="space-y-4 pt-4">
                <DetailBlock
                  label={t('form.label.arguments')}
                  value={formatStructuredValue(selectedLog.arguments)}
                />
                <DetailBlock
                  label={t('form.label.fullResult')}
                  value={
                    selectedLog.outputText ||
                    formatStructuredValue(selectedLog.result)
                  }
                />
                {selectedLog.error && (
                  <DetailBlock
                    label={t('form.label.error')}
                    value={selectedLog.error}
                  />
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function formatDuration(value: number | null): string {
  return typeof value === 'number' ? `${value} ms` : '-';
}

function formatStructuredValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function DetailBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Label className="font-medium text-muted-foreground text-xs">
        {label}
      </Label>
      <pre className="mt-1 max-h-[42vh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">
        {value}
      </pre>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <Label className="font-medium text-muted-foreground text-xs">
        {label}
      </Label>
      <p className={`mt-0.5 text-sm ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </p>
    </div>
  );
}
