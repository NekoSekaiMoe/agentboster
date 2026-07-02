import type { AdapterName } from '@/types/config/channels';

export interface BotCapabilities {
  delete: boolean;
  edit: boolean;
  reaction: boolean;
}

const CAPABILITY_MAP: Partial<Record<AdapterName, BotCapabilities>> = {
  telegram: { delete: true, edit: true, reaction: false },
  discord: { delete: true, edit: true, reaction: true },
  slack: { delete: true, edit: true, reaction: true },
  teams: { delete: true, edit: true, reaction: false },
  gchat: { delete: false, edit: false, reaction: false },
  feishu: { delete: true, edit: true, reaction: false },
  qq: { delete: true, edit: true, reaction: false },
  // WeCom application-messaging has no editMessage (would flood via repost)
  // and recall only works for app messages, not smart-bot replies.
  wecom: { delete: false, edit: false, reaction: false },
  // DingTalk sessionWebhook is one-shot per inbound; OpenAPI send covers
  // richer types. No editMessage for already-sent messages.
  dingtalk: { delete: false, edit: false, reaction: false },
};

export function getBotCapabilities(adapter: string): BotCapabilities {
  return (
    CAPABILITY_MAP[adapter as AdapterName] ?? {
      delete: false,
      edit: false,
      reaction: false,
    }
  );
}
