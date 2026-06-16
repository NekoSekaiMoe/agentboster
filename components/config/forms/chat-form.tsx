'use client';

import { MessageSquareText, Send, Sparkles, Volume2 } from 'lucide-react';

import { useI18n } from '@/components/i18n-provider';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useConfigContext } from '@/components/config/config-provider';
import { useConfigSection } from '@/hooks/use-config-section';
import type { AgentdConfig } from '@/types/config/agentd';
import type { ChatConfig } from '@/types/config/chat';
import { useEffect, useState } from 'react';
import { SectionIssues } from './shared';

const DEFAULT_CHAT_CONFIG: ChatConfig = {
  enter_to_send: true,
  follow_up_enabled: false,
  tts_autoplay: false,
};

export function ChatForm() {
  const { issues, value, updateValue } = useConfigSection('chat');
  const { draft, isAdmin } = useConfigContext();
  const { t } = useI18n();
  const legacyAgentdConfig = (draft.agentd ?? {}) as Partial<AgentdConfig>;

  // enter_to_send is a per-user preference stored in localStorage.
  const [enterToSend, setEnterToSend] = useState(true);
  const [ttsAutoplay, setTtsAutoplay] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('chat:enter_to_send');
      if (stored !== null) {
        setEnterToSend(stored === 'true');
      } else if (value?.enter_to_send !== undefined) {
        setEnterToSend(value.enter_to_send);
      }
      const ttsStored = window.localStorage.getItem('chat:tts_autoplay');
      if (ttsStored !== null) {
        setTtsAutoplay(ttsStored === 'true');
      } else if (value?.tts_autoplay !== undefined) {
        setTtsAutoplay(Boolean(value.tts_autoplay));
      }
    } catch {
      // localStorage unavailable, use default
    }
  }, [value?.enter_to_send, value?.tts_autoplay]);

  function updateEnterToSend(checked: boolean) {
    setEnterToSend(checked);
    try {
      window.localStorage.setItem('chat:enter_to_send', String(checked));
    } catch {
      // ignore
    }
  }

  function updateTtsAutoplay(checked: boolean) {
    setTtsAutoplay(checked);
    try {
      window.localStorage.setItem('chat:tts_autoplay', String(checked));
    } catch {
      // ignore
    }
  }

  const followUpEnabled =
    value?.follow_up_enabled ??
    legacyAgentdConfig.follow_up_enabled ??
    DEFAULT_CHAT_CONFIG.follow_up_enabled;

  function updateFollowUp(patch: Partial<ChatConfig>) {
    updateValue((current) => ({
      ...DEFAULT_CHAT_CONFIG,
      ...current,
      ...patch,
    }));
  }

  return (
    <div className="space-y-6">
      <SectionIssues issues={issues} />

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquareText className="size-4" />
            {t('config.forms.chat.composerTitle')}
          </CardTitle>
          <CardDescription>
            {t('config.forms.chat.composerDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label
            htmlFor="chat-enter-to-send"
            className="flex items-start gap-3 rounded-md border p-4"
          >
            <Checkbox
              id="chat-enter-to-send"
              checked={enterToSend}
              onCheckedChange={(checked) => updateEnterToSend(Boolean(checked))}
            />
            <span className="space-y-1">
              <span className="flex items-center gap-2 font-medium text-sm">
                <Send className="size-4" />
                {t('config.forms.chat.enterToSendLabel')}
              </span>
              <span className="block text-muted-foreground text-xs">
                {enterToSend
                  ? t('config.forms.chat.enterToSendOnHelp')
                  : t('config.forms.chat.enterToSendOffHelp')}
              </span>
            </span>
          </label>

          <div className="rounded-md border bg-muted/30 p-4">
            <Label className="text-sm">
              {t('config.forms.chat.shortcutsTitle')}
            </Label>
            <div className="mt-2 grid gap-2 text-muted-foreground text-xs md:grid-cols-2">
              <div>{t('config.forms.chat.shortcutsOn')}</div>
              <div>{t('config.forms.chat.shortcutsOff')}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Volume2 className="size-4" />
            Text-to-Speech
          </CardTitle>
          <CardDescription>
            Auto-play the latest assistant reply as audio in the Web chat.
            Requires an admin to enable TTS globally and configure an
            OpenAI speech model.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <label
            htmlFor="chat-tts-autoplay"
            className="flex items-start gap-3 rounded-md border p-4"
          >
            <Checkbox
              id="chat-tts-autoplay"
              checked={ttsAutoplay}
              onCheckedChange={(checked) =>
                updateTtsAutoplay(Boolean(checked))
              }
            />
            <span className="space-y-1">
              <span className="block font-medium text-sm">
                Auto-play last reply
              </span>
              <span className="block text-muted-foreground text-xs">
                {ttsAutoplay
                  ? 'On — the most recent assistant message will play automatically when it finishes.'
                  : 'Off — only the play button under each message is available.'}
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      {isAdmin ? (
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4" />
              {t('config.forms.chat.followUpTitle')}
            </CardTitle>
            <CardDescription>
              {t('config.forms.chat.followUpDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <label
              htmlFor="chat-follow-up"
              className="flex items-start gap-3 rounded-md border p-4"
            >
              <Checkbox
                id="chat-follow-up"
                checked={followUpEnabled}
                onCheckedChange={(checked) =>
                  updateFollowUp({ follow_up_enabled: Boolean(checked) })
                }
              />
              <span className="space-y-1">
                <span className="block font-medium text-sm">
                  {t('config.forms.chat.followUpLabel')}
                </span>
                <span className="block text-muted-foreground text-xs">
                  {t('config.forms.chat.followUpHelp')}
                </span>
              </span>
            </label>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
