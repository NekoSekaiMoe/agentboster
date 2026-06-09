'use client';

import { MessageSquareText, Send, Sparkles } from 'lucide-react';

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
import { SectionIssues } from './shared';

const DEFAULT_CHAT_CONFIG: ChatConfig = {
  enter_to_send: true,
  follow_up_enabled: false,
};

export function ChatForm() {
  const { issues, value, updateValue } = useConfigSection('chat');
  const { draft } = useConfigContext();
  const { t } = useI18n();
  const legacyAgentdConfig = (draft.agentd ?? {}) as Partial<AgentdConfig>;
  const chatConfig: ChatConfig = {
    ...DEFAULT_CHAT_CONFIG,
    follow_up_enabled:
      value?.follow_up_enabled ??
      legacyAgentdConfig.follow_up_enabled ??
      DEFAULT_CHAT_CONFIG.follow_up_enabled,
    ...value,
  };

  function updateChatConfig(patch: Partial<ChatConfig>) {
    updateValue((current) => ({
      ...DEFAULT_CHAT_CONFIG,
      follow_up_enabled:
        current?.follow_up_enabled ??
        legacyAgentdConfig.follow_up_enabled ??
        DEFAULT_CHAT_CONFIG.follow_up_enabled,
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
              checked={chatConfig.enter_to_send}
              onCheckedChange={(checked) =>
                updateChatConfig({ enter_to_send: Boolean(checked) })
              }
            />
            <span className="space-y-1">
              <span className="flex items-center gap-2 font-medium text-sm">
                <Send className="size-4" />
                {t('config.forms.chat.enterToSendLabel')}
              </span>
              <span className="block text-muted-foreground text-xs">
                {chatConfig.enter_to_send
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
              checked={chatConfig.follow_up_enabled}
              onCheckedChange={(checked) =>
                updateChatConfig({ follow_up_enabled: Boolean(checked) })
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
    </div>
  );
}
