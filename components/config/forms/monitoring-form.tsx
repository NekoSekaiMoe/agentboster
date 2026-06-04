'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Box,
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
      <div className="flex items-center justify-center p-8">
        <div className="text-muted-foreground">Loading monitoring data...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className='font-bold text-2xl tracking-tight'>Monitoring</h2>
        <p className="text-muted-foreground">
          Real-time status of Agent Daemon and sandbox resources.
        </p>
        <p className='mt-1 text-muted-foreground text-xs'>
          Last updated: {currentTime.toLocaleTimeString()}
        </p>
      </div>

      {/* Metrics Overview */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className='font-medium text-sm'>
              Active Sandboxes
            </CardTitle>
            <Box className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className='font-bold text-2xl'>
              {metrics?.activeSandboxes ?? 0}
            </div>
            <p className='text-muted-foreground text-xs'>Currently running</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className='font-medium text-sm'>Active Tasks</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className='font-bold text-2xl'>
              {metrics?.activeTasks ?? 0}
            </div>
            <p className='text-muted-foreground text-xs'>In progress</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className='font-medium text-sm'>Total Tasks</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className='font-bold text-2xl'>{metrics?.totalTasks ?? 0}</div>
            <p className='text-muted-foreground text-xs'>All time</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className='font-medium text-sm'>Success Rate</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className='font-bold text-2xl'>
              {metrics && metrics.totalTasks > 0
                ? `${((metrics.completedTasks / metrics.totalTasks) * 100).toFixed(1)}%`
                : '0%'}
            </div>
            <p className='text-muted-foreground text-xs'>
              {metrics?.completedTasks ?? 0} completed,{' '}
              {metrics?.failedTasks ?? 0} failed
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Node Status */}
      <div>
        <h3 className='mb-4 font-semibold text-lg'>Daemon Nodes</h3>
        {!nodes || nodes.length === 0 ? (
          <Card>
            <CardContent className="flex items-center justify-center p-8 text-muted-foreground">
              No daemon nodes registered
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {nodes.map((node) => (
              <Card key={node.id}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className='font-medium text-sm'>
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
                  <div className='border-t pt-2 text-muted-foreground text-xs'>
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
      </div>
    </div>
  );
}
