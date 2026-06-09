'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  CheckCircle2,
  Copy,
  Cpu,
  HardDrive,
  Info,
  Loader2,
  RefreshCw,
  Server,
  ShieldCheck,
  WifiOff,
  XCircle,
} from 'lucide-react';
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
import type { AgentdConfig } from '@/types/config/agentd';

interface HealthResponse {
  success: boolean;
  data: {
    daemon:
      | {
          status: 'online';
          uptime?: string;
          version?: string;
        }
      | {
          status: 'offline';
        };
    timestamp: string;
  };
}

interface NodeStatusItem {
  node_id: string;
  ip: string;
  port: number;
  sandboxes: string[];
  version: string;
  status: 'online' | 'offline';
  cpu_usage: number | null;
  mem_avail: number | null;
  disk_avail: number | null;
  active_tasks: number;
  active_sandboxes: number;
  last_heartbeat: string | null;
  registered_at: string | null;
}

async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/agentd/v1/health');
  if (!response.ok) {
    throw new Error('Failed to fetch agentd health');
  }
  return response.json();
}

async function fetchNodeStatuses(): Promise<NodeStatusItem[]> {
  const response = await fetch('/api/agentd/v1/nodes/status');
  if (!response.ok) {
    throw new Error('Failed to fetch agentd nodes');
  }
  const body = (await response.json()) as { nodes?: NodeStatusItem[] };
  return body.nodes ?? [];
}

const agentdTomlSnippet = `[server]
listen = ":18732"
tls_cert_path = "./certs/server-cert.pem"
tls_key_path = "./certs/server-key.pem"
ca_path = "./certs/ca-cert.pem"
clawless_api_key = "same-value-as-AGENTD_API_KEY"

[clawless]
base_url = "https://your-agentboster.vercel.app"
client_cert_path = "./certs/client-cert.pem"
client_key_path = "./certs/client-key.pem"
ca_path = "./certs/ca-cert.pem"
heartbeat_interval = "30s"

[security]
l1_provider = "web"
l1_endpoint = ""
l1_model = ""

[sandbox]
default = "docker"
docker_socket = "unix:///var/run/docker.sock"
docker_image = "alpine:edge"
docker_default_cpu = 0.25
docker_default_memory = "256m"
docker_strict_cpu = 1.0
docker_strict_memory = "512m"
lxc_default_distro = "alpine"
lxc_default_release = "3.21"
lxc_rootfs_base = "/var/lib/agentd/lxc"
os_enforce = true
network_isolate = true`;

function formatPercent(value: number | null) {
  return value == null ? 'N/A' : `${(value * 100).toFixed(0)}%`;
}

function formatHeartbeat(value: string | null) {
  if (!value) {
    return 'never';
  }

  const diffSeconds = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 1000),
  );

  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  const diffMinutes = Math.round(diffSeconds / 60);
  return `${diffMinutes}m ago`;
}

export function AgentDConfigPage() {
  const { draft, updateSection } = useConfigContext();
  const agentdConfig = (draft.agentd ?? {}) as Partial<AgentdConfig>;
  const agentdEnabled = agentdConfig.enabled ?? false;
  const agentdUrl = agentdConfig.url ?? '';

  function updateAgentdConfig(patch: Partial<AgentdConfig>) {
    updateSection('agentd', (current) => ({
      enabled: current?.enabled ?? false,
      follow_up_enabled: current?.follow_up_enabled ?? false,
      ...current,
      ...patch,
    }));
  }

  const {
    data: health,
    isFetching: healthFetching,
    refetch: refetchHealth,
  } = useQuery({
    queryKey: ['agentd-health'],
    queryFn: fetchHealth,
    refetchInterval: 10_000,
  });

  const {
    data: nodes,
    isFetching: nodesFetching,
    refetch: refetchNodes,
  } = useQuery({
    queryKey: ['agentd-nodes'],
    queryFn: fetchNodeStatuses,
    refetchInterval: 15_000,
  });

  const daemon = health?.data.daemon;
  const directOnline = daemon?.status === 'online';
  const onlineNodes = nodes?.filter((node) => node.status === 'online') ?? [];

  async function copySnippet() {
    await navigator.clipboard.writeText(agentdTomlSnippet);
    toast.success('agentd.toml snippet copied');
  }

  return (
    <div className="space-y-6">
      <Card className="shadow-none">
        <CardHeader>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="size-4" />
                Agent Daemon
              </CardTitle>
              <CardDescription>
                Enable daemon execution and monitor registered Linux sandbox
                workers. Daemon runtime settings live in agentd.toml on the
                server.
              </CardDescription>
            </div>
            <label
              htmlFor="agentd-enabled"
              className="flex items-center gap-2 rounded-md border px-3 py-2"
            >
              <Checkbox
                id="agentd-enabled"
                checked={agentdEnabled}
                onCheckedChange={(checked) =>
                  updateAgentdConfig({ enabled: Boolean(checked) })
                }
              />
              <span className="text-sm">
                {agentdEnabled ? 'Enabled' : 'Disabled'}
              </span>
            </label>
          </div>
        </CardHeader>
        {agentdEnabled ? (
          <CardContent className="border-t pt-5">
            <div className="grid gap-2">
              <Label htmlFor="agentd-url">Daemon URL</Label>
              <Input
                id="agentd-url"
                type="url"
                inputMode="url"
                placeholder="https://agentd.example.com"
                value={agentdUrl}
                onChange={(event) =>
                  updateAgentdConfig({ url: event.target.value })
                }
              />
              <p className="text-muted-foreground text-xs">
                Used by Web server direct checks and daemon API calls. If left
                empty, AGENTD_URL from the environment is used.
              </p>
            </div>
          </CardContent>
        ) : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <StatusCard
          description="Web server direct health check via saved URL or AGENTD_URL."
          icon={directOnline ? CheckCircle2 : WifiOff}
          title="Direct daemon"
          value={directOnline ? 'Online' : 'Offline'}
          variant={directOnline ? 'online' : 'offline'}
        />
        <StatusCard
          description="Nodes that have registered and sent recent heartbeats."
          icon={onlineNodes.length > 0 ? Server : XCircle}
          title="Registered nodes"
          value={`${onlineNodes.length}/${nodes?.length ?? 0}`}
          variant={onlineNodes.length > 0 ? 'online' : 'neutral'}
        />
        <StatusCard
          description="Execution is controlled by the saved Web config."
          icon={agentdEnabled ? Activity : Info}
          title="Web execution"
          value={agentdEnabled ? 'Enabled' : 'Disabled'}
          variant={agentdEnabled ? 'online' : 'neutral'}
        />
      </div>

      <Card className="shadow-none">
        <CardHeader>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle className="text-base">Cluster Nodes</CardTitle>
              <CardDescription>
                These rows come from daemon registration and heartbeat callbacks
                into AgentBoster Web.
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={nodesFetching}
              onClick={() => void refetchNodes()}
            >
              {nodesFetching ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {!nodes || nodes.length === 0 ? (
            <div className="rounded-md border border-dashed p-8 text-center text-muted-foreground text-sm">
              No nodes registered yet. Start agentd with a valid base_url and
              clawless_api_key.
            </div>
          ) : (
            <div className="space-y-3">
              {nodes.map((node) => (
                <div key={node.node_id} className="rounded-md border p-3">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant={
                            node.status === 'online' ? 'default' : 'destructive'
                          }
                        >
                          {node.status}
                        </Badge>
                        <span className="break-all font-mono text-sm">
                          {node.node_id}
                        </span>
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {node.ip}:{node.port} · v{node.version} · heartbeat{' '}
                        {formatHeartbeat(node.last_heartbeat)}
                      </div>
                    </div>
                    <div className="grid gap-2 text-xs sm:grid-cols-5 md:min-w-[520px]">
                      <Metric
                        icon={Cpu}
                        label="CPU"
                        value={formatPercent(node.cpu_usage)}
                      />
                      <Metric
                        icon={Activity}
                        label="Mem"
                        value={formatPercent(node.mem_avail)}
                      />
                      <Metric
                        icon={HardDrive}
                        label="Disk"
                        value={formatPercent(node.disk_avail)}
                      />
                      <Metric label="Tasks" value={String(node.active_tasks)} />
                      <Metric
                        label="Sandboxes"
                        value={String(node.active_sandboxes)}
                      />
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {node.sandboxes.map((sandbox) => (
                      <Badge key={sandbox} variant="outline">
                        {sandbox}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle className="text-base">Web Direct Connection</CardTitle>
              <CardDescription>
                Optional server-to-daemon calls use AGENTD_URL, AGENTD_API_KEY,
                AGENTD_CLIENT_CERT_PATH, AGENTD_CLIENT_KEY_PATH, and
                AGENTD_CA_PATH.
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={healthFetching}
              onClick={() => void refetchHealth()}
            >
              {healthFetching ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Check
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <Detail label="Status" value={daemon?.status ?? 'unknown'} />
          <Detail
            label="Version"
            value={daemon?.status === 'online' ? daemon.version || '-' : '-'}
          />
          <Detail
            label="Uptime"
            value={daemon?.status === 'online' ? daemon.uptime || '-' : '-'}
          />
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle className="text-base">agentd.toml Baseline</CardTitle>
              <CardDescription>
                Edit this on the daemon server. The old WebUI direct-save API no
                longer exists in current agentd.
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void copySnippet()}
            >
              <Copy className="size-4" />
              Copy
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <pre className="max-h-[420px] overflow-auto rounded-md bg-muted p-4 text-xs">
            {agentdTomlSnippet}
          </pre>
          <p className="mt-3 text-muted-foreground text-xs">
            Generate certificates on the daemon host with{' '}
            <code className="rounded bg-muted px-1">
              agentd -gen-certs ./certs
            </code>
            , then set matching AGENTD_* environment variables on Vercel if Web
            needs to call daemon endpoints directly.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusCard({
  description,
  icon: Icon,
  title,
  value,
  variant,
}: {
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  value: string;
  variant: 'neutral' | 'offline' | 'online';
}) {
  const tone =
    variant === 'online'
      ? 'text-emerald-600'
      : variant === 'offline'
        ? 'text-red-600'
        : 'text-muted-foreground';

  return (
    <Card className="shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className={`size-4 ${tone}`} />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="font-semibold text-2xl">{value}</div>
        <p className="mt-1 text-muted-foreground text-xs">{description}</p>
      </CardContent>
    </Card>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md bg-muted px-3 py-2">
      <div className="flex items-center gap-1 text-muted-foreground">
        {Icon ? <Icon className="size-3" /> : null}
        <span>{label}</span>
      </div>
      <div className="mt-1 font-medium">{value}</div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1 rounded-md border p-3">
      <Label className="text-muted-foreground text-xs">{label}</Label>
      <div className="break-all font-mono text-sm">{value}</div>
    </div>
  );
}
