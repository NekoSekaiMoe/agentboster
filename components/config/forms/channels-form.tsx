'use client';

import { AlertCircle, Copy } from 'lucide-react';
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
  GChatAdapterConfig,
  SlackAdapterConfig,
  TeamsAdapterConfig,
  TelegramAdapterConfig,
} from '@/types/config/channels';

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

  const adapters: Array<{
    description: string;
    fields: string[];
    key: AdapterName;
    value:
      | GChatAdapterConfig
      | SlackAdapterConfig
      | TeamsAdapterConfig
      | TelegramAdapterConfig
      | undefined;
  }> = [
    {
      key: 'slack',
      description: 'Single workspace token or multi-workspace OAuth setup.',
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
      key: 'teams',
      description: 'Azure Bot registration credentials.',
      value: channels.teams,
      fields: ['app_id', 'app_password'],
    },
    {
      key: 'gchat',
      description: 'Google Chat project and service account credentials.',
      value: channels.gchat,
      fields: ['project_id', 'credentials_json'],
    },
    {
      key: 'telegram',
      description: 'Telegram bot token and webhook secret.',
      value: channels.telegram,
      fields: ['bot_token', 'secret_token', 'bot_username', 'api_base_url'],
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
                {adapter.fields.map((field) => (
                  <Field key={field} label={field}>
                    <Input
                      value={String(adapterValue[field] ?? '')}
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
                  </Field>
                ))}
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
                  Scheduled workflow broadcasts only send to user IDs in this
                  list.
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
                      <div className="flex justify-end">
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
                          Copy webhook URL
                        </Button>
                      </div>
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
