'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Clock, History, Shield, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface PendingAuthorization {
  id: string;
  sessionId: string;
  taskId: string;
  command: string;
  reason: string;
  requestedAt: string;
  timeoutAt: string;
}

interface AuthorizationHistory {
  id: string;
  sessionId: string;
  taskId: string;
  command: string;
  decision: 'approved' | 'rejected' | 'expired';
  decidedAt: string;
  decidedBy: string;
}

async function fetchPendingAuthorizations(): Promise<PendingAuthorization[]> {
  const res = await fetch('/api/l2-authorizations/pending');
  if (!res.ok) throw new Error('Failed to fetch pending authorizations');
  return res.json();
}

async function fetchAuthorizationHistory(): Promise<AuthorizationHistory[]> {
  const res = await fetch('/api/l2-authorizations/history');
  if (!res.ok) throw new Error('Failed to fetch authorization history');
  return res.json();
}

async function batchApprove(sessionIds: string[]): Promise<void> {
  const res = await fetch('/api/l2-authorizations/batch-approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionIds }),
  });
  if (!res.ok) throw new Error('Failed to approve authorizations');
}

async function batchReject(sessionIds: string[]): Promise<void> {
  const res = await fetch('/api/l2-authorizations/batch-reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionIds }),
  });
  if (!res.ok) throw new Error('Failed to reject authorizations');
}

export function L2AuthorizationsPage() {
  const queryClient = useQueryClient();
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);

  const { data: pending, isLoading: pendingLoading } = useQuery({
    queryKey: ['l2-authorizations', 'pending'],
    queryFn: fetchPendingAuthorizations,
    refetchInterval: 5000,
  });

  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ['l2-authorizations', 'history'],
    queryFn: fetchAuthorizationHistory,
  });

  const approveMutation = useMutation({
    mutationFn: batchApprove,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['l2-authorizations'] });
      setSelectedSessions(new Set());
      setApproveDialogOpen(false);
      toast.success('Authorizations approved');
    },
    onError: () => {
      toast.error('Failed to approve authorizations');
    },
  });

  const rejectMutation = useMutation({
    mutationFn: batchReject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['l2-authorizations'] });
      setSelectedSessions(new Set());
      setRejectDialogOpen(false);
      toast.success('Authorizations rejected');
    },
    onError: () => {
      toast.error('Failed to reject authorizations');
    },
  });

  const toggleSession = (sessionId: string) => {
    const newSelected = new Set(selectedSessions);
    if (newSelected.has(sessionId)) {
      newSelected.delete(sessionId);
    } else {
      newSelected.add(sessionId);
    }
    setSelectedSessions(newSelected);
  };

  const toggleAll = () => {
    if (!pending) return;
    if (selectedSessions.size === pending.length) {
      setSelectedSessions(new Set());
    } else {
      setSelectedSessions(new Set(pending.map((p) => p.sessionId)));
    }
  };

  const handleApprove = () => {
    approveMutation.mutate(Array.from(selectedSessions));
  };

  const handleReject = () => {
    rejectMutation.mutate(Array.from(selectedSessions));
  };

  const getDecisionBadge = (decision: string) => {
    const colors = {
      approved: 'bg-green-100 text-green-800',
      rejected: 'bg-red-100 text-red-800',
      expired: 'bg-gray-100 text-gray-800',
    };
    return colors[decision as keyof typeof colors] || 'bg-gray-100 text-gray-800';
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">L2 Authorizations</h1>
        <p className="text-muted-foreground">
          Review and approve human-in-the-loop authorization requests.
        </p>
      </div>

      <Tabs defaultValue="pending">
        <TabsList>
          <TabsTrigger value="pending" className="gap-2">
            <Clock className="h-4 w-4" />
            Pending
            {pending && pending.length > 0 && (
              <Badge variant="secondary" className="ml-1">
                {pending.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-2">
            <History className="h-4 w-4" />
            History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pending" className="space-y-4">
          {/* Batch Actions */}
          {selectedSessions.size > 0 && (
            <Card>
              <CardContent className="flex items-center gap-4 pt-6">
                <span className="text-sm font-medium">
                  {selectedSessions.size} session(s) selected
                </span>
                <Button
                  onClick={() => setApproveDialogOpen(true)}
                  variant="default"
                  size="sm"
                  className="gap-2"
                >
                  <Check className="h-4 w-4" />
                  Approve All
                </Button>
                <Button
                  onClick={() => setRejectDialogOpen(true)}
                  variant="destructive"
                  size="sm"
                  className="gap-2"
                >
                  <X className="h-4 w-4" />
                  Reject All
                </Button>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-0">
              {pendingLoading ? (
                <div className="flex items-center justify-center p-8 text-muted-foreground">
                  Loading pending authorizations...
                </div>
              ) : !pending || pending.length === 0 ? (
                <div className="flex items-center justify-center p-8 text-muted-foreground">
                  No pending authorizations
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">
                        <Checkbox
                          checked={selectedSessions.size === pending.length}
                          onCheckedChange={toggleAll}
                        />
                      </TableHead>
                      <TableHead>Session ID</TableHead>
                      <TableHead>Command</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Requested</TableHead>
                      <TableHead>Timeout</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pending.map((auth) => (
                      <TableRow key={auth.id}>
                        <TableCell>
                          <Checkbox
                            checked={selectedSessions.has(auth.sessionId)}
                            onCheckedChange={() => toggleSession(auth.sessionId)}
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {auth.sessionId.slice(0, 8)}...
                        </TableCell>
                        <TableCell className="max-w-md truncate font-mono text-xs">
                          {auth.command}
                        </TableCell>
                        <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                          {auth.reason}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {new Date(auth.requestedAt).toLocaleString()}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {new Date(auth.timeoutAt).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history">
          <Card>
            <CardContent className="p-0">
              {historyLoading ? (
                <div className="flex items-center justify-center p-8 text-muted-foreground">
                  Loading authorization history...
                </div>
              ) : !history || history.length === 0 ? (
                <div className="flex items-center justify-center p-8 text-muted-foreground">
                  No authorization history
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Session ID</TableHead>
                      <TableHead>Command</TableHead>
                      <TableHead>Decision</TableHead>
                      <TableHead>Decided By</TableHead>
                      <TableHead>Decided At</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((auth) => (
                      <TableRow key={auth.id}>
                        <TableCell className="font-mono text-xs">
                          {auth.sessionId.slice(0, 8)}...
                        </TableCell>
                        <TableCell className="max-w-md truncate font-mono text-xs">
                          {auth.command}
                        </TableCell>
                        <TableCell>
                          <Badge className={getDecisionBadge(auth.decision)}>
                            {auth.decision}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">{auth.decidedBy}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {new Date(auth.decidedAt).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Approve Dialog */}
      <Dialog open={approveDialogOpen} onOpenChange={setApproveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve Authorizations</DialogTitle>
            <DialogDescription>
              Are you sure you want to approve {selectedSessions.size} authorization
              request(s)? This will allow the commands to execute.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setApproveDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleApprove}
              disabled={approveMutation.isPending}
            >
              {approveMutation.isPending ? 'Approving...' : 'Approve'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Authorizations</DialogTitle>
            <DialogDescription>
              Are you sure you want to reject {selectedSessions.size} authorization
              request(s)? This will block the commands from executing.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRejectDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={rejectMutation.isPending}
            >
              {rejectMutation.isPending ? 'Rejecting...' : 'Reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
