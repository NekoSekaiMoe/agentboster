'use client';

import {
  CheckCircle2,
  Hourglass,
  KeyRound,
  Loader2,
  MinusCircle,
  Plug,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/components/i18n-provider';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useConfigSection } from '@/hooks/use-config-section';
import type {
  MCPRemoteServerConfig,
  MCPRemoteServersConfig,
} from '@/types/config/mcp';

import { createStableId } from './models/models-dev';
import {
  EditableObjectKeyInput,
  Field,
  KeyValueEditor,
  SectionIssues,
  compactRecord,
  createKeyValueEntries,
} from './shared';

type AuthMode = 'none' | 'static-headers' | 'oauth';

type OAuthStatus = {
  connected: boolean;
  state: 'disconnected' | 'connected' | 'expired_refreshable' | 'expired';
  expiresAt?: number;
  scope?: string;
  hasRefreshToken?: boolean;
};

const builtinServers = [
  {
    name: 'web',
    description: 'Search the web and fetch URL content.',
    tools: 'web_search, fetch_url',
    requirements:
      'No required API key for basic fetch/search. Optional BRAVE_SEARCH_API_KEY or TAVILY_API_KEY improves fallback quality.',
  },
  {
    name: 'browser',
    description: 'Render and interact with pages using Playwright.',
    tools:
      'browser_navigate, browser_screenshot, browser_click, browser_type, browser_get_text, browser_get_html, browser_get_network_requests, browser_evaluate, browser_close',
    requirements:
      'Requires Playwright browser binaries in the runtime environment.',
  },
  {
    name: 'firecrawl',
    description: 'Scrape and extract web pages with Firecrawl.',
    tools: 'firecrawl_scrape',
    requirements: 'Requires FIRECRAWL_API_KEY.',
  },
  {
    name: 'github',
    description: 'Inspect repositories and manage GitHub issues/PRs.',
    tools:
      'github_get_repository, github_search_issues, github_create_issue, github_update_issue, github_create_pull_request',
    requirements:
      'GITHUB_TOKEN is optional for reads and required for mutations.',
  },
  {
    name: 'context7',
    description: 'Search project documentation through Context7.',
    tools: 'context7_search_docs',
    requirements: 'Uses context7.json bundled with this project.',
  },
];

function defaultAuth(): { mode: AuthMode } {
  return { mode: 'none' };
}

function readAuthMode(server: MCPRemoteServerConfig | undefined): AuthMode {
  return server?.auth?.mode ?? 'none';
}

function startOAuthFlow(serverName: string): Promise<{
  success: boolean;
  data?: { authorizeUrl: string };
  error?: string;
}> {
  return fetch('/api/config/mcp/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serverName, returnTo: '/config/mcp' }),
  }).then((r) => r.json());
}

function revokeOAuth(serverName: string): Promise<{
  success: boolean;
  error?: string;
}> {
  return fetch('/api/config/mcp/oauth/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serverName }),
  }).then((r) => r.json());
}

function testServer(serverName: string): Promise<{
  success: boolean;
  data?: { toolCount: number; sampleToolNames: string[] };
  error?: string;
}> {
  return fetch('/api/config/mcp/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serverName }),
  }).then((r) => r.json());
}

function StatusBadge({ status }: { status: OAuthStatus | undefined }) {
  const { t } = useI18n();
  if (!status || status.state === 'disconnected') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
        <MinusCircle className="size-3" />
        {t('config.forms.mcp.oauthStateDisconnected')}
      </span>
    );
  }
  if (status.state === 'connected') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-700 text-xs dark:text-emerald-400">
        <CheckCircle2 className="size-3" />
        {t('config.forms.mcp.oauthStateConnected')}
      </span>
    );
  }
  if (status.state === 'expired_refreshable') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-700 text-xs dark:text-amber-400">
        <Hourglass className="size-3" />
        {t('config.forms.mcp.oauthStateExpiredRefreshable')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-destructive text-xs">
      <XCircle className="size-3" />
      {t('config.forms.mcp.oauthStateExpired')}
    </span>
  );
}

/**
 * One OAuth-managed server row. Lives in its own component because the
 * OAuth status polling + mutation handlers all need to be scoped to a
 * single serverName, and putting them in the parent's render scope
 * would re-run every query for every row.
 */
function ServerRow(props: {
  serverKey: string;
  serverValue: MCPRemoteServerConfig;
  rowId: string;
  servers: MCPRemoteServersConfig;
  updateValue: (next: MCPRemoteServersConfig) => void;
  onRemove: (key: string) => void;
  onRename: (oldKey: string, newKey: string, rowId: string) => void;
}) {
  const {
    serverKey,
    serverValue,
    rowId,
    servers,
    updateValue,
    onRemove,
    onRename,
  } = props;
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const authMode = readAuthMode(serverValue);

  // Poll OAuth status only when this server is in OAuth mode. The query
  // is keyed by serverKey so rows don't clobber each other.
  const statusQuery = useQuery({
    queryKey: ['mcp-oauth-status', serverKey],
    queryFn: async (): Promise<OAuthStatus> => {
      const r = await fetch(
        `/api/config/mcp/oauth/status?serverName=${encodeURIComponent(serverKey)}`,
      );
      const json = await r.json();
      if (!json.success) throw new Error(json.error ?? 'failed');
      return json.data as OAuthStatus;
    },
    enabled: authMode === 'oauth',
    refetchInterval: 30_000,
  });

  const startMutation = useMutation({
    mutationFn: startOAuthFlow,
    onSuccess: (data) => {
      if (data.success && data.data?.authorizeUrl) {
        // Top-level navigation so the cookies we set land in the same
        // browser context. The provider's authorize page is on another
        // origin — window.location is the right primitive, not router.
        window.location.href = data.data.authorizeUrl;
      } else {
        toast.error(data.error ?? t('config.forms.mcp.oauthStartFailed'));
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'OAuth failed');
    },
  });

  const revokeMutation = useMutation({
    mutationFn: revokeOAuth,
    onSuccess: async (data) => {
      if (data.success) {
        toast.success(t('config.forms.mcp.oauthRevokeOk'));
        await queryClient.invalidateQueries({
          queryKey: ['mcp-oauth-status', serverKey],
        });
      } else {
        toast.error(data.error ?? t('config.forms.mcp.oauthRevokeFailed'));
      }
    },
  });

  const testMutation = useMutation({
    mutationFn: testServer,
    onSuccess: (data) => {
      if (data.success && data.data) {
        toast.success(
          t('config.forms.mcp.testOk', { count: data.data.toolCount }),
        );
      } else {
        toast.error(data.error ?? t('config.forms.mcp.testFailed'));
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Test failed');
    },
  });

  function patchServer(patch: Partial<MCPRemoteServerConfig>) {
    updateValue({
      ...servers,
      [serverKey]: { ...serverValue, ...patch },
    });
  }

  function patchAuth(
    patch: Partial<NonNullable<MCPRemoteServerConfig['auth']>>,
  ) {
    const current = serverValue.auth ?? defaultAuth();
    patchServer({ auth: { ...current, ...patch } });
  }

  function patchOAuth(
    patch: Partial<
      NonNullable<NonNullable<MCPRemoteServerConfig['auth']>['oauth']>
    >,
  ) {
    const current = serverValue.auth ?? defaultAuth();
    const oauth = current.oauth ?? {
      clientId: '',
      authorizeUrl: '',
      tokenUrl: '',
    };
    patchAuth({ oauth: { ...oauth, ...patch } });
  }

  return (
    <div className="rounded-2xl border p-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('config.forms.mcp.serverName')}>
          <EditableObjectKeyInput
            currentKey={serverKey}
            onCommit={(nextKey) => {
              if (nextKey === serverKey) return;
              onRename(serverKey, nextKey, rowId);
            }}
          />
        </Field>
        <Field label={t('config.forms.mcp.type')}>
          <Select
            value={serverValue.type}
            onValueChange={(nextValue) =>
              patchServer({
                type: nextValue as 'http' | 'sse',
              })
            }
          >
            <SelectTrigger>
              <SelectValue
                placeholder={t('config.forms.mcp.transportPlaceholder')}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="http">http</SelectItem>
              <SelectItem value="sse">sse</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('form.label.url')}>
          <Input
            placeholder="https://mcp.example.com"
            value={serverValue.url}
            onChange={(event) => patchServer({ url: event.target.value })}
          />
        </Field>
        <Field label={t('config.forms.mcp.authMode')}>
          <Select
            value={authMode}
            onValueChange={(next) => patchAuth({ mode: next as AuthMode })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                {t('config.forms.mcp.authModeNone')}
              </SelectItem>
              <SelectItem value="static-headers">
                {t('config.forms.mcp.authModeStaticHeaders')}
              </SelectItem>
              <SelectItem value="oauth">
                {t('config.forms.mcp.authModeOauth')}
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      {authMode === 'static-headers' && (
        <div className="mt-4">
          <Field label={t('config.common.headers')}>
            <KeyValueEditor
              addLabel={t('config.common.addHeader')}
              entries={createKeyValueEntries(serverValue.headers)}
              keyLabel={t('config.common.headerKey')}
              onChange={(entries) =>
                patchServer({ headers: compactRecord(entries) })
              }
              valueLabel={t('config.common.headerValue')}
            />
          </Field>
          <p className="mt-2 text-muted-foreground text-xs">
            {t('config.forms.mcp.staticHeadersHint')}
          </p>
        </div>
      )}

      {authMode === 'oauth' && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t('config.forms.mcp.oauthClientId')}>
              <Input
                placeholder="oauth-client-id"
                value={serverValue.auth?.oauth?.clientId ?? ''}
                onChange={(e) => patchOAuth({ clientId: e.target.value })}
              />
            </Field>
            <Field label={t('config.forms.mcp.oauthScope')}>
              <Input
                placeholder="repo issues"
                value={serverValue.auth?.oauth?.scope ?? ''}
                onChange={(e) =>
                  patchOAuth({ scope: e.target.value || undefined })
                }
              />
            </Field>
            <Field label={t('config.forms.mcp.oauthAuthorizeUrl')}>
              <Input
                placeholder="https://provider.com/oauth/authorize"
                value={serverValue.auth?.oauth?.authorizeUrl ?? ''}
                onChange={(e) => patchOAuth({ authorizeUrl: e.target.value })}
              />
            </Field>
            <Field label={t('config.forms.mcp.oauthTokenUrl')}>
              <Input
                placeholder="https://provider.com/oauth/token"
                value={serverValue.auth?.oauth?.tokenUrl ?? ''}
                onChange={(e) => patchOAuth({ tokenUrl: e.target.value })}
              />
            </Field>
            <Field label={t('config.forms.mcp.oauthRevokeUrl')}>
              <Input
                placeholder="https://provider.com/oauth/revoke (optional)"
                value={serverValue.auth?.oauth?.revokeUrl ?? ''}
                onChange={(e) =>
                  patchOAuth({ revokeUrl: e.target.value || undefined })
                }
              />
            </Field>
            <Field label={t('config.forms.mcp.oauthResource')}>
              <Input
                placeholder="optional"
                value={serverValue.auth?.oauth?.resource ?? ''}
                onChange={(e) =>
                  patchOAuth({ resource: e.target.value || undefined })
                }
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => startMutation.mutate(serverKey)}
              disabled={
                startMutation.isPending ||
                !serverValue.auth?.oauth?.clientId ||
                !serverValue.auth?.oauth?.authorizeUrl ||
                !serverValue.auth?.oauth?.tokenUrl
              }
            >
              {startMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plug className="size-4" />
              )}
              {t('config.forms.mcp.oauthConnect')}
            </Button>

            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => revokeMutation.mutate(serverKey)}
              disabled={
                revokeMutation.isPending || !statusQuery.data?.connected
              }
            >
              {revokeMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <KeyRound className="size-4" />
              )}
              {t('config.forms.mcp.oauthRevoke')}
            </Button>

            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => testMutation.mutate(serverKey)}
              disabled={
                testMutation.isPending ||
                !serverValue.url ||
                !serverValue.url.startsWith('http')
              }
            >
              {testMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {t('config.forms.mcp.testButton')}
            </Button>

            <StatusBadge status={statusQuery.data} />
          </div>

          <p className="text-muted-foreground text-xs">
            {t('config.forms.mcp.oauthHint')}
          </p>
        </div>
      )}

      {authMode === 'none' && (
        <div className="mt-4 flex items-start gap-2 rounded-lg bg-muted/40 p-3 text-muted-foreground text-xs">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{t('config.forms.mcp.noAuthHint')}</span>
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <Button
          type="button"
          variant="outline"
          onClick={() => onRemove(serverKey)}
        >
          <Trash2 className="size-4" />
          {t('config.forms.mcp.removeServer')}
        </Button>
      </div>
    </div>
  );
}

export function McpForm() {
  const { issues, value, updateValue } = useConfigSection('mcp');
  const { t } = useI18n();
  const servers = (value ?? {}) as MCPRemoteServersConfig;
  const entries = Object.entries(servers);
  const [serverRowIds, setServerRowIds] = useState<Record<string, string>>({});

  useEffect(() => {
    setServerRowIds((current) => {
      const next: Record<string, string> = {};

      for (const [serverKey] of entries) {
        next[serverKey] = current[serverKey] ?? createStableId('server');
      }

      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);
      const unchanged =
        currentKeys.length === nextKeys.length &&
        nextKeys.every((key) => current[key] === next[key]);

      return unchanged ? current : next;
    });
  }, [entries]);

  function handleRemove(key: string) {
    const nextServers = { ...servers };
    delete nextServers[key];
    updateValue(nextServers);
  }

  function handleRename(oldKey: string, newKey: string, rowId: string) {
    setServerRowIds((current) => {
      const next = { ...current };
      delete next[oldKey];
      next[newKey] = rowId;
      return next;
    });

    const nextServers = { ...servers };
    nextServers[newKey] = nextServers[oldKey];
    delete nextServers[oldKey];
    updateValue(nextServers);
  }

  return (
    <div className="space-y-6">
      <SectionIssues issues={issues} />

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">
            {t('config.forms.mcp.builtinServers')}
          </CardTitle>
          <CardDescription>
            {t('config.forms.mcp.builtinDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {builtinServers.map((server) => (
            <div key={server.name} className="rounded-2xl border p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-medium">{server.name}</h3>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary text-xs">
                  {t('config.common.enabled')}
                </span>
              </div>
              <p className="mt-2 text-muted-foreground text-sm">
                {server.description}
              </p>
              <p className="mt-3 text-muted-foreground text-xs">
                {t('config.forms.mcp.tools', { tools: server.tools })}
              </p>
              <p className="mt-1 text-muted-foreground text-xs">
                {server.requirements}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">
            {t('config.forms.mcp.customServers')}
          </CardTitle>
          <CardDescription>
            {t('config.forms.mcp.customDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {entries.map(([serverKey, serverValue]) => (
            <ServerRow
              key={serverRowIds[serverKey] ?? serverKey}
              serverKey={serverKey}
              serverValue={serverValue}
              rowId={serverRowIds[serverKey] ?? createStableId('server')}
              servers={servers}
              updateValue={updateValue}
              onRemove={handleRemove}
              onRename={handleRename}
            />
          ))}

          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              updateValue({
                ...servers,
                [`server-${entries.length + 1}`]: {
                  type: 'http',
                  url: '',
                  auth: defaultAuth(),
                },
              })
            }
          >
            <Plus className="size-4" />
            {t('config.forms.mcp.addServer')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
