import { NextRequest, NextResponse } from 'next/server';
import { readAuthSessionFromCookies } from '@/lib/auth';
import { cookies } from 'next/headers';
import { createBotAdapters } from '@/lib/bot/adaptor';
import { getConfig } from '@/lib/core/kv/config';
import type { AdapterName } from '@/types/config/channels';

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
    const adapterInstance = adapters[adapter];

    if (!adapterInstance) {
      return NextResponse.json({
        ok: false,
        error: `Adapter ${adapter} could not be initialized. Check your configuration.`,
      });
    }

    // Try to call a lightweight API method on the adapter
    let testResult: { ok: boolean; detail?: string; error?: string };

    switch (adapter) {
      case 'telegram': {
        // Telegram: call getMe to verify bot token
        try {
          const token = (adapterConfig as Record<string, string>).bot_token;
          if (!token) {
            testResult = { ok: false, error: 'bot_token is missing' };
            break;
          }
          const resp = await fetch(
            `https://api.telegram.org/bot${token}/getMe`,
          );
          const data = await resp.json();
          if (data.ok) {
            testResult = {
              ok: true,
              detail: `Connected as @${data.result?.username || 'unknown'}`,
            };
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
          const token = (adapterConfig as Record<string, string>).bot_token;
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
          const creds = (adapterConfig as Record<string, string>)
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
          testResult = { ok: false, error: 'credentials_json is not valid JSON' };
        }
        break;
      }

      case 'teams': {
        // Teams: verify credentials exist (no simple test API without Azure auth flow)
        const appId = (adapterConfig as Record<string, string>).app_id;
        const appPassword = (adapterConfig as Record<string, string>)
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
