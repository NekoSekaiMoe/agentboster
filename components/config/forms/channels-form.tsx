'use client';

import { AlertCircle, Check, Copy, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { loadWebhookConfigAction } from '@/app/(config)/actions';
import { toast } from 'sonner';
import { useCopyToClipboard } from 'usehooks-ts';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useConfigSection } from '@/hooks/use-config-section';
import type { AppConfig } from '@/types/config';
import type {
  AdapterName,
  ChannelsConfig,
  DiscordAdapterConfig,
  FeishuAdapterConfig,
  GChatAdapterConfig,
  QQAdapterConfig,
  SlackAdapterConfig,
  TeamsAdapterConfig,
  TelegramAdapterConfig,
} from '@/types/config/channels';

import { CHANNEL_PRESETS } from '@/lib/bot/channel-presets';
import {
  Field,
  SectionIssues,
  StringListEditor,
  ToggleField,
  compactStringList,
  createStringListEntries,
} from './shared';

type WebhookConfigResponse = {
  authSecretConfigured: boolean;
  baseUrl: string;
  urls: Record<AdapterName, string | null>;
};

export function ChannelsForm() {
  const { issues, value, updateValue } = useConfigSection('channels');
  const channels = (value ?? {}) as Partial<ChannelsConfig>;
  const [webhookConfig, setWebhookConfig] =
    useState<WebhookConfigResponse | null>(null);
  const [webhookConfigStatus, setWebhookConfigStatus] = useState<
    'loading' | 'ready' | 'error'
  >('loading');
  const [_, copyToClipboard] = useCopyToClipboard();
  const [testStates, setTestStates] = useState<
    Record<string, 'idle' | 'testing' | 'ok' | 'error'>
  >({});
  const [testResults, setTestResults] = useState<
    Record<string, { detail?: string; error?: string }>
  >({});

  async function testConnection(adapter: string) {
    setTestStates((prev) => ({ ...prev, [adapter]: 'testing' }));
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[adapter];
      return next;
    });
    try {
      const resp = await fetch('/api/bot/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adapter }),
      });
      const data = await resp.json();
      if (data.ok) {
        setTestStates((prev) => ({ ...prev, [adapter]: 'ok' }));
        setTestResults((prev) => ({
          ...prev,
          [adapter]: { detail: data.detail },
        }));
        toast.success(`${adapter}: Connected`);
      } else {
        setTestStates((prev) => ({ ...prev, [adapter]: 'error' }));
        setTestResults((prev) => ({
          ...prev,
          [adapter]: { error: data.error },
        }));
        toast.error(`${adapter}: ${data.error || 'Connection failed'}`);
      }
    } catch (err) {
      setTestStates((prev) => ({ ...prev, [adapter]: 'error' }));
      setTestResults((prev) => ({
        ...prev,
        [adapter]: {
          error: err instanceof Error ? err.message : 'Network error',
        },
      }));
      toast.error(`${adapter}: Network error`);
    }
  }

  const adapters: Array<{
    description: string;
    fields: string[];
    key: AdapterName;
    value:
      | DiscordAdapterConfig
      | FeishuAdapterConfig
      | GChatAdapterConfig
      | QQAdapterConfig
      | SlackAdapterConfig
      | TeamsAdapterConfig
      | TelegramAdapterConfig
      | undefined;
  }> = [
    {
      key: 'telegram',
      description: CHANNEL_PRESETS.telegram.description,
      value: channels.telegram,
      fields: ['bot_token', 'secret_token', 'bot_username', 'api_base_url'],
    },
    {
      key: 'discord',
      description: CHANNEL_PRESETS.discord.description,
      value: channels.discord,
      fields: ['bot_token', 'application_id', 'public_key'],
    },
    {
      key: 'slack',
      description: CHANNEL_PRESETS.slack.description,
      value: channels.slack,
      fields: [
        'bot_token',
        'signing_secret',
        'client_id',
        'client_secret',
        'encryption_key',
      ],
    },
    {
      key: 'gchat',
      description: CHANNEL_PRESETS.gchat.description,
      value: channels.gchat,
      fields: ['project_id', 'credentials_json'],
    },
    {
      key: 'teams',
      description: CHANNEL_PRESETS.teams.description,
      value: channels.teams,
      fields: ['app_id', 'app_password'],
    },
    {
      key: 'feishu',
      description: CHANNEL_PRESETS.feishu.description,
      value: channels.feishu,
      fields: [
        'app_id',
        'app_secret',
        'encrypt_key',
        'verification_token',
        'domain',
      ],
    },
    {
      key: 'qq',
      description: CHANNEL_PRESETS.qq.description,
      value: channels.qq,
      fields: ['appid', 'secret', 'sandbox', 'intents'],
    },
  ];

  useEffect(() => {
    let isMounted = true;

    loadWebhookConfigAction()
      .then((payload) => {
        if (isMounted) {
          setWebhookConfig(payload);
          setWebhookConfigStatus('ready');
        }
      })
      .catch(() => {
        if (isMounted) {
          setWebhookConfig(null);
          setWebhookConfigStatus('error');
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <SectionIssues issues={issues} />

      {adapters.map((adapter) => {
        const adapterValue = (adapter.value ?? { enabled: false }) as Record<
          string,
          unknown
        >;

        return (
          <Card key={adapter.key} className="shadow-none">
            <CardHeader>
              <CardTitle className="text-base capitalize">
                {adapter.key}
              </CardTitle>
              <CardDescription>{adapter.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ToggleField
                checked={Boolean(adapterValue.enabled)}
                label="Enabled"
                onCheckedChange={(checked) =>
                  updateValue({
                    ...channels,
                    [adapter.key]: {
                      ...adapterValue,
                      enabled: checked,
                    },
                  } as AppConfig['channels'])
                }
              />

              <div className="grid gap-4 md:grid-cols-2">
                {adapter.fields.map((field) => {
                  const preset = CHANNEL_PRESETS[adapter.key];
                  const fieldInfo = preset?.fields.find((f) => f.key === field);
                  return (
                    <Field key={field} label={fieldInfo?.label || field}>
                      <Input
                        value={String(adapterValue[field] ?? '')}
                        placeholder={fieldInfo?.placeholder || ''}
                        onChange={(event) =>
                          updateValue({
                            ...channels,
                            [adapter.key]: {
                              ...adapterValue,
                              [field]: event.target.value || undefined,
                            },
                          } as AppConfig['channels'])
                        }
                      />
                      {fieldInfo?.help && (
                        <p className="text-xs text-muted-foreground mt-1">
                          {fieldInfo.help}
                        </p>
                      )}
                    </Field>
                  );
                })}
              </div>

              {/* Allowed whitelist */}
              <Field label="allowed_author_ids">
                <StringListEditor
                  addLabel="Add author ID"
                  entries={createStringListEntries(
                    adapterValue.allowed_author_ids as string[] | undefined,
                  )}
                  placeholder="Author user ID"
                  onChange={(entries) =>
                    updateValue({
                      ...channels,
                      [adapter.key]: {
                        ...adapterValue,
                        allowed_author_ids: compactStringList(entries),
                      },
                    } as AppConfig['channels'])
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Only these user IDs can send messages to the bot. Leave empty
                  to allow everyone.
                </p>
              </Field>

              {adapterValue.enabled ? (
                <div className="space-y-3 rounded-xl border px-4 py-4">
                  <div className="flex items-start gap-3 text-sm">
                    <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                    <div className="space-y-1">
                      <p className="font-medium">
                        Configure this channel webhook with the callback URL
                        below.
                      </p>
                      <p className="text-muted-foreground">
                        Use this exact HTTPS URL in the provider dashboard so
                        Chat SDK can receive inbound events on Vercel Functions.
                      </p>
                      {adapter.key === 'gchat' ? (
                        <p className="text-muted-foreground">
                          Google Chat default webhook delivery mainly covers
                          @mentions. If you need all space messages, configure
                          Workspace Events with Pub/Sub as well.
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {webhookConfig?.authSecretConfigured &&
                  webhookConfig.urls[adapter.key] ? (
                    <div className="space-y-3">
                      <div className="break-all rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs">
                        {webhookConfig.urls[adapter.key]}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          type="button"
                          variant="outline"
                          onClick={async () => {
                            const url = webhookConfig.urls[adapter.key];
                            if (!url) {
                              toast.error('Webhook URL is not available yet.');
                              return;
                            }

                            await copyToClipboard(url);
                            toast.success('Webhook URL copied.');
                          }}
                        >
                          <Copy className="mr-2 size-4" />
                          Copy URL
                        </Button>
                        <Button
                          size="sm"
                          type="button"
                          variant="outline"
                          disabled={testStates[adapter.key] === 'testing'}
                          onClick={() => testConnection(adapter.key)}
                        >
                          {testStates[adapter.key] === 'testing' ? (
                            <Loader2 className="mr-2 size-4 animate-spin" />
                          ) : testStates[adapter.key] === 'ok' ? (
                            <Check className="mr-2 size-4 text-green-600" />
                          ) : testStates[adapter.key] === 'error' ? (
                            <X className="mr-2 size-4 text-red-600" />
                          ) : null}
                          {testStates[adapter.key] === 'testing'
                            ? 'Testing...'
                            : testStates[adapter.key] === 'ok'
                              ? 'Connected'
                              : testStates[adapter.key] === 'error'
                                ? 'Retry'
                                : 'Test connection'}
                        </Button>
                      </div>
                      {testResults[adapter.key]?.detail && (
                        <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
                          ✓ {testResults[adapter.key].detail}
                        </div>
                      )}
                      {testResults[adapter.key]?.error && (
                        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                          ✗ {testResults[adapter.key].error}
                        </div>
                      )}
                    </div>
                  ) : webhookConfigStatus === 'loading' ? (
                    <div className="rounded-lg border px-3 py-2 text-sm text-muted-foreground">
                      Loading webhook configuration...
                    </div>
                  ) : webhookConfigStatus === 'error' ? (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                      Failed to load the webhook URL from the server. Refresh
                      the page and try again.
                    </div>
                  ) : (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                      AUTH_SECRET is not configured on the server yet, so the
                      callback URL cannot be generated.
                    </div>
                  )}
                </div>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
