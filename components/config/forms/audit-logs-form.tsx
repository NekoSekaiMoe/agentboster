'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Download, Filter, Search } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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

interface ReviewLog {
  id: string;
  taskId: string;
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

export function AuditLogsForm() {
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
        <h2 className="text-2xl font-bold tracking-tight">Audit Logs</h2>
        <p className="text-muted-foreground">
          Review security audit logs for all agent operations.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
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
                <Label className="text-xs mb-1.5 block">Level</Label>
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
                <Label className="text-xs mb-1.5 block">Decision</Label>
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
                <Label className="text-xs mb-1.5 block">Agent ID</Label>
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
                <Label className="text-xs mb-1.5 block">Search Command</Label>
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
                <Label className="text-xs mb-1.5 block">Task ID</Label>
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
                <Label className="text-xs mb-1.5 block">From</Label>
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
                <Label className="text-xs mb-1.5 block">To</Label>
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
              <div className="px-4 py-2 border-b text-xs text-muted-foreground">
                {logs.length} record{logs.length !== 1 ? 's' : ''}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Time</TableHead>
                    <TableHead>Level</TableHead>
                    <TableHead>Decision</TableHead>
                    <TableHead>Command</TableHead>
                    <TableHead className="text-right">Score</TableHead>
                    <TableHead>Agent</TableHead>
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
                      <TableCell className="text-xs text-muted-foreground max-w-[120px] truncate">
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

      {/* Detail Dialog */}
      <Dialog
        open={!!selectedLog}
        onOpenChange={(open) => !open && setSelectedLog(null)}
      >
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
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
                  label="Time"
                  value={new Date(selectedLog.createdAt).toLocaleString()}
                />
                <DetailRow
                  label="Level"
                  value={levelLabels[selectedLog.level] || selectedLog.level}
                />
                <DetailRow
                  label="Decision"
                  value={
                    decisionLabels[selectedLog.decision] || selectedLog.decision
                  }
                />
                {selectedLog.score !== null && (
                  <DetailRow label="Score" value={String(selectedLog.score)} />
                )}
                <DetailRow label="Task ID" value={selectedLog.taskId} mono />
                {selectedLog.agentId && (
                  <DetailRow label="Agent" value={selectedLog.agentId} mono />
                )}
                {selectedLog.sessionId && (
                  <DetailRow
                    label="Session"
                    value={selectedLog.sessionId}
                    mono
                  />
                )}

                <div>
                  <Label className="text-xs font-medium text-muted-foreground">
                    Command
                  </Label>
                  <pre className="mt-1 p-3 rounded-md bg-muted font-mono text-xs whitespace-pre-wrap break-all">
                    {selectedLog.command}
                  </pre>
                </div>

                {selectedLog.reason && (
                  <div>
                    <Label className="text-xs font-medium text-muted-foreground">
                      Reason
                    </Label>
                    <p className="mt-1 p-3 rounded-md bg-muted text-sm">
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

function DetailRow({
  label,
  value,
  mono,
}: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <Label className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      <p className={`mt-0.5 text-sm ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </p>
    </div>
  );
}
