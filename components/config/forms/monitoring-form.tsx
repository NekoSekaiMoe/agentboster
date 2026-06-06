'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Box,
  CheckCircle2,
  CircleAlert,
  Cpu,
  HardDrive,
  Server,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface DaemonMetrics {
  activeSandboxes: number;
  activeTasks: number;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
}

interface DaemonNode {
  id: string;
  hostname: string;
  status: 'online' | 'offline';
  lastHeartbeat: string;
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
}

async function fetchMetrics(): Promise<DaemonMetrics> {
  const res = await fetch('/api/config/monitoring/metrics');
  if (!res.ok) throw new Error('Failed to fetch metrics');
  return res.json();
}

async function fetchNodes(): Promise<DaemonNode[]> {
  const res = await fetch('/api/config/monitoring/nodes');
  if (!res.ok) throw new Error('Failed to fetch nodes');
  return res.json();
}

export function MonitoringForm() {
  const { data: metrics, isLoading: metricsLoading } = useQuery({
    queryKey: ['monitoring', 'metrics'],
    queryFn: fetchMetrics,
    refetchInterval: 5000,
  });

  const { data: nodes, isLoading: nodesLoading } = useQuery({
    queryKey: ['monitoring', 'nodes'],
    queryFn: fetchNodes,
    refetchInterval: 10000,
  });

  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (metricsLoading || nodesLoading) {
    return (
      <div className="rounded-3xl border bg-card p-8 shadow-sm">
        <div className="flex items-center justify-center text-muted-foreground">
          Loading dashboard data...
        </div>
      </div>
    );
  }

  const onlineNodes =
    nodes?.filter((node) => node.status === 'online').length ?? 0;
  const totalNodes = nodes?.length ?? 0;
  const successRate =
    metrics && metrics.totalTasks > 0
      ? `${((metrics.completedTasks / metrics.totalTasks) * 100).toFixed(1)}%`
      : '0%';

  return (
    <div className="space-y-5">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="rounded-3xl border-border/70 shadow-sm">
          <CardHeader className="pb-4">
            <CardTitle className="font-semibold text-xl">
              AgentBoster WebUI
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              {[
                {
                  label: 'Models',
                  value: 'Provider endpoints',
                },
                {
                  label: 'AgentD',
                  value: `${onlineNodes}/${totalNodes} nodes online`,
                },
                {
                  label: 'Security',
                  value: 'Rules and authorization',
                },
              ].map((item, index) => (
                <div
                  key={item.label}
                  className="rounded-2xl border bg-background px-4 py-3"
                >
                  <div className="mb-2 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs">
                    {index + 1}
                  </div>
                  <div className="font-medium text-sm">{item.label}</div>
                  <div className="mt-1 text-muted-foreground text-xs">
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-3xl border-border/70 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="font-medium text-sm">
              Runtime Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600">
                {onlineNodes > 0 ? (
                  <CheckCircle2 className="size-5" />
                ) : (
                  <CircleAlert className="size-5" />
                )}
              </div>
              <div>
                <div className="font-semibold">
                  {onlineNodes}/{totalNodes} nodes online
                </div>
                <div className="text-muted-foreground text-xs">
                  Updated {currentTime.toLocaleTimeString()}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-2xl bg-muted px-3 py-2">
                <div className="text-muted-foreground text-xs">
                  Active tasks
                </div>
                <div className="font-semibold">{metrics?.activeTasks ?? 0}</div>
              </div>
              <div className="rounded-2xl bg-muted px-3 py-2">
                <div className="text-muted-foreground text-xs">Sandboxes</div>
                <div className="font-semibold">
                  {metrics?.activeSandboxes ?? 0}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="rounded-2xl border-border/70 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">
              Active Sandboxes
            </CardTitle>
            <Box className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">
              {metrics?.activeSandboxes ?? 0}
            </div>
            <p className="text-muted-foreground text-xs">Currently running</p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-border/70 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">Active Tasks</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">
              {metrics?.activeTasks ?? 0}
            </div>
            <p className="text-muted-foreground text-xs">In progress</p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-border/70 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">Total Tasks</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">{metrics?.totalTasks ?? 0}</div>
            <p className="text-muted-foreground text-xs">All time</p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-border/70 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">Success Rate</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">{successRate}</div>
            <p className="text-muted-foreground text-xs">
              {metrics?.completedTasks ?? 0} completed,{' '}
              {metrics?.failedTasks ?? 0} failed
            </p>
          </CardContent>
        </Card>
      </div>

      <section className="space-y-3">
        <h3 className="font-semibold text-lg">Daemon Nodes</h3>
        {!nodes || nodes.length === 0 ? (
          <Card className="rounded-2xl border-border/70 shadow-sm">
            <CardContent className="flex items-center justify-center p-8 text-muted-foreground">
              No daemon nodes registered
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {nodes.map((node) => (
              <Card
                key={node.id}
                className="rounded-2xl border-border/70 shadow-sm"
              >
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="font-medium text-sm">
                    {node.hostname}
                  </CardTitle>
                  <Badge
                    variant={
                      node.status === 'online' ? 'default' : 'destructive'
                    }
                    className="gap-1"
                  >
                    {node.status === 'online' ? (
                      <Wifi className="h-3 w-3" />
                    ) : (
                      <WifiOff className="h-3 w-3" />
                    )}
                    {node.status}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex items-center gap-2 text-xs">
                    <Cpu className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">CPU:</span>
                    <span className="font-medium">
                      {node.cpuUsage != null
                        ? `${node.cpuUsage.toFixed(1)}%`
                        : '—'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <HardDrive className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">Memory:</span>
                    <span className="font-medium">
                      {node.memoryUsage != null
                        ? `${node.memoryUsage.toFixed(1)}%`
                        : '—'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <HardDrive className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">Disk:</span>
                    <span className="font-medium">
                      {node.diskUsage != null
                        ? `${node.diskUsage.toFixed(1)}%`
                        : '—'}
                    </span>
                  </div>
                  <div className="border-t pt-2 text-muted-foreground text-xs">
                    Last heartbeat:{' '}
                    {node.lastHeartbeat
                      ? new Date(node.lastHeartbeat).toLocaleTimeString()
                      : '—'}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
