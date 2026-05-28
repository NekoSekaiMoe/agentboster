'use client';

import {
  Activity,
  CheckCircle2,
  Cpu,
  FolderTree,
  HardDrive,
  Key,
  Power,
  RefreshCw,
  Server,
  Shield,
  XCircle,
  Zap,
} from 'lucide-react';
import { ofetch } from 'ofetch';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useConfigContext } from '@/components/config/config-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';

interface AgentDStatus {
  status: string;
  version: string;
  uptime: string;
  timestamp: string;
}

interface AgentDConfig {
  server: {
    listen: string;
    tls_cert_path: string;
    tls_key_path: string;
    ca_path: string;
    clawless_api_key: string;
  };
  clawless: {
    base_url: string;
    client_cert_path: string;
    client_key_path: string;
    ca_path: string;
  };
  sandbox: {
    default: string;
    chroot_base: string;
    tmpfs_size: string;
    docker_socket: string;
  };
  session: {
    max_count: number;
    timeout: string;
    store_path: string;
  };
}

interface NodeStatusItem {
  node_id: string;
  ip: string;
  port: number;
  sandboxes: string[];
  version: string;
  status: string;
  cpu_usage: number | null;
  mem_avail: number | null;
  disk_avail: number | null;
  active_tasks: number;
  active_sandboxes: number;
  last_heartbeat: string | null;
  registered_at: string | null;
}

const defaultConfig: AgentDConfig = {
  server: {
    listen: ':18732',
    tls_cert_path: './certs/server-cert.pem',
    tls_key_path: './certs/server-key.pem',
    ca_path: './certs/ca-cert.pem',
    clawless_api_key: '',
  },
  clawless: {
    base_url: 'http://localhost:3000',
    client_cert_path: './certs/client-cert.pem',
    client_key_path: './certs/client-key.pem',
    ca_path: './certs/ca-cert.pem',
  },
  sandbox: {
    default: 'tmpfs',
    chroot_base: '/var/lib/agentd/chroots',
    tmpfs_size: '512m',
    docker_socket: 'unix:///var/run/docker.sock',
  },
  session: {
    max_count: 50,
    timeout: '30m',
    store_path: '/tmp/agentd/sessions',
  },
};

export function AgentDConfigPage() {
  const { draft, updateSection } = useConfigContext();
  const agentdEnabled = draft.agentd?.enabled ?? false;

  const [status, setStatus] = useState<AgentDStatus | null>(null);
  const [config, setConfig] = useState<AgentDConfig>(defaultConfig);
  const [loading, setLoading] = useState(false);
  const [daemonAddress, setDaemonAddress] = useState('https://127.0.0.1:18732');

  const checkStatus = useCallback(async () => {
    try {
      setLoading(true);
      const res = await ofetch<AgentDStatus>(`${daemonAddress}/health`, {
        timeout: 5000,
      });
      setStatus(res);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [daemonAddress]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const handleSave = useCallback(async () => {
    try {
      await ofetch(`${daemonAddress}/api/v1/agentd/config`, {
        method: 'PUT',
        body: config,
      });
      toast.success('Configuration saved');
    } catch {
      toast.error('Failed to save configuration');
    }
  }, [config, daemonAddress]);

  const [nodeStatuses, setNodeStatuses] = useState<NodeStatusItem[]>([]);

  const fetchNodeStatuses = useCallback(async () => {
    try {
      const res = await ofetch<{ nodes: NodeStatusItem[] }>(
        '/api/agentd/v1/nodes/status',
        { timeout: 10000 },
      );
      setNodeStatuses(res.nodes || []);
    } catch {
      setNodeStatuses([]);
    }
  }, []);

  useEffect(() => {
    fetchNodeStatuses();
    const interval = setInterval(fetchNodeStatuses, 30000);
    return () => clearInterval(interval);
  }, [fetchNodeStatuses]);

  const handleRegenerateCerts = useCallback(async () => {
    try {
      await ofetch(`${daemonAddress}/api/v1/agentd/certs`, { method: 'POST' });
      toast.success('Certificates regenerated');
    } catch {
      toast.error('Failed to regenerate certificates');
    }
  }, [daemonAddress]);

  const isOnline = status?.status === 'ok';

  return (
    <div className="space-y-6">
      {/* Enable/Disable Toggle */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Power className="h-5 w-5" />
              <CardTitle>Agent Daemon</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="agentd-enabled" className="text-sm">
                {agentdEnabled ? 'Enabled' : 'Disabled'}
              </Label>
              <Checkbox
                id="agentd-enabled"
                checked={agentdEnabled}
                onCheckedChange={(checked) => {
                  updateSection('agentd', { enabled: Boolean(checked) });
                }}
              />
            </div>
          </div>
          <CardDescription>
            Enable the Agent Daemon to run sandboxed tasks on remote servers.
            When disabled, all agent polling is stopped.
          </CardDescription>
        </CardHeader>
      </Card>

      {agentdEnabled && (
        <>
      {/* Connection Status */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              <CardTitle>Connection</CardTitle>
            </div>
            <Badge
              variant={isOnline ? 'default' : 'destructive'}
              className="gap-1"
            >
              {isOnline ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : (
                <XCircle className="h-3 w-3" />
              )}
              {isOnline ? 'Online' : 'Offline'}
            </Badge>
          </div>
          <CardDescription>
            Agent Daemon remote server status and connection settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <div className="flex-1">
              <Label htmlFor="daemon-address">Daemon Address</Label>
              <Input
                id="daemon-address"
                value={daemonAddress}
                onChange={(e) => setDaemonAddress(e.target.value)}
                placeholder="https://127.0.0.1:18732"
              />
            </div>
            <Button
              variant="outline"
              className="mt-6"
              onClick={checkStatus}
              disabled={loading}
            >
              <RefreshCw
                className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`}
              />
              Check
            </Button>
          </div>
          {isOnline && status && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Version:</span>
                <span className="font-mono">{status.version}</span>
              </div>
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Uptime:</span>
                <span className="font-mono">{status.uptime}</span>
              </div>
              <div className="flex items-center gap-2 col-span-2">
                <HardDrive className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Last Check:</span>
                <span className="font-mono text-xs">{status.timestamp}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Node Status Panel */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              <CardTitle>Cluster Nodes</CardTitle>
            </div>
            <Button variant="ghost" size="sm" onClick={fetchNodeStatuses}>
              <RefreshCw className="h-4 w-4 mr-1" />
              Refresh
            </Button>
          </div>
          <CardDescription>
            Agent Daemon nodes registered in this cluster. Tasks are
            automatically scheduled to the optimal node.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {nodeStatuses.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No nodes registered yet. Start an Agent Daemon to register a node.
            </p>
          ) : (
            <div className="space-y-3">
              {nodeStatuses.map((node) => {
                const isOnline = node.status === 'online';
                return (
                  <div
                    key={node.node_id}
                    className="rounded-lg border p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={isOnline ? 'default' : 'destructive'}
                          className="gap-1 text-xs"
                        >
                          {isOnline ? (
                            <CheckCircle2 className="h-3 w-3" />
                          ) : (
                            <XCircle className="h-3 w-3" />
                          )}
                          {isOnline ? 'Online' : 'Offline'}
                        </Badge>
                        <span className="text-sm font-mono font-medium">
                          {node.node_id}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {node.ip}:{node.port}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div className="flex items-center gap-1">
                        <Cpu className="h-3 w-3 text-muted-foreground" />
                        <span>CPU:</span>
                        <span className="font-medium">
                          {node.cpu_usage != null
                            ? `${(node.cpu_usage * 100).toFixed(0)}%`
                            : 'N/A'}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Activity className="h-3 w-3 text-muted-foreground" />
                        <span>Mem:</span>
                        <span className="font-medium">
                          {node.mem_avail != null
                            ? `${(node.mem_avail * 100).toFixed(0)}%`
                            : 'N/A'}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <HardDrive className="h-3 w-3 text-muted-foreground" />
                        <span>Disk:</span>
                        <span className="font-medium">
                          {node.disk_avail != null
                            ? `${(node.disk_avail * 100).toFixed(0)}%`
                            : 'N/A'}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <div className="flex gap-2">
                        {node.sandboxes.map((s) => (
                          <Badge key={s} variant="outline" className="text-xs">
                            {s}
                          </Badge>
                        ))}
                      </div>
                      <span>
                        {node.active_tasks} tasks ·{' '}
                        {node.last_heartbeat
                          ? `${Math.round((Date.now() - new Date(node.last_heartbeat).getTime()) / 1000)}s ago`
                          : 'never'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* mTLS Certificates */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            <CardTitle>mTLS Certificates</CardTitle>
          </div>
          <CardDescription>
            Mutual TLS certificates for secure ClawLess ↔ Daemon communication.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>CA Certificate Path</Label>
              <Input
                value={config.server.ca_path}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    server: { ...c.server, ca_path: e.target.value },
                  }))
                }
              />
            </div>
            <div>
              <Label>Server Certificate Path</Label>
              <Input
                value={config.server.tls_cert_path}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    server: { ...c.server, tls_cert_path: e.target.value },
                  }))
                }
              />
            </div>
            <div>
              <Label>Server Key Path</Label>
              <Input
                value={config.server.tls_key_path}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    server: { ...c.server, tls_key_path: e.target.value },
                  }))
                }
              />
            </div>
            <div>
              <Label>ClawLess API Key</Label>
              <Input
                type="password"
                value={config.server.clawless_api_key}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    server: { ...c.server, clawless_api_key: e.target.value },
                  }))
                }
                placeholder="sk-clawless-xxx"
              />
            </div>
          </div>
          <Separator />
          <div className="flex justify-between items-center">
            <p className="text-sm text-muted-foreground">
              Use{' '}
              <code className="bg-muted px-1 rounded">agentd -gen-certs</code>{' '}
              to generate certificates on the daemon server.
            </p>
            <Button variant="outline" size="sm" onClick={handleRegenerateCerts}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Regenerate
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ClawLess Connection */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            <CardTitle>ClawLess Connection</CardTitle>
          </div>
          <CardDescription>
            How the Daemon connects back to ClawLess.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>ClawLess Base URL</Label>
            <Input
              value={config.clawless.base_url}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  clawless: { ...c.clawless, base_url: e.target.value },
                }))
              }
              placeholder="https://your-clawless.vercel.app"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>Client Certificate Path</Label>
              <Input
                value={config.clawless.client_cert_path}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    clawless: {
                      ...c.clawless,
                      client_cert_path: e.target.value,
                    },
                  }))
                }
              />
            </div>
            <div>
              <Label>Client Key Path</Label>
              <Input
                value={config.clawless.client_key_path}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    clawless: {
                      ...c.clawless,
                      client_key_path: e.target.value,
                    },
                  }))
                }
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Sandbox Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <FolderTree className="h-5 w-5" />
            <CardTitle>Sandbox Settings</CardTitle>
          </div>
          <CardDescription>
            Configure sandbox providers and default selection.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>Default Sandbox</Label>
              <div className="flex gap-2 mt-1">
                {['tmpfs', 'chroot', 'docker'].map((type) => (
                  <Button
                    key={type}
                    variant={
                      config.sandbox.default === type ? 'default' : 'outline'
                    }
                    size="sm"
                    onClick={() =>
                      setConfig((c) => ({
                        ...c,
                        sandbox: { ...c.sandbox, default: type },
                      }))
                    }
                  >
                    {type}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                tmpfs: lightweight (default) · chroot: persistent · docker:
                high-risk isolation
              </p>
            </div>
            <div>
              <Label>Tmpfs Size</Label>
              <Input
                value={config.sandbox.tmpfs_size}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    sandbox: { ...c.sandbox, tmpfs_size: e.target.value },
                  }))
                }
                placeholder="512m"
              />
            </div>
            <div>
              <Label>Chroot Base Directory</Label>
              <Input
                value={config.sandbox.chroot_base}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    sandbox: { ...c.sandbox, chroot_base: e.target.value },
                  }))
                }
                placeholder="/var/lib/agentd/chroots"
              />
            </div>
            <div>
              <Label>Docker Socket</Label>
              <Input
                value={config.sandbox.docker_socket}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    sandbox: { ...c.sandbox, docker_socket: e.target.value },
                  }))
                }
                placeholder="unix:///var/run/docker.sock"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Session Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            <CardTitle>Session Settings</CardTitle>
          </div>
          <CardDescription>
            Configure session lifecycle, TTL isolation, and L2 authorization
            cache.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label>Max Session Count</Label>
              <Input
                type="number"
                min={1}
                max={200}
                value={config.session.max_count}
                onChange={(e) => {
                  const parsed = Number.parseInt(e.target.value, 10);
                  setConfig((c) => ({
                    ...c,
                    session: {
                      ...c.session,
                      max_count: Number.isNaN(parsed) ? 50 : parsed,
                    },
                  }));
                }}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Max sessions to retain (default: 50). Oldest archived when
                exceeded.
              </p>
            </div>
            <div>
              <Label>Session Timeout</Label>
              <Input
                value={config.session.timeout}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    session: { ...c.session, timeout: e.target.value },
                  }))
                }
                placeholder="30m"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Idle timeout (e.g. 30m, 1h). Expired sessions auto-cleaned.
              </p>
            </div>
            <div>
              <Label>Session Store Path</Label>
              <Input
                value={config.session.store_path}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    session: { ...c.session, store_path: e.target.value },
                  }))
                }
                placeholder="/tmp/agentd/sessions"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Directory for session persistence on disk.
              </p>
            </div>
          </div>
          <div className="text-xs text-muted-foreground bg-muted/50 rounded-md p-3 space-y-1">
            <p>
              <strong>Session Isolation:</strong> Each session has independent
              L2 authorization cache. Session A's "always" authorization does
              not affect Session B.
            </p>
            <p>
              <strong>TTL Expiry:</strong> CleanupWorker scans every 30s.
              Expired L2 authorizations are logged to review_logs.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => setConfig(defaultConfig)}>
          Reset
        </Button>
        <Button onClick={handleSave}>Save Configuration</Button>
      </div>
        </>
      )}
    </div>
  );
}
