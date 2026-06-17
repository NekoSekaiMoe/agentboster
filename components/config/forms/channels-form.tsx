'use client';

import {
  AlertCircle,
  Check,
  ChevronDown,
  Copy,
  KeyRound,
  Loader2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useState } from 'react';

import {
  loadWebhookConfigAction,
  getImPairStatusAction,
  unpairImAccountAction,
} from '@/app/(config)/actions';
import { toast } from 'sonner';
import { useCopyToClipboard } from 'usehooks-ts';

import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useConfigContextStrict } from '@/components/config/config-provider';
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
  const { isAdmin } = useConfigContextStrict();
  const { t } = useI18n();
  const reduceMotion = useReducedMotion();
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
  const [expandedAdapters, setExpandedAdapters] = useState<
    ReadonlySet<AdapterName>
  >(() => new Set());
  const [pairCode, setPairCode] = useState<
    Record<string, { code: string; expiresIn: number } | null>
  >({});
  const [pairCodeLoading, setPairCodeLoading] = useState<
    Record<string, boolean>
  >({});
  const [pairStatus, setPairStatus] = useState<
    Record<
      string,
      {
        paired: boolean;
        imUserId: string | null;
        imUserName: string | null;
        pairedAt: string | null;
      } | null
    >
  >({});
  const [unpairing, setUnpairing] = useState<Record<string, boolean>>({});
  const collapseTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.18, ease: [0.22, 1, 0.36, 1] };

  function toggleAdapterExpanded(adapter: AdapterName) {
    setExpandedAdapters((current) => {
      const next = new Set(current);
      if (next.has(adapter)) {
        next.delete(adapter);
      } else {
        next.add(adapter);
      }
      return next;
    });
  }

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
        toast.success(t('config.forms.channels.connected', { adapter }));
      } else {
        setTestStates((prev) => ({ ...prev, [adapter]: 'error' }));
        setTestResults((prev) => ({
          ...prev,
          [adapter]: { error: data.error },
        }));
        toast.error(
          `${adapter}: ${
            data.error || t('config.forms.channels.connectionFailed')
          }`,
        );
      }
    } catch (err) {
      setTestStates((prev) => ({ ...prev, [adapter]: 'error' }));
      setTestResults((prev) => ({
        ...prev,
        [adapter]: {
          error:
            err instanceof Error
              ? err.message
              : t('config.common.networkError'),
        },
      }));
      toast.error(`${adapter}: ${t('config.common.networkError')}`);
    }
  }

  async function generatePairCodeForAdapter(adapter: string) {
    setPairCodeLoading((prev) => ({ ...prev, [adapter]: true }));
    setPairCode((prev) => ({ ...prev, [adapter]: null }));
    try {
      const resp = await fetch('/api/pair/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adapter }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || 'Failed to generate pair code');
      }
      setPairCode((prev) => ({
        ...prev,
        [adapter]: { code: data.code, expiresIn: data.expiresIn },
      }));
      toast.success(
        `Pair code generated for ${adapter}. Expires in ${Math.floor(data.expiresIn / 60)} min.`,
      );

      // Poll pair status until paired or code expires.
      const pollInterval = setInterval(async () => {
        const status = await loadPairStatus(adapter);
        if (status?.paired) {
          clearInterval(pollInterval);
          setPairCode((prev) => ({ ...prev, [adapter]: null }));
          toast.success(`Paired successfully with ${adapter}!`);
        }
      }, 3000);
      setTimeout(() => clearInterval(pollInterval), data.expiresIn * 1000);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to generate pair code',
      );
    } finally {
      setPairCodeLoading((prev) => ({ ...prev, [adapter]: false }));
    }
  }

  async function loadPairStatus(adapter: string) {
    try {
      const status = await getImPairStatusAction(adapter as AdapterName);
      setPairStatus((prev) => ({ ...prev, [adapter]: status }));
      return status;
    } catch {
      return null;
    }
  }

  async function handleUnpair(adapter: string) {
    setUnpairing((prev) => ({ ...prev, [adapter]: true }));
    try {
      const result = await unpairImAccountAction(adapter as AdapterName);
      if (result.ok) {
        toast.success(`Unpaired from ${adapter}.`);
        await loadPairStatus(adapter);
      } else {
        toast.error('No active pairing found.');
      }
    } catch {
      toast.error('Failed to unpair.');
    } finally {
      setUnpairing((prev) => ({ ...prev, [adapter]: false }));
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

    if (isAdmin) {
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
    }

    return () => {
      isMounted = false;
    };
  }, [isAdmin]);

  // Every user (admin or not) can pair their own IM account, so the pair
  // status must always be loaded. Previously this only ran in the non-admin
  // branch, which left admin users stuck on "Generate pair code" forever,
  // even after a successful pairing.
  useEffect(() => {
    let isMounted = true;
    adapters.forEach((a) => {
      if (a.value?.enabled) {
        loadPairStatus(a.key).catch(() => {
          // loadPairStatus already swallows errors; this guards against
          // any rejection surfaced after unmount.
          if (!isMounted) return;
        });
      }
    });
    return () => {
      isMounted = false;
    };
  }, []);

  const enabledAdapters = adapters
    .filter((a) => a.value?.enabled)
    .map((a) => a.key);

  // Non-admin view: only show pairing UI for enabled adapters.
  if (!isAdmin) {
    return (
      <div className="space-y-6">
        {enabledAdapters.length === 0 ? (
          <div className="rounded-xl border px-4 py-8 text-center text-muted-foreground text-sm">
            No channels are currently enabled. Ask an administrator to enable a
            channel first.
          </div>
        ) : (
          enabledAdapters.map((adapterKey) => {
            const status = pairStatus[adapterKey];
            return (
              <Card key={adapterKey} className="shadow-none">
                <CardContent className="space-y-4 py-4">
                  <div>
                    <span className="block font-semibold text-base capitalize">
                      {adapterKey}
                    </span>
                  </div>

                  {status?.paired ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-green-800 text-sm">
                        <Check className="size-4 shrink-0" />
                        <span>
                          Paired as{' '}
                          <strong>
                            {status.imUserName || status.imUserId}
                          </strong>
                        </span>
                      </div>
                      {status.pairedAt && (
                        <p className="text-muted-foreground text-xs">
                          Paired at {new Date(status.pairedAt).toLocaleString()}
                        </p>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={unpairing[adapterKey]}
                        onClick={() => handleUnpair(adapterKey)}
                      >
                        {unpairing[adapterKey] ? (
                          <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                        ) : null}
                        Unpair
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-muted-foreground text-sm">
                        Your IM account is not paired yet. Generate a code and
                        send it to the bot.
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={pairCodeLoading[adapterKey]}
                          onClick={() => generatePairCodeForAdapter(adapterKey)}
                        >
                          {pairCodeLoading[adapterKey] ? (
                            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                          ) : (
                            <KeyRound className="mr-1.5 size-3.5" />
                          )}
                          Generate pair code
                        </Button>
                        {pairCode[adapterKey] ? (
                          <div className="flex items-center gap-2">
                            <code className="rounded bg-muted px-2 py-1 font-mono text-lg font-bold tracking-widest">
                              {pairCode[adapterKey]?.code}
                            </code>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                copyToClipboard(
                                  pairCode[adapterKey]?.code ?? '',
                                )
                              }
                            >
                              <Copy className="mr-1 size-3.5" />
                              Copy
                            </Button>
                            <span className="text-muted-foreground text-xs">
                              Expires in{' '}
                              {Math.floor(
                                (pairCode[adapterKey]?.expiresIn ?? 0) / 60,
                              )}{' '}
                              min
                            </span>
                          </div>
                        ) : null}
                      </div>
                      <p className="text-muted-foreground text-xs">
                        Send this code to your IM as{' '}
                        <code>/pair &lt;code&gt;</code> or just send the 6-digit
                        number directly.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionIssues issues={issues} />

      {adapters.map((adapter) => {
        const adapterValue = (adapter.value ?? { enabled: false }) as Record<
          string,
          unknown
        >;

        const isExpanded = expandedAdapters.has(adapter.key);

        return (
          <Card key={adapter.key} className="shadow-none">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-6 py-5 text-left"
              aria-expanded={isExpanded}
              onClick={() => toggleAdapterExpanded(adapter.key)}
            >
              <span className="min-w-0">
                <span className="block font-semibold text-base capitalize">
                  {adapter.key}
                </span>
                <span className="mt-1 block text-muted-foreground text-sm">
                  {adapter.description}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="rounded-full border px-2 py-0.5 text-xs">
                  {adapterValue.enabled ? 'enabled' : 'disabled'}
                </span>
                <ChevronDown
                  className={`size-4 text-muted-foreground transition-transform ${
                    isExpanded ? 'rotate-180' : ''
                  }`}
                />
              </span>
            </button>

            <AnimatePresence initial={false}>
              {isExpanded ? (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={collapseTransition}
                  className="overflow-hidden border-t"
                >
                  <CardContent className="space-y-4 pt-4">
                    <ToggleField
                      checked={Boolean(adapterValue.enabled)}
                      label={t('config.common.enabled')}
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

                    {adapterValue.enabled ? (
                      <div className="rounded-xl border border-dashed p-4 space-y-3">
                        <p className="font-medium text-sm">
                          Text-to-Speech voice replies
                        </p>
                        <p className="text-muted-foreground text-xs">
                          When on, assistant replies to this channel are
                          synthesized to audio and posted as a voice message.
                          Falls back to plain text when the adapter does not
                          support audio upload (Feishu / GChat / QQ) or when TTS
                          synthesis fails.
                        </p>
                        <ToggleField
                          checked={Boolean(adapterValue.tts_enabled)}
                          label={t('form.label.sendVoiceReplies')}
                          onCheckedChange={(checked) =>
                            updateValue({
                              ...channels,
                              [adapter.key]: {
                                ...adapterValue,
                                tts_enabled: checked,
                              },
                            } as AppConfig['channels'])
                          }
                        />
                        <Field label="Voice override (optional)">
                          <Input
                            value={String(adapterValue.tts_voice ?? '')}
                            placeholder={t(
                              'form.placeholder.leaveEmptyGlobalVoice',
                            )}
                            onChange={(event) =>
                              updateValue({
                                ...channels,
                                [adapter.key]: {
                                  ...adapterValue,
                                  tts_voice: event.target.value || undefined,
                                },
                              } as AppConfig['channels'])
                            }
                          />
                        </Field>
                      </div>
                    ) : null}

                    <div className="grid gap-4 md:grid-cols-2">
                      {adapter.fields.map((field) => {
                        const preset = CHANNEL_PRESETS[adapter.key];
                        const fieldInfo = preset?.fields.find(
                          (f) => f.key === field,
                        );
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
                              <p className="mt-1 text-muted-foreground text-xs">
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
                        addLabel={t('config.forms.channels.addAuthorId')}
                        entries={createStringListEntries(
                          adapterValue.allowed_author_ids as
                            | string[]
                            | undefined,
                        )}
                        placeholder={t('config.forms.channels.authorId')}
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
                      <p className="text-muted-foreground text-xs">
                        {t('config.forms.channels.allowHelp')}
                      </p>

                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={pairCodeLoading[adapter.key]}
                          onClick={() =>
                            generatePairCodeForAdapter(adapter.key)
                          }
                        >
                          {pairCodeLoading[adapter.key] ? (
                            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                          ) : (
                            <KeyRound className="mr-1.5 size-3.5" />
                          )}
                          Generate pair code
                        </Button>
                        {pairCode[adapter.key] ? (
                          <div className="flex items-center gap-2">
                            <code className="rounded bg-muted px-2 py-1 font-mono text-lg font-bold tracking-widest">
                              {pairCode[adapter.key]?.code}
                            </code>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                copyToClipboard(
                                  pairCode[adapter.key]?.code ?? '',
                                )
                              }
                            >
                              <Copy className="mr-1 size-3.5" />
                              Copy
                            </Button>
                            <span className="text-muted-foreground text-xs">
                              Expires in{' '}
                              {Math.floor(
                                (pairCode[adapter.key]?.expiresIn ?? 0) / 60,
                              )}{' '}
                              min
                            </span>
                          </div>
                        ) : null}
                      </div>
                      <p className="text-muted-foreground text-xs">
                        Send this code to your IM as{' '}
                        <code>/pair &lt;code&gt;</code> to bind your ClawLess
                        account.
                      </p>
                    </Field>

                    {adapterValue.enabled ? (
                      <div className="space-y-3 rounded-xl border px-4 py-4">
                        <div className="flex items-start gap-3 text-sm">
                          <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                          <div className="space-y-1">
                            <p className="font-medium">
                              {t('config.forms.channels.webhookInstruction')}
                            </p>
                            <p className="text-muted-foreground">
                              {t('config.forms.channels.webhookUsage')}
                            </p>
                            {adapter.key === 'gchat' ? (
                              <p className="text-muted-foreground">
                                {t('config.forms.channels.gchatNote')}
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
                                    toast.error(
                                      t(
                                        'config.forms.channels.webhookUnavailable',
                                      ),
                                    );
                                    return;
                                  }

                                  await copyToClipboard(url);
                                  toast.success(
                                    t('config.forms.channels.webhookCopied'),
                                  );
                                }}
                              >
                                <Copy className="mr-2 size-4" />
                                {t('config.forms.channels.copyUrl')}
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
                                  ? t('config.common.testing')
                                  : testStates[adapter.key] === 'ok'
                                    ? t('config.common.connected')
                                    : testStates[adapter.key] === 'error'
                                      ? t('config.common.retry')
                                      : t(
                                          'config.forms.channels.testConnection',
                                        )}
                              </Button>
                            </div>
                            {testResults[adapter.key]?.detail && (
                              <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-green-800 text-sm">
                                ✓ {testResults[adapter.key].detail}
                              </div>
                            )}
                            {testResults[adapter.key]?.error && (
                              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800 text-sm">
                                ✗ {testResults[adapter.key].error}
                              </div>
                            )}
                          </div>
                        ) : webhookConfigStatus === 'loading' ? (
                          <div className="rounded-lg border px-3 py-2 text-muted-foreground text-sm">
                            {t('config.forms.channels.loadingWebhook')}
                          </div>
                        ) : webhookConfigStatus === 'error' ? (
                          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 text-sm">
                            {t('config.forms.channels.loadWebhookError')}
                          </div>
                        ) : (
                          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 text-sm">
                            {t('config.forms.channels.authSecretMissing')}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </CardContent>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </Card>
        );
      })}
    </div>
  );
}
