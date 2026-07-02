import type { AdapterName } from '@/types/config/channels';

export interface BotCapabilities {
  delete: boolean;
  edit: boolean;
  reaction: boolean;
  /** Whether the adapter renders interactive L2 buttons (vs. plain-text prompt). */
  richButton: boolean;
}

const CAPABILITY_MAP: Partial<Record<AdapterName, BotCapabilities>> = {
  telegram: { delete: true, edit: true, reaction: false, richButton: true },
  discord: { delete: true, edit: true, reaction: true, richButton: true },
  slack: { delete: true, edit: true, reaction: true, richButton: true },
  teams: { delete: true, edit: true, reaction: false, richButton: true },
  gchat: { delete: false, edit: false, reaction: false, richButton: true },
  feishu: { delete: true, edit: true, reaction: false, richButton: true },
  qq: { delete: true, edit: true, reaction: false, richButton: false },
  // WeCom application-messaging has no editMessage (would flood via repost)
  // and recall only works for app messages, not smart-bot replies.
  // template_card (text_notice) supports L2 decision buttons; inbound
  // template_card_event routes the click to processL2Decision.
  wecom: { delete: false, edit: false, reaction: false, richButton: true },
  // DingTalk sessionWebhook is one-shot per inbound; OpenAPI send covers
  // richer types. No editMessage for already-sent messages.
  // sampleActionCard supports L2 buttons; inbound click route TBD.
  dingtalk: { delete: false, edit: false, reaction: false, richButton: true },
};

export function getBotCapabilities(adapter: string): BotCapabilities {
  return (
    CAPABILITY_MAP[adapter as AdapterName] ?? {
      delete: false,
      edit: false,
      reaction: false,
      richButton: false,
    }
  );
}
