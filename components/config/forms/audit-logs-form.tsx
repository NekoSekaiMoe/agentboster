'use client';

import { useQuery } from '@tanstack/react-query';
import { Download, Filter, Search } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
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
}

interface Filters {
  level?: string;
  decision?: string;
  search?: string;
}

async function fetchReviewLogs(filters: Filters): Promise<ReviewLog[]> {
  const params = new URLSearchParams();
  if (filters.level) params.set('level', filters.level);
  if (filters.decision) params.set('decision', filters.decision);
  if (filters.search) params.set('search', filters.search);

  const res = await fetch(`/api/config/audit-logs?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to fetch audit logs');
  return res.json();
}

async function downloadLogs(filters: Filters) {
  const params = new URLSearchParams();
  if (filters.level) params.set('level', filters.level);
  if (filters.decision) params.set('decision', filters.decision);
  if (filters.search) params.set('search', filters.search);

  const res = await fetch(`/api/config/audit-logs/download?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to download logs');

  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-logs-${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(a);
  a.click();
  window.URL.revokeObjectURL(url);
  document.body.removeChild(a);
}

export function AuditLogsForm() {
  const [filters, setFilters] = useState<Filters>({});
  const [searchInput, setSearchInput] = useState('');

  const { data: logs, isLoading } = useQuery({
    queryKey: ['audit-logs', filters],
    queryFn: () => fetchReviewLogs(filters),
    refetchInterval: 10000,
  });

  const handleSearch = () => {
    setFilters({ ...filters, search: searchInput || undefined });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const getLevelBadge = (level: string) => {
    const colors = {
      L0: 'bg-blue-100 text-blue-800',
      L1: 'bg-yellow-100 text-yellow-800',
      L2: 'bg-red-100 text-red-800',
    };
    return colors[level as keyof typeof colors] || 'bg-gray-100 text-gray-800';
  };

  const getDecisionBadge = (decision: string) => {
    const colors = {
      allowed: 'bg-green-100 text-green-800',
      blocked: 'bg-red-100 text-red-800',
      pending_confirm: 'bg-orange-100 text-orange-800',
    };
    return colors[decision as keyof typeof colors] || 'bg-gray-100 text-gray-800';
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Audit Logs</h2>
        <p className="text-muted-foreground">
          Review security audit logs for all agent operations.
        </p>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Filter className="h-4 w-4" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            <div className="flex-1 min-w-[200px]">
              <label className="text-sm font-medium mb-2 block">Level</label>
              <Select
                value={filters.level || 'all'}
                onValueChange={(value) =>
                  setFilters({
                    ...filters,
                    level: value === 'all' ? undefined : value,
                  })
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

            <div className="flex-1 min-w-[200px]">
              <label className="text-sm font-medium mb-2 block">Decision</label>
              <Select
                value={filters.decision || 'all'}
                onValueChange={(value) =>
                  setFilters({
                    ...filters,
                    decision: value === 'all' ? undefined : value,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Decisions</SelectItem>
                  <SelectItem value="allowed">Allowed</SelectItem>
                  <SelectItem value="blocked">Blocked</SelectItem>
                  <SelectItem value="pending_confirm">Pending Confirm</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex-1 min-w-[250px]">
              <label className="text-sm font-medium mb-2 block">
                Search Command
              </label>
              <div className="flex gap-2">
                <Input
                  placeholder="Search commands..."
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                />
                <Button onClick={handleSearch} size="icon" variant="outline">
                  <Search className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="flex items-end">
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Decision</TableHead>
                  <TableHead>Command</TableHead>
                  <TableHead>Score</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {new Date(log.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge className={getLevelBadge(log.level)}>
                        {log.level}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={getDecisionBadge(log.decision)}>
                        {log.decision.replace('_', ' ')}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-md truncate font-mono text-xs">
                      {log.command}
                    </TableCell>
                    <TableCell className="text-right">
                      {log.score !== null ? log.score.toFixed(2) : '-'}
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                      {log.reason || '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
