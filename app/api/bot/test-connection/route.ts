import { readAuthSessionFromCookies } from '@/lib/auth';
import { createBotAdapters } from '@/lib/bot/adaptor';
import { getWebhookCallbackUrl, registerTelegramWebhook } from '@/lib/bot/webhook';
import { getConfig } from '@/lib/core/kv/config';
import type { AdapterName } from '@/types/config/channels';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const session = await readAuthSessionFromCookies(cookieStore);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const adapter = (body.adapter as AdapterName) || 'telegram';

  const config = await getConfig();
  const adapterConfig = config?.channels?.[adapter];

  if (!adapterConfig?.enabled) {
    return NextResponse.json({
      ok: false,
      error: `Adapter ${adapter} is not enabled in configuration`,
    });
  }

  try {
    const adapters = createBotAdapters(config.channels);

    // Try to call a lightweight API method on the adapter
    let testResult: { ok: boolean; detail?: string; error?: string };

    // Feishu and QQ are not Chat SDK adapters, skip adapter instance check
    if (adapter !== 'feishu' && adapter !== 'qq') {
      const adapterInstance = adapters[adapter];
      if (!adapterInstance) {
        return NextResponse.json({
          ok: false,
          error: `Adapter ${adapter} could not be initialized. Check your configuration.`,
        });
      }
    }

    switch (adapter) {
      case 'telegram': {
        // Telegram: call getMe to verify bot token, then register webhook
        try {
          const token = (adapterConfig as unknown as Record<string, string>)
            .bot_token;
          if (!token) {
            testResult = { ok: false, error: 'bot_token is missing' };
            break;
          }
          const resp = await fetch(
            `https://api.telegram.org/bot${token}/getMe`,
          );
          const data = await resp.json();
          if (data.ok) {
            // Register webhook after successful token verification
            const webhookUrl = getWebhookCallbackUrl('telegram');
            if (webhookUrl) {
              const secretToken = (
                adapterConfig as unknown as Record<string, string>
              ).secret_token;
              const webhookResult = await registerTelegramWebhook(
                token,
                webhookUrl,
                secretToken || undefined,
              );
              if (!webhookResult.ok) {
                testResult = {
                  ok: false,
                  error: `Token verified but webhook registration failed: ${webhookResult.error}`,
                };
                break;
              }
              testResult = {
                ok: true,
                detail: `Connected as @${data.result?.username || 'unknown'}, webhook registered: ${webhookUrl}`,
              };
            } else {
              testResult = {
                ok: true,
                detail: `Connected as @${data.result?.username || 'unknown'} (webhook URL not available — check AUTH_SECRET)`,
              };
            }
          } else {
            testResult = {
              ok: false,
              error: data.description || 'Telegram API returned an error',
            };
          }
        } catch (e) {
          testResult = {
            ok: false,
            error: e instanceof Error ? e.message : 'Network error',
          };
        }
        break;
      }

      case 'slack': {
        // Slack: call auth.test to verify bot token
        try {
          const token = (adapterConfig as unknown as Record<string, string>)
            .bot_token;
          if (!token) {
            testResult = { ok: false, error: 'bot_token is missing' };
            break;
          }
          const resp = await fetch('https://slack.com/api/auth.test', {
            headers: { Authorization: `Bearer ${token}` },
          });
          const data = await resp.json();
          if (data.ok) {
            testResult = {
              ok: true,
              detail: `Connected to workspace "${data.team || 'unknown'}" as ${data.user || 'bot'}`,
            };
          } else {
            testResult = {
              ok: false,
              error: data.error || 'Slack API returned an error',
            };
          }
        } catch (e) {
          testResult = {
            ok: false,
            error: e instanceof Error ? e.message : 'Network error',
          };
        }
        break;
      }

      case 'gchat': {
        // Google Chat: verify credentials exist
        try {
          const creds = (adapterConfig as unknown as Record<string, string>)
            .credentials_json;
          if (!creds) {
            testResult = { ok: false, error: 'credentials_json is missing' };
            break;
          }
          const parsed = JSON.parse(creds);
          if (parsed.project_id && parsed.private_key) {
            testResult = {
              ok: true,
              detail: `Service account "${parsed.client_email || 'configured'}" loaded`,
            };
          } else {
            testResult = {
              ok: false,
              error: 'credentials_json missing project_id or private_key',
            };
          }
        } catch {
          testResult = {
            ok: false,
            error: 'credentials_json is not valid JSON',
          };
        }
        break;
      }

      case 'teams': {
        const appId = (adapterConfig as unknown as Record<string, string>)
          .app_id;
        const appPassword = (adapterConfig as unknown as Record<string, string>)
          .app_password;
        if (appId && appPassword) {
          testResult = {
            ok: true,
            detail: `App ID "${appId.substring(0, 8)}..." configured`,
          };
        } else {
          testResult = {
            ok: false,
            error: 'app_id and app_password are both required',
          };
        }
        break;
      }

      case 'discord': {
        // Discord: call /api/v10/users/@me to verify bot token
        try {
          const token = (adapterConfig as unknown as Record<string, string>)
            .bot_token;
          if (!token) {
            testResult = { ok: false, error: 'bot_token is missing' };
            break;
          }
          const resp = await fetch('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: `Bot ${token}` },
          });
          const data = await resp.json();
          if (data.username) {
            testResult = {
              ok: true,
              detail: `Connected as ${data.username}#${data.discriminator || '0'}`,
            };
          } else {
            testResult = {
              ok: false,
              error: data.message || 'Discord API returned an error',
            };
          }
        } catch (e) {
          testResult = {
            ok: false,
            error: e instanceof Error ? e.message : 'Network error',
          };
        }
        break;
      }

      case 'feishu': {
        // Feishu: call tenant_access_token to verify app credentials
        try {
          const appId = (adapterConfig as unknown as Record<string, string>)
            .app_id;
          const appSecret = (adapterConfig as unknown as Record<string, string>)
            .app_secret;
          if (!appId || !appSecret) {
            testResult = {
              ok: false,
              error: 'app_id and app_secret are both required',
            };
            break;
          }
          const domain =
            (adapterConfig as unknown as Record<string, string>).domain ||
            'feishu';
          const base =
            domain === 'lark'
              ? 'https://open.larksuite.com'
              : 'https://open.feishu.cn';
          const resp = await fetch(
            `${base}/open-apis/auth/v3/tenant_access_token/internal`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
            },
          );
          const data = await resp.json();
          if (data.code === 0) {
            testResult = {
              ok: true,
              detail: `Tenant access token obtained (app_id: ${appId.substring(0, 8)}...)`,
            };
          } else {
            testResult = {
              ok: false,
              error: data.msg || 'Feishu API returned an error',
            };
          }
        } catch (e) {
          testResult = {
            ok: false,
            error: e instanceof Error ? e.message : 'Network error',
          };
        }
        break;
      }

      case 'qq': {
        // QQ: verify appid/secret exist (no simple test API without WebSocket)
        const appid = (adapterConfig as unknown as Record<string, string>)
          .appid;
        const secret = (adapterConfig as unknown as Record<string, string>)
          .secret;
        if (appid && secret) {
          testResult = {
            ok: true,
            detail: `App ID ${appid} configured (QQ Bot requires WebSocket for full connection test)`,
          };
        } else {
          testResult = {
            ok: false,
            error: 'appid and secret are both required',
          };
        }
        break;
      }

      default:
        testResult = {
          ok: true,
          detail: 'Adapter initialized (no deep test available)',
        };
    }

    return NextResponse.json({ adapter, ...testResult });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        adapter,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
